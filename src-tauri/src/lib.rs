//! PINPOINT Tauri backend.
//!
//! Holds the active vault, the SQLite index, and a filesystem watcher. Exposes commands the
//! React frontend calls via `invoke`.

mod index;
mod query;
mod recents;
mod settings;
mod themes;
mod vault;

use notify::{RecursiveMode, Watcher};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};

/// The OS app-config directory (e.g. `%APPDATA%/<bundle-id>`), where the global
/// recent-vaults list is stored. Falls back to the current dir if unavailable.
fn config_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Shared app state behind a mutex (commands are infrequent, contention is negligible).
#[derive(Default)]
pub struct AppState {
    inner: Mutex<Option<VaultSession>>,
}

struct VaultSession {
    root: PathBuf,
    conn: Connection,
    _watcher: notify::RecommendedWatcher,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn open_vault(
    path: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<vault::TreeNode, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a folder: {path}"));
    }

    let conn = index::open(&root).map_err(err)?;
    index::rebuild(&conn, &root).map_err(err)?;

    // Spawn a watcher that re-indexes touched files and notifies the frontend.
    let app_handle = app.clone();
    let watch_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let touched_md = event
                .paths
                .iter()
                .any(|p| p.extension().and_then(|e| e.to_str()) == Some("md"));
            if touched_md {
                // Re-index happens lazily; tell the frontend to refresh.
                let _ = app_handle.emit("vault-changed", ());
            }
        }
        let _ = &watch_root;
    })
    .map_err(err)?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(err)?;

    let tree = vault::build_tree(&root).map_err(err)?;

    // Remember this vault as the most-recently-opened so the app can re-open it next launch.
    recents::record(&config_dir(&app), &root, now_ms());

    *state.inner.lock().unwrap() = Some(VaultSession {
        root,
        conn,
        _watcher: watcher,
    });

    Ok(tree)
}

/// The recently-opened vaults, most-recent first (stale folders filtered out). The
/// frontend uses the first entry to auto-open on launch and the rest to populate the switcher.
#[tauri::command]
fn list_recent_vaults(app: tauri::AppHandle) -> Vec<recents::RecentVault> {
    recents::list(&config_dir(&app))
}

#[tauri::command]
fn get_tree(state: State<AppState>) -> Result<vault::TreeNode, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    vault::build_tree(&session.root).map_err(err)
}

#[tauri::command]
fn read_page(rel_path: String, state: State<AppState>) -> Result<vault::ParsedDoc, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    vault::read_doc(&session.root.join(&rel_path)).map_err(err)
}

#[tauri::command]
fn read_asset(rel_path: String, state: State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    vault::read_asset(&session.root.join(&rel_path)).map_err(err)
}

/// Write a binary asset (a pasted/dropped image) into the vault. `data_base64` is the image
/// bytes base64-encoded (mirrors how `read_asset` returns them) so they cross the IPC boundary
/// compactly. `rel_path` is vault-relative, typically `.attachments/<name>`.
#[tauri::command]
fn write_asset(
    rel_path: String,
    data_base64: String,
    state: State<AppState>,
) -> Result<(), String> {
    use base64::Engine;
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(err)?;
    vault::write_asset(&session.root.join(&rel_path), &bytes).map_err(err)?;
    Ok(())
}

#[tauri::command]
fn write_page(
    rel_path: String,
    frontmatter: serde_json::Value,
    body: String,
    state: State<AppState>,
) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let abs = session.root.join(&rel_path);
    vault::write_doc(&abs, &frontmatter, &body).map_err(err)?;
    index::index_file(&session.conn, &session.root, &abs).map_err(err)?;
    Ok(())
}

#[tauri::command]
fn create_page(rel_path: String, body: String, state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let abs = session.root.join(&rel_path);
    if abs.exists() {
        return Err("file already exists".into());
    }
    vault::write_doc(&abs, &serde_json::json!({}), &body).map_err(err)?;
    index::index_file(&session.conn, &session.root, &abs).map_err(err)?;
    Ok(())
}

/// Create a plain folder (the sidebar ＋ menu). Empty folders show in the tree.
#[tauri::command]
fn create_folder(rel_path: String, state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let abs = session.root.join(&rel_path);
    vault::create_folder(&abs).map_err(err)
}

