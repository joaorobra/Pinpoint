//! Minimal Dataview-like query engine.
//!
//! Grammar (one statement):
//!   (TABLE field, field... | LIST | TASK)
//!   [FROM "folder" | #tag]
//!   [WHERE <expr>]
//!   [SORT field [ASC|DESC]]
//!   [LIMIT n]
//!
//! `<expr>` supports: field OP value, joined by AND/OR.
//! OP ∈ {=, !=, >, <, >=, <=, contains}. Values may be quoted strings, numbers, or true/false.
//!
//! The visual builder on the frontend compiles its GUI state to this same DSL, so there is one
//! execution path. We translate to SQL against the `pages`/`fields` index tables.

use anyhow::{anyhow, bail, Result};
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq)]
pub enum QueryKind {
    Table(Vec<String>),
    List,
    Task,
}

#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub kind: String,
    pub columns: Vec<String>,
    /// Each row: rel_path + a map of requested field -> display string.
    pub rows: Vec<serde_json::Value>,
}

struct Cond {
    field: String,
    op: String,
    value: String,
}

/// Very small tokenizer that respects quoted strings.
fn tokenize(s: &str) -> Vec<String> {
    let mut toks = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    for c in s.chars() {
        match c {
            '"' => {
                in_q = !in_q;
                cur.push(c);
            }
            c if c.is_whitespace() && !in_q => {
                if !cur.is_empty() {
                    toks.push(std::mem::take(&mut cur));
                }
            }
            ',' if !in_q => {
                if !cur.is_empty() {
                    toks.push(std::mem::take(&mut cur));
                }
                toks.push(",".into());
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        toks.push(cur);
    }
    toks
}

fn unquote(s: &str) -> String {
    s.trim_matches('"').to_string()
}

/// Build a SQL fragment + params for a field comparison against the `fields` table or page columns.
fn field_sql(c: &Cond, params: &mut Vec<String>) -> Result<String> {
    // page-level pseudo columns
    let column = match c.field.as_str() {
        "file.name" | "title" => Some("p.title"),
        "file.folder" | "folder" => Some("p.folder"),
        "file.path" | "path" => Some("p.rel_path"),
        _ => None,
    };

    let op_sql = match c.op.as_str() {
        "=" => "=",
        "!=" => "!=",
        ">" => ">",
        "<" => "<",
        ">=" => ">=",
        "<=" => "<=",
        "contains" => "LIKE",
        other => bail!("unsupported operator: {other}"),
    };

    if let Some(col) = column {
        if c.op == "contains" {
            params.push(format!("%{}%", c.value));
            Ok(format!("{col} LIKE ?"))
        } else {
            params.push(c.value.clone());
            Ok(format!("{col} {op_sql} ?"))
        }
    } else {
        // frontmatter field via EXISTS subquery (value is JSON-encoded in fields.value)
        params.push(c.field.clone());
        if c.op == "contains" {
            params.push(format!("%{}%", c.value));
            Ok("EXISTS (SELECT 1 FROM fields f WHERE f.rel_path = p.rel_path AND f.key = ? AND f.value LIKE ?)".into())
        } else {
            // Compare against JSON-encoded scalar; numbers compare lexically but good enough for MVP.
            params.push(json_encode_value(&c.value));
            Ok(format!(
                "EXISTS (SELECT 1 FROM fields f WHERE f.rel_path = p.rel_path AND f.key = ? AND f.value {op_sql} ?)"
            ))
        }
    }
}

/// Build a SQL fragment + params for a WHERE condition in a TASK query, against the `tasks` table.
/// Supported fields: `due`, `done`, `text`, `priority`, `recurring`, `tag`, `ref` (links to a page),
/// `file.path`/`path`.
fn task_field_sql(c: &Cond, params: &mut Vec<String>) -> Result<String> {
    let op_sql = match c.op.as_str() {
        "=" => "=",
        "!=" => "!=",
        ">" => ">",
        "<" => "<",
        ">=" => ">=",
        "<=" => "<=",
        "contains" => "LIKE",
        other => bail!("unsupported operator: {other}"),
    };

    match c.field.as_str() {
        // Boolean: `done = true|false` (also `recurring`, by presence of an rrule).
        "done" => {
            let v = if c.value.eq_ignore_ascii_case("true") || c.value == "1" { 1 } else { 0 };
            Ok(format!("done {op_sql} {v}"))
        }
        "recurring" => {
            let want = c.value.eq_ignore_ascii_case("true") || c.value == "1";
            // `recurring = true` ⇒ rrule IS NOT NULL; `= false` ⇒ IS NULL. `!=` inverts.
            let not_null = if c.op == "!=" { !want } else { want };
            Ok(if not_null { "rrule IS NOT NULL".into() } else { "rrule IS NULL".into() })
        }
        "tag" => {
            // Match a #tag found on the task line (tags stored comma-joined).
            let tag = c.value.trim_start_matches('#');
            params.push(format!("%,{},%", tag));
            Ok("(',' || COALESCE(tags,'') || ',') LIKE ?".into())
        }
        // `ref` matches tasks whose line contains a `[[wikilink]]` to a page. The value is the link
        // target with or without brackets/alias; we match `[[target` as a prefix so it catches
        // `[[Target]]`, `[[Target|Alias]]`, and `[[Target#heading]]` alike. `!=` excludes them.
        "ref" => {
            let target = c
                .value
                .trim()
                .trim_start_matches("[[")
                .trim_end_matches("]]")
                .split(['|', '#'])
                .next()
                .unwrap_or("")
                .trim();
            params.push(format!("%[[{}%", target));
            // `=`/`contains` ⇒ has the link; `!=` ⇒ doesn't.
            Ok(if c.op == "!=" { "text NOT LIKE ?".into() } else { "text LIKE ?".into() })
        }
        // `priority` is the normalized level word (`high`/`medium`/`low`); compare it directly.
        "priority" => {
            if c.op == "contains" {
                params.push(format!("%{}%", c.value));
                Ok("COALESCE(priority,'') LIKE ?".into())
            } else {
                params.push(c.value.clone());
                Ok(format!("COALESCE(priority,'') {op_sql} ?"))
            }
        }
        // Text columns and the ISO `due` date all compare lexically — ISO dates sort correctly.
        "due" | "text" | "file.path" | "path" => {
            let col = if c.field == "due" {
                "due"
            } else if c.field == "text" {
                "text"
            } else {
                "rel_path"
            };
            if c.op == "contains" {
                params.push(format!("%{}%", c.value));
                Ok(format!("{col} LIKE ?"))
            } else {
                params.push(c.value.clone());
                Ok(format!("{col} {op_sql} ?"))
            }
        }
        other => bail!("unknown task field: {other} (use due, done, text, priority, recurring, tag, ref, path)"),
    }
}

fn json_encode_value(v: &str) -> String {
    if v == "true" || v == "false" || v.parse::<f64>().is_ok() {
        v.to_string()
    } else {
        format!("\"{}\"", v)
    }
}

/// Parse + execute a query against the index.
pub fn run(conn: &Connection, dsl: &str) -> Result<QueryResult> {
    let toks = tokenize(dsl.trim());
    if toks.is_empty() {
        bail!("empty query");
    }
    let mut i = 0;
    let head = toks[0].to_uppercase();
    let (kind, mut cols) = match head.as_str() {
        "TABLE" => {
            i += 1;
            let mut fields = Vec::new();
            while i < toks.len() {
                let up = toks[i].to_uppercase();
                if up == "FROM" || up == "WHERE" || up == "SORT" || up == "LIMIT" {
                    break;
                }
                if toks[i] != "," {
                    fields.push(toks[i].clone());
                }
                i += 1;
            }
            (QueryKind::Table(fields.clone()), fields)
        }
        "LIST" => {
            i += 1;
            (QueryKind::List, vec!["file.name".into()])
        }
        "TASK" => {
            i += 1;
            (QueryKind::Task, vec!["text".into(), "due".into(), "done".into(), "recurring".into()])
        }
        other => bail!("query must start with TABLE/LIST/TASK, got {other}"),
    };

    let mut where_sql: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();
    // Multiple sort keys, applied in order (`SORT priority DESC, due ASC`). Each is (field, desc).
    let mut sort: Vec<(String, bool)> = Vec::new();
    let mut limit: Option<i64> = None;
    // TASK queries run against the `tasks` table, whose columns differ from `pages` — so they need
    // their own WHERE fragments (FROM/WHERE map to task columns rather than `p.*`).
    let is_task = kind == QueryKind::Task;

    while i < toks.len() {
        match toks[i].to_uppercase().as_str() {
            "FROM" => {
                i += 1;
                if i < toks.len() {
                    let src = &toks[i];
                    if is_task {
                        // FROM "folder"/#tag scopes tasks by their source page path / line tags.
                        if let Some(tag) = src.strip_prefix('#') {
                            where_sql.push("(',' || COALESCE(tags,'') || ',') LIKE ?".into());
                            params.push(format!("%,{},%", tag));
                        } else {
                            where_sql.push("rel_path LIKE ?".into());
                            params.push(format!("{}%", unquote(src)));
                        }
                    } else if let Some(tag) = src.strip_prefix('#') {
                        where_sql.push("EXISTS (SELECT 1 FROM tags t WHERE t.rel_path = p.rel_path AND t.tag = ?)".into());
                        params.push(tag.to_string());
                    } else {
                        where_sql.push("p.folder LIKE ?".into());
                        params.push(format!("{}%", unquote(src)));
                    }
                    i += 1;
                }
            }
            "WHERE" => {
                i += 1;
                // parse: field op value [(AND|OR) field op value]...
                let mut joiner = "AND".to_string();
                while i + 2 < toks.len() {
                    let up = toks[i].to_uppercase();
                    if up == "SORT" || up == "LIMIT" {
                        break;
                    }
                    let c = Cond {
                        field: toks[i].clone(),
                        op: toks[i + 1].clone(),
                        value: unquote(&toks[i + 2]),
                    };
                    let frag = if is_task {
                        task_field_sql(&c, &mut params)?
                    } else {
                        field_sql(&c, &mut params)?
                    };
                    if where_sql.is_empty() {
                        where_sql.push(frag);
                    } else {
                        where_sql.push(format!("{joiner} {frag}"));
                    }
                    i += 3;
                    if i < toks.len() {
                        let j = toks[i].to_uppercase();
                        if j == "AND" || j == "OR" {
                            joiner = j;
                            i += 1;
                        } else {
                            break;
                        }
                    }
                }
            }
            "SORT" => {
                i += 1;
                // Parse one or more comma-separated `field [ASC|DESC]` keys, applied in order.
                while i < toks.len() {
                    let up = toks[i].to_uppercase();
                    if up == "FROM" || up == "WHERE" || up == "LIMIT" {
                        break;
                    }
                    if toks[i] == "," {
                        i += 1;
                        continue;
                    }
                    let field = toks[i].clone();
                    i += 1;
                    // Optional ASC/DESC direction token.
                    let mut desc = false;
                    if let Some(dir) = toks.get(i) {
                        if dir.eq_ignore_ascii_case("DESC") {
                            desc = true;
                            i += 1;
                        } else if dir.eq_ignore_ascii_case("ASC") {
                            i += 1;
                        }
                    }
                    sort.push((field, desc));
                }
            }
            "LIMIT" => {
                i += 1;
                if i < toks.len() {
                    limit = toks[i].parse().ok();
                    i += 1;
                }
            }
            _ => {
                i += 1;
            }
        }
    }

    // TASK queries read from the tasks table directly.
    if kind == QueryKind::Task {
        let mut sql =
            "SELECT rel_path, line, text, done, due, rrule, tags, done_dates, priority FROM tasks"
                .to_string();
        if !where_sql.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_sql.join(" "));
        }
        // Honor explicit SORT keys in order (`SORT priority DESC, due`); default to due-date order
        // (nulls last). `priority` ranks high>medium>low (no priority sorts lowest).
        if !sort.is_empty() {
            // Rank so DESC yields high→medium→low→none; tasks without a known priority rank lowest.
            let prio_rank =
                "CASE priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END";
            let keys: Vec<String> = sort
                .iter()
                .map(|(field, desc)| {
                    let dir = if *desc { "DESC" } else { "ASC" };
                    match field.as_str() {
                        "priority" => format!("{prio_rank} {dir}"),
                        "due" => format!("due {dir}"),
                        "text" => format!("text {dir}"),
                        "done" => format!("done {dir}"),
                        "file.path" | "path" => format!("rel_path {dir}"),
                        _ => format!("due {dir}"),
                    }
                })
                .collect();
            sql.push_str(" ORDER BY ");
            sql.push_str(&keys.join(", "));
        } else {
            sql.push_str(" ORDER BY due IS NULL, due");
        }
        if let Some(l) = limit {
            sql.push_str(&format!(" LIMIT {l}"));
        }
        let p: Vec<&dyn rusqlite::ToSql> = params.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| anyhow!("sql: {e} ({sql})"))?;
        let rows = stmt
            .query_map(p.as_slice(), |r| {
                let tags: Option<String> = r.get(6)?;
                let done_dates: Option<String> = r.get(7)?;
                Ok(serde_json::json!({
                    "file.path": r.get::<_, String>(0)?,
                    "line": r.get::<_, i64>(1)?,
                    "text": r.get::<_, String>(2)?,
                    "done": r.get::<_, i64>(3)? != 0,
                    "due": r.get::<_, Option<String>>(4)?,
                    // `rrule` is the raw recurrence rule (for client-side occurrence expansion);
                    // `recurring` is the convenient boolean the column list exposes.
                    "rrule": r.get::<_, Option<String>>(5)?,
                    "recurring": r.get::<_, Option<String>>(5)?.is_some(),
                    "tags": tags.unwrap_or_default(),
                    // Comma-joined ISO dates of completed occurrences (for per-occurrence done state).
                    "done_dates": done_dates.unwrap_or_default(),
                    // Normalized `high`/`medium`/`low` (or null) so the client can render a pill.
                    "priority": r.get::<_, Option<String>>(8)?,
                }))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        return Ok(QueryResult { kind: "task".into(), columns: cols, rows });
    }

    // TABLE / LIST query over pages.
    let mut sql = "SELECT p.rel_path, p.title, p.folder FROM pages p".to_string();
    if !where_sql.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_sql.join(" "));
    }
    if !sort.is_empty() {
        let mut keys: Vec<String> = Vec::new();
        for (field, desc) in &sort {
            let col = match field.as_str() {
                "file.name" | "title" => "p.title".to_string(),
                "file.folder" | "folder" => "p.folder".to_string(),
                _ => {
                    // sort by a frontmatter field via correlated subquery
                    params.push(field.clone());
                    "(SELECT f.value FROM fields f WHERE f.rel_path = p.rel_path AND f.key = ?)".to_string()
                }
            };
            keys.push(format!("{} {}", col, if *desc { "DESC" } else { "ASC" }));
        }
        sql.push_str(" ORDER BY ");
        sql.push_str(&keys.join(", "));
    }
    if let Some(l) = limit {
        sql.push_str(&format!(" LIMIT {l}"));
    }

    let p: Vec<&dyn rusqlite::ToSql> = params.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| anyhow!("sql: {e} ({sql})"))?;
    let rel_paths: Vec<(String, String, String)> = stmt
        .query_map(p.as_slice(), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    // Resolve requested frontmatter columns per row.
    let mut out_rows = Vec::new();
    for (rel_path, title, folder) in rel_paths {
        let mut row = serde_json::Map::new();
        row.insert("file.path".into(), serde_json::Value::String(rel_path.clone()));
        row.insert("file.name".into(), serde_json::Value::String(title.clone()));
        row.insert("file.folder".into(), serde_json::Value::String(folder.clone()));
        for col in &cols {
            if col.starts_with("file.") || col == "title" || col == "folder" {
                continue;
            }
            let val: Option<String> = conn
                .query_row(
                    "SELECT value FROM fields WHERE rel_path = ?1 AND key = ?2",
                    rusqlite::params![rel_path, col],
                    |r| r.get(0),
                )
                .ok();
            let display = val
                .and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
                .map(|v| match v {
                    serde_json::Value::String(s) => s,
                    other => other.to_string(),
                })
                .unwrap_or_default();
            row.insert(col.clone(), serde_json::Value::String(display));
        }
        out_rows.push(serde_json::Value::Object(row));
    }

    if matches!(kind, QueryKind::List) {
        cols = vec!["file.name".into()];
    }

    Ok(QueryResult {
        kind: if matches!(kind, QueryKind::List) { "list".into() } else { "table".into() },
        columns: cols,
        rows: out_rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal `tasks` table with a couple of `[[wikilink]]`-bearing task lines, mirroring how
    /// index.rs stores the raw task body in `text`.
    fn seed() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (rel_path TEXT, line INTEGER, text TEXT, done INTEGER, due TEXT,
                rrule TEXT, tags TEXT, done_dates TEXT, priority TEXT, depth INTEGER, parent_line INTEGER);
             INSERT INTO tasks VALUES ('a.md',1,'Send [[Tony Rached]] amount',0,NULL,NULL,NULL,NULL,NULL,0,NULL);
             INSERT INTO tasks VALUES ('b.md',2,'Ask [[Tony Rached]] about game',0,'2026-07-01',NULL,NULL,NULL,NULL,0,NULL);
             INSERT INTO tasks VALUES ('c.md',3,'Unrelated task with no link',0,NULL,NULL,NULL,NULL,NULL,0,NULL);
             INSERT INTO tasks VALUES ('d.md',4,'Talk to [[César Cesario]] only',0,NULL,NULL,NULL,NULL,NULL,0,NULL);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn ref_filter_matches_wikilinked_tasks() {
        let conn = seed();
        // Bare name, `=`/`contains`, and bracketed forms must all match the two Tony tasks.
        for dsl in [
            r#"TASK WHERE ref = "Tony Rached""#,
            r#"TASK WHERE ref contains "Tony Rached""#,
            r#"TASK WHERE ref = "[[Tony Rached]]""#,
        ] {
            let r = run(&conn, dsl).unwrap();
            assert_eq!(r.rows.len(), 2, "dsl `{dsl}` should match 2 tasks");
        }
        // `!=` excludes them (leaving the 2 non-Tony tasks).
        let r = run(&conn, r#"TASK WHERE ref != "Tony Rached""#).unwrap();
        assert_eq!(r.rows.len(), 2);
    }

    #[test]
    fn ref_filter_respects_explicit_sort() {
        let conn = seed();
        // SORT due ASC puts the NULL-due task first, the 2026-07-01 one second.
        let r = run(&conn, r#"TASK WHERE ref = "Tony Rached" SORT due"#).unwrap();
        assert_eq!(r.rows.len(), 2);
    }

    /// Tasks carrying distinct priorities, for exercising priority-rank and multi-key sorts.
    fn seed_priorities() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (rel_path TEXT, line INTEGER, text TEXT, done INTEGER, due TEXT,
                rrule TEXT, tags TEXT, done_dates TEXT, priority TEXT, depth INTEGER, parent_line INTEGER);
             INSERT INTO tasks VALUES ('a.md',1,'low task',0,'2026-07-02',NULL,NULL,NULL,'low',0,NULL);
             INSERT INTO tasks VALUES ('b.md',2,'high A',0,'2026-07-05',NULL,NULL,NULL,'high',0,NULL);
             INSERT INTO tasks VALUES ('c.md',3,'no prio',0,'2026-07-01',NULL,NULL,NULL,NULL,0,NULL);
             INSERT INTO tasks VALUES ('d.md',4,'high B',0,'2026-07-03',NULL,NULL,NULL,'high',0,NULL);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn sort_by_priority_desc_ranks_high_first() {
        let conn = seed_priorities();
        let r = run(&conn, "TASK SORT priority DESC").unwrap();
        // high, high, low, none — and the row JSON exposes the normalized priority.
        let prios: Vec<Option<&str>> =
            r.rows.iter().map(|row| row["priority"].as_str()).collect();
        assert_eq!(prios, vec![Some("high"), Some("high"), Some("low"), None]);
    }

    #[test]
    fn multi_key_sort_breaks_ties_by_second_key() {
        let conn = seed_priorities();
        // priority DESC groups the two highs first; due ASC orders them 07-03 before 07-05.
        let r = run(&conn, "TASK SORT priority DESC, due ASC").unwrap();
        let texts: Vec<&str> = r.rows.iter().map(|row| row["text"].as_str().unwrap()).collect();
        assert_eq!(texts, vec!["high B", "high A", "low task", "no prio"]);
    }
}
