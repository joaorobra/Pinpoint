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
    rel_path  TEXT NOT NULL,
    line      INTEGER NOT NULL,
    text      TEXT NOT NULL,
    done      INTEGER NOT NULL,
    due       TEXT,            -- ISO date if present (📅 / due::)
    rrule     TEXT,            -- recurrence rule if present (🔁 / repeat::)
    tags      TEXT,            -- comma-joined #tags found on the line
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
pub struct TaskRow {
    pub rel_path: String,
    pub line: i64,
    pub text: String,
    pub done: bool,
    pub due: Option<String>,
    pub rrule: Option<String>,
    pub tags: Option<String>,
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

/// Parse a single line for task syntax. Returns Some((done, text, due, rrule)) if it's a task.
fn parse_task_line(line: &str) -> Option<(bool, String, Option<String>, Option<String>)> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* "))?;
    let rest = rest.strip_prefix("[")?;
    let (mark, after) = rest.split_at(1);
    let after = after.strip_prefix("] ")?;
    let done = mark.eq_ignore_ascii_case("x");

    // Inline fields: `📅 2026-06-21`, `due:: 2026-06-21`, `🔁 every week`, `repeat:: FREQ=WEEKLY`.
    let due = find_field(after, &["📅", "due::"]).map(|s| s.split_whitespace().next().unwrap_or("").to_string());
    let rrule = find_field(after, &["🔁", "repeat::"]);

    Some((done, after.to_string(), due, rrule))
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
        if let Some((done, text, due, rrule)) = parse_task_line(line) {
            let line_tags = extract_tags(&text).join(",");
            conn.execute(
                "INSERT OR REPLACE INTO tasks (rel_path, line, text, done, due, rrule, tags)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![rel, i as i64, text, done as i64, due, rrule, line_tags],
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
        "SELECT rel_path, line, text, done, due, rrule, tags FROM tasks ORDER BY due IS NULL, due",
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
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}
