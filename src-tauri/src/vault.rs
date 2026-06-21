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
                } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                    children.push(TreeNode {
                        name,
                        rel_path: rel(root, &path),
                        is_dir: false,
                        is_database: false,
                        children: Vec::new(),
                    });
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
            children,
        }
    }
    Ok(node_for(root, root))
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
