//! SQLite index — a rebuildable cache over the vault's `.md` files.
//!
//! The index is never the source of truth. It can be wiped and rebuilt from disk at any time.
//! It powers fast queries (Dataview-style) over pages, frontmatter fields, tags, links and tasks.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;

use crate::vault;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS pages (
    rel_path   TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    folder     TEXT NOT NULL,
    mtime      INTEGER NOT NULL,
    body       TEXT NOT NULL,
    frontmatter TEXT NOT NULL  -- JSON object
);
CREATE TABLE IF NOT EXISTS fields (
    rel_path TEXT NOT NULL,
    key      TEXT NOT NULL,
    value    TEXT,             -- JSON-encoded scalar/array
    PRIMARY KEY (rel_path, key)
);
CREATE TABLE IF NOT EXISTS tags (
    rel_path TEXT NOT NULL,
    tag      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
    src TEXT NOT NULL,
    dst TEXT NOT NULL          -- target page name (wikilink) or path
);
CREATE TABLE IF NOT EXISTS tasks (
    rel_path   TEXT NOT NULL,
    line       INTEGER NOT NULL,
    text       TEXT NOT NULL,
    done       INTEGER NOT NULL,
    due        TEXT,            -- ISO date if present (📅 / due::)
    rrule      TEXT,            -- recurrence rule if present (🔁 / repeat::)
    tags       TEXT,            -- comma-joined #tags found on the line
    done_dates TEXT,            -- comma-joined ISO dates of completed occurrences (✅ … list)
    PRIMARY KEY (rel_path, line)
);
CREATE INDEX IF NOT EXISTS idx_fields_key ON fields(key);
CREATE INDEX IF NOT EXISTS idx_tags_tag   ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_pages_folder ON pages(folder);
"#;

/// Open (or create) the index DB inside `.pinpoint/index.sqlite`.
pub fn open(vault_root: &Path) -> Result<Connection> {
    let dir = vault_root.join(".pinpoint");
    std::fs::create_dir_all(&dir).ok();
    let conn = Connection::open(dir.join("index.sqlite")).context("open index db")?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub rel_path: String,
    pub title: String,
    /// Short window of body text around the first match (or empty for a title-only hit).
    pub snippet: String,
    /// 0-based body line the snippet came from, or null when only the title matched.
    pub line: Option<i64>,
}

