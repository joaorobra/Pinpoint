//! Vault model: the on-disk source of truth.
//!
//! - Pages are `.md` files.
//! - A "database" is a folder containing a `.pinpoint-db.json` schema file; each row is a
//!   `.md` file inside it with YAML frontmatter holding the structured fields.
//! - SQLite (see `index.rs`) is a *rebuildable cache* — never the source of truth.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// A parsed markdown file: YAML frontmatter (as JSON) + the markdown body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedDoc {
    /// Frontmatter decoded into a JSON object (empty object if none).
    pub frontmatter: serde_json::Value,
    /// Markdown body (everything after the frontmatter block).
    pub body: String,
}

/// A node in the vault file tree.
#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    pub name: String,
    /// Path relative to the vault root, using forward slashes.
    pub rel_path: String,
    pub is_dir: bool,
    /// True when this directory is a PINPOINT database (has `.pinpoint-db.json`).
    pub is_database: bool,
    /// Lowercase extension without the dot for non-markdown files (e.g. "pdf"); "" for dirs/md.
    pub ext: String,
    pub children: Vec<TreeNode>,
}

/// Split a markdown file's raw text into frontmatter (JSON) + body.
pub fn parse_frontmatter(raw: &str) -> ParsedDoc {
    let matter = gray_matter::Matter::<gray_matter::engine::YAML>::new();
    match matter.parse_with_struct::<serde_json::Value>(raw) {
        Some(parsed) => ParsedDoc {
            frontmatter: parsed.data,
            body: parsed.content,
        },
        None => {
            // No frontmatter, or it failed to parse — treat the whole thing as body.
            let stripped = gray_matter::Matter::<gray_matter::engine::YAML>::new().parse(raw);
            ParsedDoc {
                frontmatter: serde_json::json!({}),
                body: stripped.content,
            }
        }
    }
}

/// Serialize frontmatter (JSON object) + body back into a markdown file string.
/// Round-trips: if frontmatter is an empty object, no frontmatter block is written.
pub fn serialize_doc(frontmatter: &serde_json::Value, body: &str) -> Result<String> {
    let is_empty = frontmatter
        .as_object()
        .map(|m| m.is_empty())
        .unwrap_or(true);
    if is_empty {
        return Ok(body.to_string());
    }
    let yaml = serde_yaml::to_string(frontmatter).context("serialize frontmatter to yaml")?;
    // gray_matter emits without trailing `---`; we build the standard fence ourselves.
    Ok(format!("---\n{}---\n\n{}", yaml, body))
}

/// Read + parse a single markdown file.
pub fn read_doc(abs_path: &Path) -> Result<ParsedDoc> {
    let raw = std::fs::read_to_string(abs_path)
        .with_context(|| format!("read {}", abs_path.display()))?;
    Ok(parse_frontmatter(&raw))
}

/// Write a markdown file (frontmatter + body), creating parent dirs as needed.
pub fn write_doc(abs_path: &Path, frontmatter: &serde_json::Value, body: &str) -> Result<()> {
    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let out = serialize_doc(frontmatter, body)?;
    std::fs::write(abs_path, out).with_context(|| format!("write {}", abs_path.display()))?;
    Ok(())
}

/// The schema file that marks a folder as a PINPOINT database. Mirrors the default the
/// frontend writes so a database created on either host is recognised by the other.
pub const DB_SCHEMA_FILE: &str = ".pinpoint-db.json";

/// Default schema for a freshly-created database: a title column plus a select column, matching
/// Notion's "new database" starting point. Each row will be a `.md` file whose frontmatter holds
/// these fields.
fn default_db_schema(name: &str) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "columns": [
            { "id": "name", "name": "Name", "type": "title" },
            { "id": "status", "name": "Status", "type": "select", "options": [] },
        ],
    })
}

