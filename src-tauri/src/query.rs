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
/// Supported fields: `due`, `done`, `text`, `recurring`, `tag`, `file.path`/`path`.
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
        other => bail!("unknown task field: {other} (use due, done, text, recurring, tag, path)"),
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
    let mut sort: Option<(String, bool)> = None;
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
                if i < toks.len() {
                    let field = toks[i].clone();
                    let desc = toks.get(i + 1).map(|d| d.eq_ignore_ascii_case("DESC")).unwrap_or(false);
                    sort = Some((field, desc));
                    i += if desc || toks.get(i + 1).map(|d| d.eq_ignore_ascii_case("ASC")).unwrap_or(false) { 2 } else { 1 };
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
            "SELECT rel_path, line, text, done, due, rrule, tags, done_dates FROM tasks".to_string();
        if !where_sql.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_sql.join(" "));
        }
        // Honor an explicit SORT on a task column; default to due-date order (nulls last).
        if let Some((field, desc)) = &sort {
            let col = match field.as_str() {
                "due" => "due",
                "text" => "text",
                "done" => "done",
                "file.path" | "path" => "rel_path",
                _ => "due",
            };
            sql.push_str(&format!(" ORDER BY {} {}", col, if *desc { "DESC" } else { "ASC" }));
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
    if let Some((field, desc)) = &sort {
        let col = match field.as_str() {
            "file.name" | "title" => "p.title".to_string(),
            "file.folder" | "folder" => "p.folder".to_string(),
            _ => {
                // sort by a frontmatter field via correlated subquery
                params.push(field.clone());
                "(SELECT f.value FROM fields f WHERE f.rel_path = p.rel_path AND f.key = ?)".to_string()
            }
        };
        sql.push_str(&format!(" ORDER BY {} {}", col, if *desc { "DESC" } else { "ASC" }));
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
