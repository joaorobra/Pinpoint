//! PINPOINT Tauri backend.
//!
//! Holds the active vault, the SQLite index, and a filesystem watcher. Exposes commands the
//! React frontend calls via `invoke`.

mod index;
mod query;
mod settings;
mod vault;

use notify::{RecursiveMode, Watcher};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

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

    *state.inner.lock().unwrap() = Some(VaultSession {
        root,
        conn,
        _watcher: watcher,
    });

    Ok(tree)
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

#[tauri::command]
fn delete_page(rel_path: String, state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let abs = session.root.join(&rel_path);
    std::fs::remove_file(&abs).map_err(err)?;
    index::index_file(&session.conn, &session.root, &abs).map_err(err)?;
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

#[tauri::command]
fn list_tasks(state: State<AppState>) -> Result<Vec<index::TaskRow>, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    index::all_tasks(&session.conn).map_err(err)
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
            write_page,
            create_page,
            delete_page,
            reindex,
            run_query,
            list_tasks,
            get_settings,
            save_settings
        ])
        .setup(|app| {
            // Ensure state exists; nothing else needed at startup.
            let _ = app.handle();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running PINPOINT");
}