/// Create a plain folder. Fails if it already exists so we never silently merge into an
/// existing folder. Empty folders are surfaced in the tree (see `build_tree`).
pub fn create_folder(abs_dir: &Path) -> Result<()> {
    if abs_dir.exists() {
        anyhow::bail!("folder already exists");
    }
    std::fs::create_dir_all(abs_dir)
        .with_context(|| format!("create folder {}", abs_dir.display()))?;
    Ok(())
}

/// Create a database: a folder containing a `.pinpoint-db.json` schema. Fails if the folder
/// already exists so we never silently convert an existing folder or clobber a schema.
pub fn create_database(abs_dir: &Path, name: &str) -> Result<()> {
    if abs_dir.exists() {
        anyhow::bail!("folder already exists");
    }
    std::fs::create_dir_all(abs_dir)
        .with_context(|| format!("create database folder {}", abs_dir.display()))?;
    write_db_schema(abs_dir, &default_db_schema(name))?;
    Ok(())
}

/// Convert an *existing* folder into a database by dropping a default `.pinpoint-db.json` into it.
/// Unlike `create_database`, the folder is expected to already exist. Bails if it isn't a directory
/// or is already a database so we never clobber an existing schema. Existing `.md` files become rows.
pub fn convert_to_database(abs_dir: &Path, name: &str) -> Result<()> {
    if !abs_dir.is_dir() {
        anyhow::bail!("not a folder");
    }
    if abs_dir.join(DB_SCHEMA_FILE).exists() {
        anyhow::bail!("folder is already a database");
    }
    write_db_schema(abs_dir, &default_db_schema(name))?;
    Ok(())
}

/// Read a database's schema (`.pinpoint-db.json`). Returns a minimal default if the file is missing
/// or malformed, so a hand-created marker file never breaks the view.
pub fn read_db_schema(abs_dir: &Path) -> Result<serde_json::Value> {
    let path = abs_dir.join(DB_SCHEMA_FILE);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => {
            let name = abs_dir
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Database".into());
            return Ok(default_db_schema(&name));
        }
    };
    Ok(serde_json::from_str(&raw).unwrap_or_else(|_| {
        let name = abs_dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Database".into());
        default_db_schema(&name)
    }))
}

/// Write a database's schema back to `.pinpoint-db.json` (pretty-printed for human diffs).
pub fn write_db_schema(abs_dir: &Path, schema: &serde_json::Value) -> Result<()> {
    std::fs::create_dir_all(abs_dir).ok();
    let raw = serde_json::to_string_pretty(schema).context("serialize db schema")?;
    std::fs::write(abs_dir.join(DB_SCHEMA_FILE), raw)
        .with_context(|| format!("write {DB_SCHEMA_FILE}"))?;
    Ok(())
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Build the file tree for a vault, hiding dotfiles/dot-folders (e.g. `.pinpoint`, `.git`).
pub fn build_tree(root: &Path) -> Result<TreeNode> {
    fn node_for(root: &Path, dir: &Path) -> TreeNode {
        let is_database = dir.join(".pinpoint-db.json").exists();
        let mut children: Vec<TreeNode> = Vec::new();

        if let Ok(entries) = std::fs::read_dir(dir) {
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue; // skip dotfiles/dot-folders
                }
                let path = entry.path();
                if path.is_dir() {
                    children.push(node_for(root, &path));
                } else {
                    let ext = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_lowercase())
                        .unwrap_or_default();
                    if ext == "md" {
                        children.push(TreeNode {
                            name,
                            rel_path: rel(root, &path),
                            is_dir: false,
                            is_database: false,
                            ext: String::new(),
                            children: Vec::new(),
                        });
                    } else if !ext.is_empty() {
                        // Surface other file types (PDFs, images, …) so they show in the explorer.
                        children.push(TreeNode {
                            name,
                            rel_path: rel(root, &path),
                            is_dir: false,
                            is_database: false,
                            ext,
                            children: Vec::new(),
                        });
                    }
                }
            }
        }
        // Dirs first, then files; both alphabetical.
        children.sort_by(|a, b| (!a.is_dir, &a.name).cmp(&(!b.is_dir, &b.name)));

        TreeNode {
            name: dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "vault".to_string()),
            rel_path: rel(root, dir),
            is_dir: true,
            is_database,
            ext: String::new(),
            children,
        }
    }
    Ok(node_for(root, root))
}

