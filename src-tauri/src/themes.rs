//! Vault themes, persisted as `<vault>/.themes/<name>.json` so they travel with the notes (like
//! `.pinpoint/settings.json`). A theme is an opaque JSON blob to the backend — the frontend owns its
//! shape (`Theme` in types.ts: paired dark/light variants + optional fonts). We only handle storage:
//! listing, reading, writing and deleting theme files, plus seeding curated starters into a vault
//! that has none yet.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// The folder, under the vault root, where theme files live.
const THEMES_DIR: &str = ".themes";

fn themes_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(THEMES_DIR)
}

/// Reject names that could escape the themes folder or aren't a plain file stem. Theme names map
/// 1:1 to `<name>.json`, so they must be a single path component with no separators or traversal.
fn safe_stem(name: &str) -> Result<&str> {
    let n = name.trim();
    if n.is_empty()
        || n.contains('/')
        || n.contains('\\')
        || n.contains("..")
        || n.starts_with('.')
    {
        anyhow::bail!("invalid theme name: {name:?}");
    }
    Ok(n)
}

fn theme_path(vault_root: &Path, name: &str) -> Result<PathBuf> {
    let stem = safe_stem(name)?;
    Ok(themes_dir(vault_root).join(format!("{stem}.json")))
}

/// The raw JSON text of every theme in the vault, in arbitrary order. The frontend parses and
/// derives the gallery preview, so the backend stays agnostic to the theme schema. Missing/unreadable
/// files are skipped rather than failing the whole list.
pub fn list(vault_root: &Path) -> Vec<String> {
    let dir = themes_dir(vault_root);
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(txt) = std::fs::read_to_string(&path) {
                out.push(txt);
            }
        }
    }
    out
}

/// Read one theme's raw JSON by name.
pub fn read(vault_root: &Path, name: &str) -> Result<String> {
    let path = theme_path(vault_root, name)?;
    std::fs::read_to_string(&path).with_context(|| format!("read theme {name:?}"))
}

/// Write a theme's raw JSON, creating `.themes/` as needed. `name` is the file stem; the caller
/// passes the already-serialized JSON body (the frontend's `Theme`).
pub fn write(vault_root: &Path, name: &str, json: &str) -> Result<()> {
    let path = theme_path(vault_root, name)?;
    std::fs::create_dir_all(themes_dir(vault_root)).ok();
    std::fs::write(&path, json).with_context(|| format!("write theme {name:?}"))?;
    Ok(())
}

/// Delete a theme file. Succeeds quietly if it was already gone.
pub fn delete(vault_root: &Path, name: &str) -> Result<()> {
    let path = theme_path(vault_root, name)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("delete theme {name:?}")),
    }
}

/// Rename a theme file (used when the user renames a theme in the editor). No-op if names match.
pub fn rename(vault_root: &Path, from: &str, to: &str) -> Result<()> {
    if from == to {
        return Ok(());
    }
    let from_path = theme_path(vault_root, from)?;
    let to_path = theme_path(vault_root, to)?;
    std::fs::create_dir_all(themes_dir(vault_root)).ok();
    std::fs::rename(&from_path, &to_path)
        .with_context(|| format!("rename theme {from:?} -> {to:?}"))?;
    Ok(())
}

/// Seed curated starter themes whose files are missing. Each starter is a `(name, json)` pair the
/// frontend provides. Existing files are left untouched, so a user's edited theme is never clobbered
/// — but newly-shipped starters still appear in vaults opened before they existed. Returns the count
/// actually written.
pub fn seed_if_empty(vault_root: &Path, starters: &[(String, String)]) -> Result<usize> {
    std::fs::create_dir_all(themes_dir(vault_root)).ok();
    let mut n = 0;
    for (name, json) in starters {
        let exists = theme_path(vault_root, name)
            .map(|p| p.exists())
            .unwrap_or(true);
        if exists {
            continue; // keep the user's version
        }
        if write(vault_root, name, json).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}