/// Create a database: a folder + `.pinpoint-db.json` schema (the editor's `/database` command and
/// the sidebar ＋ menu). Rows are added later as `.md` files inside it.
#[tauri::command]
fn create_database(rel_path: String, name: String, state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let abs = session.root.join(&rel_path);
    vault::create_database(&abs, &name).map_err(err)
}

/// Convert an existing folder into a database in place (the explorer's "Convert to Database" action).
/// Existing `.md` files inside it become rows; bails if the folder is already a database.
#[tauri::command]
fn convert_to_database(rel_path: String, name: String, state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let abs = session.root.join(&rel_path);
    vault::convert_to_database(&abs, &name).map_err(err)
}

/// Read a database folder's schema (`.pinpoint-db.json`). Falls back to a default if absent.
#[tauri::command]
fn read_db_schema(rel_path: String, state: State<AppState>) -> Result<serde_json::Value, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    vault::read_db_schema(&session.root.join(&rel_path)).map_err(err)
}

/// Persist a database folder's schema (column add/rename/retype, option edits, widths).
#[tauri::command]
fn write_db_schema(
    rel_path: String,
    schema: serde_json::Value,
    state: State<AppState>,
) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    vault::write_db_schema(&session.root.join(&rel_path), &schema).map_err(err)
}

/// Permanently delete a file or folder (shift-delete / "Delete forever"). For a soft delete that
/// can be restored, use `trash_page` instead.
#[tauri::command]
fn delete_page(rel_path: String, state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let abs = session.root.join(&rel_path);
    if abs.is_dir() {
        std::fs::remove_dir_all(&abs).map_err(err)?;
    } else {
        std::fs::remove_file(&abs).map_err(err)?;
    }
    // The index only tracks markdown; rebuild so a deleted folder's pages all drop out.
    index::rebuild(&session.conn, &session.root).map_err(err)?;
    Ok(())
}

/// Soft delete: move a file or folder into `.trash`, recorded in the manifest for later restore.
#[tauri::command]
fn trash_page(rel_path: String, state: State<AppState>) -> Result<vault::TrashEntry, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let entry = vault::trash_move(&session.root, &rel_path, now_ms()).map_err(err)?;
    index::rebuild(&session.conn, &session.root).map_err(err)?;
    Ok(entry)
}

/// List trashed items, most-recently-deleted first.
#[tauri::command]
fn list_trash(state: State<AppState>) -> Result<Vec<vault::TrashEntry>, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let mut entries = vault::read_manifest(&session.root);
    entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(entries)
}

/// Restore a trashed item to its original location (or a non-clobbering variant). Returns the
/// rel_path it landed at.
#[tauri::command]
fn restore_trash(id: String, state: State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let rel = vault::trash_restore(&session.root, &id).map_err(err)?;
    index::rebuild(&session.conn, &session.root).map_err(err)?;
    Ok(rel)
}

/// Permanently remove one trashed item.
#[tauri::command]
fn purge_trash(id: String, state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    vault::trash_purge(&session.root, &id).map_err(err)
}

/// Permanently empty the entire trash.
#[tauri::command]
fn empty_trash(state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    vault::trash_empty(&session.root).map_err(err)
}

#[tauri::command]
fn rename_path(
    from_rel: String,
    to_rel: String,
    state: State<AppState>,
) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let from = session.root.join(&from_rel);
    let to = session.root.join(&to_rel);
    if to.exists() {
        return Err(format!("already exists: {to_rel}"));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::rename(&from, &to).map_err(err)?;
    // Rebuild the index so renamed pages keep correct paths.
    index::rebuild(&session.conn, &session.root).map_err(err)?;
    Ok(())
}

#[tauri::command]
fn reindex(state: State<AppState>) -> Result<usize, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    index::rebuild(&session.conn, &session.root).map_err(err)
}

#[tauri::command]
fn run_query(dsl: String, state: State<AppState>) -> Result<query::QueryResult, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    query::run(&session.conn, &dsl).map_err(err)
}