/// Full-text search over page titles + bodies for the command palette.
///
/// The index already stores every page's full `body`, so we scan it here rather than re-reading
/// files. Matching is case-insensitive substring (each whitespace-separated term must appear
/// somewhere in title or body — AND semantics), which is forgiving enough for a "find inside my
/// notes" box without needing SQLite FTS. For each page we surface the first body line containing
/// a term as a trimmed snippet. Results are capped at `limit`.
pub fn search_pages(conn: &Connection, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| t.to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt = conn.prepare("SELECT rel_path, title, body FROM pages")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;

    let mut hits = Vec::new();
    for row in rows {
        let (rel_path, title, body) = row?;
        let title_lc = title.to_lowercase();
        let body_lc = body.to_lowercase();
        // Every term must appear somewhere in the page (title or body).
        if !terms.iter().all(|t| title_lc.contains(t) || body_lc.contains(t)) {
            continue;
        }
        let (snippet, line) = body_snippet(&body, &body_lc, &terms);
        hits.push(SearchHit { rel_path, title, snippet, line });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

/// Find the first body line containing any term and return a trimmed snippet of it plus its
/// 0-based line index. Returns ("", None) when no term is in the body (title-only match).
fn body_snippet(body: &str, body_lc: &str, terms: &[String]) -> (String, Option<i64>) {
    // Locate the earliest match position across all terms in the lowercased body.
    let first = terms.iter().filter_map(|t| body_lc.find(t.as_str())).min();
    let Some(pos) = first else {
        return (String::new(), None);
    };
    // Map the byte offset to a line index + that line's text.
    let line_start = body[..pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_end = body[pos..].find('\n').map(|i| pos + i).unwrap_or(body.len());
    let line_no = body[..pos].matches('\n').count() as i64;
    let snippet = body[line_start..line_end].trim();
    // Keep snippets short so a long paragraph doesn't blow up the palette row.
    const MAX: usize = 160;
    let snippet = if snippet.chars().count() > MAX {
        let truncated: String = snippet.chars().take(MAX).collect();
        format!("{}…", truncated.trim_end())
    } else {
        snippet.to_string()
    };
    (snippet, Some(line_no))
}

#[derive(Debug, Serialize)]
pub struct TaskRow {
    pub rel_path: String,
    pub line: i64,
    pub text: String,
    pub done: bool,
    pub due: Option<String>,
    pub rrule: Option<String>,
    pub tags: Option<String>,
    /// Comma-joined ISO dates of completed occurrences (the `✅ …` list). Empty when none.
    pub done_dates: Option<String>,
}

/// Extract `#tags` from a line of text.
fn extract_tags(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' && (i == 0 || bytes[i - 1].is_ascii_whitespace()) {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-' || bytes[j] == b'_' || bytes[j] == b'/')
            {
                j += 1;
            }
            if j > start {
                out.push(text[start..j].to_string());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// Extract `[[wikilinks]]` targets from text.
fn extract_wikilinks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        if let Some(end) = rest[start + 2..].find("]]") {
            let inner = &rest[start + 2..start + 2 + end];
            // [[Target|Alias]] or [[Target#heading]] -> Target
            let target = inner.split(['|', '#']).next().unwrap_or(inner).trim();
            if !target.is_empty() {
                out.push(target.to_string());
            }
            rest = &rest[start + 2 + end + 2..];
        } else {
            break;
        }
    }
    out
}

/// Parse a single line for task syntax.
/// Returns Some((done, text, due, rrule, done_dates)) if it's a task, where `done_dates` is the
/// comma-joined ISO list of completed occurrences from the `✅ …` marker.
fn parse_task_line(
    line: &str,
) -> Option<(bool, String, Option<String>, Option<String>, Option<String>)> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* "))?;
    let rest = rest.strip_prefix("[")?;
    let (mark, after) = rest.split_at(1);
    // Require `]` but allow the space after it (and the body) to be empty, so `- [ ]` and
    // `- [x]done` parse. Mirrors `TASK_RE` in fsa-vault.ts and `toggle_task_line` below.
    let after = after.strip_prefix("]")?;
    let after = after.strip_prefix(' ').unwrap_or(after);
    let done = mark.eq_ignore_ascii_case("x");

    // Inline fields: `📅 2026-06-21`, `due:: 2026-06-21`, `🔁 every week`, `repeat:: FREQ=WEEKLY`.
    // Keep only the leading `YYYY-MM-DD` of the due value so a fused marker (`📅 2026-06-21🔁…`,
    // no space) or trailing text can't poison the stored date.
    let due = find_field(after, &["📅", "due::"]).and_then(|s| {
        let token = s.split_whitespace().next().unwrap_or("");
        let ymd: String = token.chars().take(10).collect();
        if ymd.len() == 10 && ymd.as_bytes()[4] == b'-' && ymd.as_bytes()[7] == b'-' {
            Some(ymd)
        } else if token.is_empty() {
            None
        } else {
            Some(token.to_string())
        }
    });
    let rrule = find_field(after, &["🔁", "repeat::"]);
    // `✅ 2026-06-22,2026-07-06` — completed-occurrence dates. The value runs to end-of-line, so we
    // strip spaces and keep only the comma-separated ISO dates.
    let done_dates = find_field(after, &["✅"]).map(|s| {
        s.split(',')
            .map(|d| d.trim())
            .filter(|d| !d.is_empty())
            .collect::<Vec<_>>()
            .join(",")
    });

    Some((done, after.to_string(), due, rrule, done_dates))
}

/// Rewrite a task line to reflect a toggle.
///
/// - `occurrence == None` (plain task): flip the checkbox mark `[ ]` ⇄ `[x]`.
/// - `occurrence == Some(date)` (a specific occurrence of a recurring task): leave the checkbox
///   alone and add/remove `date` from the trailing `✅ <iso>,<iso>` completed-dates list.
///
/// Returns the new line text, or `None` if `line` isn't a task line. Indentation and all other
/// inline markers are preserved.
pub fn toggle_task_line(line: &str, occurrence: Option<&str>) -> Option<String> {
    // Preserve leading indentation.
    let indent_len = line.len() - line.trim_start().len();
    let (indent, trimmed) = line.split_at(indent_len);
    let rest = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* "))?;
    let bullet = &trimmed[..trimmed.len() - rest.len()]; // "- " or "* "
    let rest = rest.strip_prefix('[')?;
    let (mark, after) = rest.split_at(1);
    // Accept an optional space after `]` (and an empty body) to match `parse_task_line` above and
    // `toggleTaskLine` in fsa-vault.ts — otherwise a line indexes as a task but won't toggle.
    let after = after.strip_prefix("]")?;
    let body = after.strip_prefix(' ').unwrap_or(after);
    let _ = mark;

    match occurrence {
        None => {
            // Flip the checkbox mark.
            let new_mark = if mark.eq_ignore_ascii_case("x") { " " } else { "x" };
            Some(format!("{indent}{bullet}[{new_mark}] {body}"))
        }
        Some(date) => {
            // Split off any existing `✅ …` segment; everything before it is preserved verbatim.
            let (head, mut dates) = match body.find('✅') {
                Some(pos) => {
                    let list = body[pos + '✅'.len_utf8()..].trim();
                    let dates: Vec<String> = list
                        .split(',')
                        .map(|d| d.trim().to_string())
                        .filter(|d| !d.is_empty())
                        .collect();
                    (body[..pos].trim_end().to_string(), dates)
                }
                None => (body.trim_end().to_string(), Vec::new()),
            };
            // Toggle membership of `date`.
            if let Some(i) = dates.iter().position(|d| d == date) {
                dates.remove(i);
            } else {
                dates.push(date.to_string());
                dates.sort();
            }
            let line = if dates.is_empty() {
                format!("{indent}{bullet}[ ] {head}")
            } else {
                format!("{indent}{bullet}[ ] {head} ✅ {}", dates.join(","))
            };
            Some(line)
        }
    }
}

fn find_field(text: &str, markers: &[&str]) -> Option<String> {
    for m in markers {
        if let Some(pos) = text.find(m) {
            let after = text[pos + m.len()..].trim_start();
            // value runs to end-of-line or next emoji/field marker
            let end = after
                .find(['📅', '🔁', '⏳', '✅'])
                .unwrap_or(after.len());
            let val = after[..end].trim().to_string();
            if !val.is_empty() {
                return Some(val);
            }
        }
    }
    None
}

/// Re-index a single file. Removes old rows for it, then inserts fresh ones.
pub fn index_file(conn: &Connection, vault_root: &Path, abs_path: &Path) -> Result<()> {
    let rel = abs_path
        .strip_prefix(vault_root)
        .unwrap_or(abs_path)
        .to_string_lossy()
        .replace('\\', "/");

    // Clear previous rows.
    conn.execute("DELETE FROM pages  WHERE rel_path = ?1", params![rel])?;
    conn.execute("DELETE FROM fields WHERE rel_path = ?1", params![rel])?;
    conn.execute("DELETE FROM tags   WHERE rel_path = ?1", params![rel])?;
    conn.execute("DELETE FROM links  WHERE src = ?1", params![rel])?;
    conn.execute("DELETE FROM tasks  WHERE rel_path = ?1", params![rel])?;

    if !abs_path.exists() {
        return Ok(()); // deletion — rows already cleared.
    }

    let doc = vault::read_doc(abs_path)?;
    let mtime = std::fs::metadata(abs_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let folder = rel.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
    let title = doc
        .frontmatter
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            abs_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        });

    conn.execute(
        "INSERT INTO pages (rel_path, title, folder, mtime, body, frontmatter)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![rel, title, folder, mtime, doc.body, doc.frontmatter.to_string()],
    )?;

    // Frontmatter fields.
    if let Some(obj) = doc.frontmatter.as_object() {
        for (k, v) in obj {
            conn.execute(
                "INSERT OR REPLACE INTO fields (rel_path, key, value) VALUES (?1, ?2, ?3)",
                params![rel, k, v.to_string()],
            )?;
            // frontmatter `tags:` also feed the tags table
            if k == "tags" {
                if let Some(arr) = v.as_array() {
                    for t in arr.iter().filter_map(|x| x.as_str()) {
                        conn.execute("INSERT INTO tags (rel_path, tag) VALUES (?1, ?2)", params![rel, t])?;
                    }
                } else if let Some(s) = v.as_str() {
                    conn.execute("INSERT INTO tags (rel_path, tag) VALUES (?1, ?2)", params![rel, s])?;
                }
            }
        }
    }

    // Body scan: tags, links, tasks (line by line).
    for (i, line) in doc.body.lines().enumerate() {
        for tag in extract_tags(line) {
            conn.execute("INSERT INTO tags (rel_path, tag) VALUES (?1, ?2)", params![rel, tag])?;
        }
        for dst in extract_wikilinks(line) {
            conn.execute("INSERT INTO links (src, dst) VALUES (?1, ?2)", params![rel, dst])?;
        }
        if let Some((done, text, due, rrule, done_dates)) = parse_task_line(line) {
            let line_tags = extract_tags(&text).join(",");
            conn.execute(
                "INSERT OR REPLACE INTO tasks (rel_path, line, text, done, due, rrule, tags, done_dates)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![rel, i as i64, text, done as i64, due, rrule, line_tags, done_dates],
            )?;
        }
    }

    Ok(())
}