/// Write a binary asset (a pasted/dropped image, …) to disk, creating parent dirs as needed.
/// Used for the editor's `.attachments` folder so pasted images live alongside the vault.
pub fn write_asset(abs_path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(abs_path, bytes).with_context(|| format!("write {}", abs_path.display()))?;
    Ok(())
}

/// Read a non-markdown asset (image/pdf/…) as a base64 data URL the webview can render directly.
pub fn read_asset(abs_path: &Path) -> Result<String> {
    use base64::Engine;
    let bytes =
        std::fs::read(abs_path).with_context(|| format!("read {}", abs_path.display()))?;
    let mime = mime_for(abs_path);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// Best-effort MIME from a file extension; defaults to octet-stream.
fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("pdf") => "application/pdf",
        Some("txt") | Some("log") => "text/plain",
        Some("csv") => "text/csv",
        Some("json") => "application/json",
        Some("yaml") | Some("yml") => "text/yaml",
        Some("toml") => "text/plain",
        _ => "application/octet-stream",
    }
}

// ============================================================================
// Trash — soft delete into `.trash/`, restorable from a manifest.
//
// `.trash` lives at the vault root and is hidden from the tree (dotfolders are skipped). Each
// deleted item is moved to `.trash/<id>/<leaf>` — a per-item subfolder so two files of the same
// name (or a re-deleted path) never collide. The manifest at `.trash/manifest.json` records, per
// id, where the item came from so it can be restored, plus a deletion timestamp for display.
// ============================================================================

/// One trashed item, as stored in the manifest and surfaced to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashEntry {
    /// Opaque id; also the name of the per-item folder under `.trash`.
    pub id: String,
    /// Original vault-relative path the item was deleted from (forward slashes).
    pub orig_path: String,
    /// Leaf name (file or folder name) as it appeared in the vault.
    pub name: String,
    /// True if the trashed item is a directory.
    pub is_dir: bool,
    /// Unix-millis when it was trashed.
    pub deleted_at: i64,
}

fn trash_dir(root: &Path) -> PathBuf {
    root.join(".trash")
}

fn manifest_path(root: &Path) -> PathBuf {
    trash_dir(root).join("manifest.json")
}

/// Load the trash manifest (most-recent first is applied by the caller). Missing/corrupt → empty.
pub fn read_manifest(root: &Path) -> Vec<TrashEntry> {
    let path = manifest_path(root);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn write_manifest(root: &Path, entries: &[TrashEntry]) -> Result<()> {
    let dir = trash_dir(root);
    std::fs::create_dir_all(&dir).ok();
    let raw = serde_json::to_string_pretty(entries).context("serialize trash manifest")?;
    std::fs::write(manifest_path(root), raw).context("write trash manifest")?;
    Ok(())
}

/// Build a unique id for a trashed item from a millis timestamp + the leaf name. The folder created
/// under `.trash` uses this id, so it must be filesystem-safe and collision-resistant.
fn trash_id(now_ms: i64, leaf: &str) -> String {
    let safe: String = leaf
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    format!("{now_ms}-{safe}")
}

/// Move a vault item (file or folder) into `.trash`, recording it in the manifest. Returns the new
/// trash entry. `now_ms` is supplied by the caller (the backend owns the clock).
pub fn trash_move(root: &Path, rel_path: &str, now_ms: i64) -> Result<TrashEntry> {
    let src = root.join(rel_path);
    if !src.exists() {
        anyhow::bail!("not found: {rel_path}");
    }
    let is_dir = src.is_dir();
    let leaf = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| rel_path.to_string());

    let id = trash_id(now_ms, &leaf);
    let dest_dir = trash_dir(root).join(&id);
    std::fs::create_dir_all(&dest_dir).context("create trash item folder")?;
    let dest = dest_dir.join(&leaf);
    move_path(&src, &dest)?;

    let entry = TrashEntry {
        id,
        orig_path: rel_path.replace('\\', "/"),
        name: leaf,
        is_dir,
        deleted_at: now_ms,
    };
    let mut entries = read_manifest(root);
    entries.push(entry.clone());
    write_manifest(root, &entries)?;
    Ok(entry)
}