/// Toggle a task's done state by rewriting its source line in place, then re-indexing.
///
/// `line` is the 0-based line index within the page body (as stored in the tasks index).
/// `occurrence`:
///   - `None`        → plain task: flip its `[ ]`⇄`[x]` checkbox.
///   - `Some(date)`  → a specific occurrence of a recurring task: add/remove that ISO date from
///                     the line's `✅ …` completed-occurrences list (the recurring line stays open).
#[tauri::command]
fn toggle_task(
    rel_path: String,
    line: usize,
    occurrence: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let abs = session.root.join(&rel_path);
    let doc = vault::read_doc(&abs).map_err(err)?;

    let mut lines: Vec<String> = doc.body.lines().map(|s| s.to_string()).collect();
    let target = lines.get(line).ok_or("task line out of range")?;
    let new_line = index::toggle_task_line(target, occurrence.as_deref())
        .ok_or("not a task line")?;
    lines[line] = new_line;
    // Preserve a trailing newline if the original body had one.
    let mut body = lines.join("\n");
    if doc.body.ends_with('\n') {
        body.push('\n');
    }

    vault::write_doc(&abs, &doc.frontmatter, &body).map_err(err)?;
    index::index_file(&session.conn, &session.root, &abs).map_err(err)?;
    Ok(())
}

#[tauri::command]
fn list_tasks(state: State<AppState>) -> Result<Vec<index::TaskRow>, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    index::all_tasks(&session.conn).map_err(err)
}

/// Full-text search over page titles + bodies (the command palette's "found inside pages"
/// results). Capped server-side so a broad query can't return the whole vault.
#[tauri::command]
fn search_pages(query: String, state: State<AppState>) -> Result<Vec<index::SearchHit>, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    index::search_pages(&session.conn, &query, 50).map_err(err)
}

/// All tags in the vault, each with how many distinct pages carry it (Tags view sidebar).
#[tauri::command]
fn list_tags(state: State<AppState>) -> Result<Vec<index::TagInfo>, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    index::all_tags(&session.conn).map_err(err)
}

/// The pages carrying a given tag (Tags view: pages list for the selected tag).
#[tauri::command]
fn tag_pages(tag: String, state: State<AppState>) -> Result<Vec<index::TagPage>, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    index::tag_pages(&session.conn, &tag).map_err(err)
}

/// Tags that co-occur with a given tag on shared pages (Tags view: connections graph).
#[tauri::command]
fn tag_connections(tag: String, state: State<AppState>) -> Result<Vec<index::TagConnection>, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    index::tag_connections(&session.conn, &tag).map_err(err)
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<settings::Settings, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    Ok(settings::load(&session.root))
}

#[tauri::command]
fn save_settings(s: settings::Settings, state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    settings::save(&session.root, &s).map_err(err)
}

// ---- Themes (`.themes/<name>.json`) -------------------------------------------------------------
// Stored opaquely; the frontend owns the JSON shape (see types.ts `Theme`). The backend only does
// storage so the two hosts (Tauri + web FSA) stay in lockstep on the same files.

#[tauri::command]
fn list_themes(state: State<AppState>) -> Result<Vec<String>, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    Ok(themes::list(&session.root))
}

#[tauri::command]
fn read_theme(name: String, state: State<AppState>) -> Result<String, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    themes::read(&session.root, &name).map_err(err)
}

#[tauri::command]
fn write_theme(name: String, json: String, state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    themes::write(&session.root, &name, &json).map_err(err)
}

#[tauri::command]
fn delete_theme(name: String, state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    themes::delete(&session.root, &name).map_err(err)
}

#[tauri::command]
fn rename_theme(from: String, to: String, state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    themes::rename(&session.root, &from, &to).map_err(err)
}

/// Seed curated starter themes into a vault that has no `.themes/` folder yet. `starters` is a list
/// of `[name, json]` pairs from the frontend. Returns how many were written (0 if already seeded).
#[tauri::command]
fn seed_themes(starters: Vec<(String, String)>, state: State<AppState>) -> Result<usize, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    themes::seed_if_empty(&session.root, &starters).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_vault,
            get_tree,
            read_page,
            read_asset,
            write_asset,
            write_page,
            create_page,
            create_folder,
            create_database,
            convert_to_database,
            read_db_schema,
            write_db_schema,
            delete_page,
            trash_page,
            list_trash,
            restore_trash,
            purge_trash,
            empty_trash,
            rename_path,
            reindex,
            run_query,
            search_pages,
            list_tasks,
            list_tags,
            tag_pages,
            tag_connections,
            toggle_task,
            get_settings,
            save_settings,
            list_themes,
            read_theme,
            write_theme,
            delete_theme,
            rename_theme,
            seed_themes,
            list_recent_vaults
        ])
        .setup(|app| {
            // Ensure state exists; nothing else needed at startup.
            let _ = app.handle();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running PINPOINT");
}
