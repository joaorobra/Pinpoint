//! App settings, persisted in `<vault>/.pinpoint/settings.json` so they travel with the vault
//! (coherent multi-platform, exactly like `.obsidian`).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: String,            // "light" | "dark" | "system"
    pub font_family: String,      // UI + editor font
    pub editor_font_family: String,
    pub font_size: u32,           // px
    pub accent_color: String,     // hex
    pub background_color: String, // hex (overrides theme bg if set)
    pub text_color: String,       // hex
    pub line_height: f32,
    pub periodic_folder: String,  // where periodic notes live
    pub show_line_numbers: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "dark".into(),
            font_family: "Inter, system-ui, sans-serif".into(),
            editor_font_family: "Inter, system-ui, sans-serif".into(),
            font_size: 16,
            accent_color: "#7c5cff".into(),
            background_color: "".into(),
            text_color: "".into(),
            line_height: 1.6,
            periodic_folder: "Periodic".into(),
            show_line_numbers: false,
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