/// Restore a trashed item back to its original path (or a non-clobbering variant if that path is
/// now occupied) and drop it from the manifest. Returns the rel_path it was restored to.
pub fn trash_restore(root: &Path, id: &str) -> Result<String> {
    let mut entries = read_manifest(root);
    let pos = entries
        .iter()
        .position(|e| e.id == id)
        .context("trash entry not found")?;
    let entry = entries[pos].clone();

    let src = trash_dir(root).join(&entry.id).join(&entry.name);
    if !src.exists() {
        // The on-disk item is gone (manually removed?) — clean the dangling manifest row.
        entries.remove(pos);
        write_manifest(root, &entries)?;
        anyhow::bail!("trashed item missing on disk: {}", entry.name);
    }

    let dest_rel = non_clobbering_rel(root, &entry.orig_path);
    let dest = root.join(&dest_rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    move_path(&src, &dest)?;
    // Drop the now-empty per-item folder and the manifest row.
    std::fs::remove_dir_all(trash_dir(root).join(&entry.id)).ok();
    entries.remove(pos);
    write_manifest(root, &entries)?;
    Ok(dest_rel)
}

/// Permanently remove a single trashed item (folder + manifest row).
pub fn trash_purge(root: &Path, id: &str) -> Result<()> {
    let mut entries = read_manifest(root);
    let item_dir = trash_dir(root).join(id);
    if item_dir.exists() {
        std::fs::remove_dir_all(&item_dir).context("remove trashed item")?;
    }
    entries.retain(|e| e.id != id);
    write_manifest(root, &entries)?;
    Ok(())
}

/// Permanently empty the entire trash (every item + manifest).
pub fn trash_empty(root: &Path) -> Result<()> {
    let dir = trash_dir(root);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).context("empty trash")?;
    }
    Ok(())
}

/// Resolve a rel_path that doesn't clobber an existing item, appending " (restored)", " (restored 2)",
/// … before the extension as needed.
fn non_clobbering_rel(root: &Path, rel_path: &str) -> String {
    if !root.join(rel_path).exists() {
        return rel_path.to_string();
    }
    let (stem, ext) = match rel_path.rsplit_once('.') {
        // Only treat the trailing token as an extension when it has no slash (i.e. it's not a dir).
        Some((s, e)) if !e.contains('/') => (s.to_string(), format!(".{e}")),
        _ => (rel_path.to_string(), String::new()),
    };
    for n in 1.. {
        let suffix = if n == 1 {
            " (restored)".to_string()
        } else {
            format!(" (restored {n})")
        };
        let candidate = format!("{stem}{suffix}{ext}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// Move a path, falling back to copy+remove when a plain rename fails (e.g. across devices).
fn move_path(src: &Path, dest: &Path) -> Result<()> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    if src.is_dir() {
        copy_dir_all(src, dest)?;
        std::fs::remove_dir_all(src).context("remove source dir after copy")?;
    } else {
        std::fs::copy(src, dest).context("copy file")?;
        std::fs::remove_file(src).context("remove source file after copy")?;
    }
    Ok(())
}

/// Recursively copy a directory tree (used as the cross-device fallback for `move_path`).
fn copy_dir_all(src: &Path, dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Iterate every `.md` file under the vault (skips dot-folders).
pub fn iter_markdown(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            !e.file_name()
                .to_str()
                .map(|s| s.starts_with('.'))
                .unwrap_or(false)
        })
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
        .collect()
}