/// Wipe and rebuild the whole index from the vault.
pub fn rebuild(conn: &Connection, vault_root: &Path) -> Result<usize> {
    conn.execute_batch(
        "DELETE FROM pages; DELETE FROM fields; DELETE FROM tags; DELETE FROM links; DELETE FROM tasks;",
    )?;
    let files = vault::iter_markdown(vault_root);
    let count = files.len();
    for f in files {
        if let Err(e) = index_file(conn, vault_root, &f) {
            eprintln!("index error {}: {e}", f.display());
        }
    }
    Ok(count)
}

/// Fetch all tasks (used by the Tasks view; recurrence expansion happens in the frontend).
pub fn all_tasks(conn: &Connection) -> Result<Vec<TaskRow>> {
    let mut stmt = conn.prepare(
        "SELECT rel_path, line, text, done, due, rrule, tags, done_dates FROM tasks ORDER BY due IS NULL, due",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TaskRow {
                rel_path: r.get(0)?,
                line: r.get(1)?,
                text: r.get(2)?,
                done: r.get::<_, i64>(3)? != 0,
                due: r.get(4)?,
                rrule: r.get(5)?,
                tags: r.get(6)?,
                done_dates: r.get(7)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Serialize)]
pub struct TagInfo {
    pub tag: String,
    /// How many distinct pages carry this tag.
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct TagPage {
    pub rel_path: String,
    pub title: String,
}

/// One edge of a tag's connection graph: another tag that co-occurs on shared pages.
#[derive(Debug, Serialize)]
pub struct TagConnection {
    pub tag: String,
    /// Number of pages carrying BOTH the focus tag and this one.
    pub shared: i64,
}

/// All tags in the vault with the count of distinct pages each appears on, most-used first.
///
/// The `tags` table holds duplicates (a tag can come from frontmatter *and* several body lines),
/// so we count `DISTINCT rel_path` per tag.
pub fn all_tags(conn: &Connection) -> Result<Vec<TagInfo>> {
    let mut stmt = conn.prepare(
        "SELECT tag, COUNT(DISTINCT rel_path) AS c
         FROM tags
         GROUP BY tag
         ORDER BY c DESC, tag ASC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TagInfo {
                tag: r.get(0)?,
                count: r.get(1)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// The distinct pages carrying `tag`, as (rel_path, title), title-sorted.
pub fn tag_pages(conn: &Connection, tag: &str) -> Result<Vec<TagPage>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT p.rel_path, p.title
         FROM tags t JOIN pages p ON p.rel_path = t.rel_path
         WHERE t.tag = ?1
         ORDER BY p.title ASC",
    )?;
    let rows = stmt
        .query_map(params![tag], |r| {
            Ok(TagPage {
                rel_path: r.get(0)?,
                title: r.get(1)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Tags that co-occur with `tag` on shared pages — the "connections" surfaced in the Tags view.
///
/// For every page carrying the focus `tag`, find the *other* distinct tags on those same pages and
/// count how many shared pages each appears on. This is the graph of how pages link up through tags.
pub fn tag_connections(conn: &Connection, tag: &str) -> Result<Vec<TagConnection>> {
    let mut stmt = conn.prepare(
        "SELECT other.tag, COUNT(DISTINCT other.rel_path) AS shared
         FROM tags other
         WHERE other.tag != ?1
           AND other.rel_path IN (SELECT rel_path FROM tags WHERE tag = ?1)
         GROUP BY other.tag
         ORDER BY shared DESC, other.tag ASC",
    )?;
    let rows = stmt
        .query_map(params![tag], |r| {
            Ok(TagConnection {
                tag: r.get(0)?,
                shared: r.get(1)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}
