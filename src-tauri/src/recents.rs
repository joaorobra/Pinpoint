//! App-global config: the list of recently-opened vaults.
//!
//! Unlike per-vault `settings.json`, this lives in the OS app-config directory
//! (e.g. `%APPDATA%/com.pinpoint.app` on Windows) so it survives across vaults and
//! lets the app re-open the most recent vault on launch.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One entry in the recent-vaults list. `path` is the absolute folder path;
/// `name` is its display label (the folder's file name).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentVault {
    pub path: String,
    pub name: String,
    /// Unix-millis timestamp of the last time this vault was opened (for ordering).
    pub last_opened: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct AppConfig {
    recent_vaults: Vec<RecentVault>,
}

fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join("recents.json")
}

fn load(config_dir: &Path) -> AppConfig {
    match std::fs::read_to_string(config_path(config_dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

fn save(config_dir: &Path, cfg: &AppConfig) {
    std::fs::create_dir_all(config_dir).ok();
    if let Ok(json) = serde_json::to_string_pretty(cfg) {
        std::fs::write(config_path(config_dir), json).ok();
    }
}

/// The recent vaults, most-recently-opened first. Stale entries (folder no longer
/// exists) are filtered out so the Start screen never offers a dead vault.
pub fn list(config_dir: &Path) -> Vec<RecentVault> {
    let mut v: Vec<RecentVault> = load(config_dir)
        .recent_vaults
        .into_iter()
        .filter(|r| Path::new(&r.path).is_dir())
        .collect();
    v.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    v
}

/// Record that `path` was just opened: move/insert it at the front, dedupe by path,
/// and cap the list at 12 entries.
pub fn record(config_dir: &Path, path: &Path, now_ms: i64) {
    let path_str = path.to_string_lossy().to_string();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path_str.clone());

    let mut cfg = load(config_dir);
    cfg.recent_vaults.retain(|r| r.path != path_str);
    cfg.recent_vaults.insert(
        0,
        RecentVault {
            path: path_str,
            name,
            last_opened: now_ms,
        },
    );
    cfg.recent_vaults.truncate(12);
    save(config_dir, &cfg);
}
