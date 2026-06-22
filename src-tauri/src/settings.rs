//! App settings, persisted in `<vault>/.pinpoint/settings.json` so they travel with the vault
//! (coherent multi-platform, exactly like `.obsidian`).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// A user-chosen Phosphor icon for a page or folder. Mirrors the TS `NodeIcon`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeIcon {
    pub name: String,   // Phosphor icon name in PascalCase, e.g. "Notebook"
    pub weight: String, // thin | light | regular | bold | fill | duotone
    pub color: String,  // CSS color, or "" to inherit the theme text color
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: String,            // "light" | "dark" | "system"
    pub font_family: String,      // UI + editor font
    pub editor_font_family: String,
    pub font_size: u32,           // px (editor/content text size)
    pub ui_zoom: f32,             // whole-UI scale factor (1.0 = 100%)
    pub accent_color: String,     // hex
    pub background_color: String, // hex (overrides theme bg if set)
    pub text_color: String,       // hex
    pub line_height: f32,
    pub periodic_folder: String,  // where periodic notes live
    pub show_line_numbers: bool,
    /// dateformat.ts patterns, one per use case.
    pub date_format: String,           // editor /today + /date default
    pub time_format: String,           // editor /time
    pub task_date_format: String,      // Tasks view due dates
    pub periodic_label_format: String, // daily periodic-note heading
    /// Per-node icon overrides, keyed by the node's vault-relative path.
    pub node_icons: HashMap<String, NodeIcon>,
    /// "Semi-fullscreen": hide the custom titlebar, revealing it on a top-edge hover. Desktop only.
    pub auto_hide_titlebar: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "dark".into(),
            font_family: "Inter, system-ui, sans-serif".into(),
            editor_font_family: "Inter, system-ui, sans-serif".into(),
            font_size: 16,
            ui_zoom: 1.0,
            accent_color: "#7c5cff".into(),
            background_color: "".into(),
            text_color: "".into(),
            line_height: 1.6,
            periodic_folder: "Periodic".into(),
            show_line_numbers: false,
            date_format: "YYYY-MM-DD".into(),
            time_format: "HH:mm".into(),
            task_date_format: "ddd, D MMM".into(),
            periodic_label_format: "dddd, MMMM D".into(),
            node_icons: HashMap::new(),
            auto_hide_titlebar: false,
        }
    }
}

fn settings_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join(".pinpoint").join("settings.json")
}

pub fn load(vault_root: &Path) -> Settings {
    let path = settings_path(vault_root);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(vault_root: &Path, settings: &Settings) -> Result<()> {
    let dir = vault_root.join(".pinpoint");
    std::fs::create_dir_all(&dir).ok();
    let json = serde_json::to_string_pretty(settings).context("serialize settings")?;
    std::fs::write(settings_path(vault_root), json).context("write settings.json")?;
    Ok(())
}
