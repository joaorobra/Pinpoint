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
    pub page_width: u32,          // editor page column width in px
    pub periodic_folder: String,  // where periodic notes live
    pub templates_folder: String, // where reusable {{variable}} templates live
    /// Per-period template bindings: Period name -> template's vault-relative path.
    pub periodic_templates: HashMap<String, String>,
    pub show_line_numbers: bool,
    /// Show the floating formatting toolbar (H1–H3, B/I/S, lists…) at the top of the editor.
    pub show_format_toolbar: bool,
    /// dateformat.ts patterns, one per use case.
    pub date_format: String,           // editor /today + /date default
    pub time_format: String,           // editor /time
    pub task_date_format: String,      // Tasks view due dates
    /// Stamp a `done:: <timestamp>` field onto a to-do when its checkbox is ticked.
    pub stamp_done_date: bool,
    /// dateformat.ts pattern for the completion stamp (date-only or date + time).
    pub done_date_format: String,
    /// Optional text before the completion timestamp (e.g. "✅"). "" = just the timestamp.
    pub done_date_prefix: String,
    /// Strike through + dim completed to-do text in the editor.
    pub strike_done_tasks: bool,
    /// Completed to-dos in the editor: "show" | "dim" | "hide".
    pub completed_task_display: String,
    /// Inline `priority::` rendering: "both" (flag + word) | "flag" | "text".
    pub priority_display: String,
    /// Tint inline due-date markers by urgency (overdue / today / soon) in the editor.
    pub highlight_due_dates: bool,
    pub periodic_label_format: String, // daily periodic-note heading
    /// Per-node icon overrides, keyed by the node's vault-relative path.
    pub node_icons: HashMap<String, NodeIcon>,
    /// "Semi-fullscreen": hide the custom titlebar, revealing it on a top-edge hover. Desktop only.
    pub auto_hide_titlebar: bool,
    /// As-you-type symbol replacements: trigger -> output (e.g. "->" -> "→").
    pub smart_replacements: HashMap<String, String>,
    /// Text-expansion snippets: name -> inserted text (fired via `snippet_delimiter`).
    pub snippets: HashMap<String, String>,
    /// Delimiter wrapping a snippet name to fire it (default "_").
    pub snippet_delimiter: String,
    /// What to open when this vault is (re)opened: "last" | "today" | "page".
    pub startup_behavior: String,
    /// Vault-relative path of the page opened on launch when `startup_behavior` is "page".
    pub startup_page: String,
    /// Name of the active theme (a `.themes/<name>.json` file). "" = built-in default palette.
    pub active_theme: String,
    /// AI chat defaults each new conversation starts from (overridable per-conversation in the
    /// composer). Mirror the TS `Settings` ai_* fields. "" = let the CLI use its own default.
    pub ai_provider: String, // "claude" | "gemini" | "codex"
    pub ai_model: String,    // model alias (`--model`); "" = CLI default
    pub ai_effort: String,   // reasoning effort (`--effort`); "" = CLI default
    pub ai_mode: String,     // "chat" | "note" | "agent"
    pub ai_preset: String,   // role preset text prepended to the system prompt; "" = none
}

/// Built-in symbol replacements seeded into a fresh vault. Mirrors DEFAULT_SMART_REPLACEMENTS in TS.
fn default_smart_replacements() -> HashMap<String, String> {
    [
        ("->", "→"), ("<-", "←"), ("<->", "↔"), ("=>", "⇒"), ("<=", "⇐"),
        ("(tm)", "™"), ("(c)", "©"), ("(r)", "®"),
        ("!=", "≠"), ("+-", "±"), (">=", "≥"), ("=<", "≤"), ("~=", "≈"),
        ("...", "…"),
        ("1/2", "½"), ("1/4", "¼"), ("3/4", "¾"), ("1/3", "⅓"), ("2/3", "⅔"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
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
            page_width: 820,
            periodic_folder: "Periodic".into(),
            templates_folder: "Templates".into(),
            periodic_templates: HashMap::new(),
            show_line_numbers: false,
            show_format_toolbar: true,
            date_format: "YYYY-MM-DD".into(),
            time_format: "HH:mm".into(),
            task_date_format: "ddd, D MMM".into(),
            stamp_done_date: true,
            done_date_format: "YYYY-MM-DD HH:mm".into(),
            done_date_prefix: "".into(),
            strike_done_tasks: true,
            completed_task_display: "show".into(),
            priority_display: "both".into(),
            highlight_due_dates: true,
            periodic_label_format: "dddd, MMMM D".into(),
            node_icons: HashMap::new(),
            auto_hide_titlebar: false,
            smart_replacements: default_smart_replacements(),
            snippets: HashMap::new(),
            snippet_delimiter: "_".into(),
            startup_behavior: "last".into(),
            startup_page: "".into(),
            active_theme: "".into(),
            ai_provider: "claude".into(),
            ai_model: "".into(),
            ai_effort: "".into(),
            ai_mode: "chat".into(),
            ai_preset: "".into(),
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
