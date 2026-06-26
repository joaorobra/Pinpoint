//! PINPOINT Tauri backend.
//!
//! Holds the active vault, the SQLite index, and a filesystem watcher. Exposes commands the
//! React frontend calls via `invoke`.

#[cfg(target_os = "android")]
mod android_storage;
mod crypto;
mod index;
mod llm;
mod lock;
mod query;
mod recents;
mod settings;
mod themes;
mod vault;

// The filesystem watcher is desktop-only — `notify` relies on OS facilities
// (inotify/FSEvents/ReadDirectoryChangesW) that don't exist under Android's sandbox.
// On mobile we re-scan on app resume instead (see the frontend's resume handler).
#[cfg(desktop)]
use notify::{RecursiveMode, Watcher};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
// `Emitter` is only used by the desktop-only filesystem watcher (emits "vault-changed").
#[cfg(desktop)]
use tauri::Emitter;
use tauri::{Manager, State};

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
    /// Unlocked encryption keys for the current session, keyed by absolute scope path. A scope only
    /// appears here while unlocked; locking removes it (and the `Key`'s zeroizing drop scrubs it from
    /// memory). Survives vault switches deliberately — the app, not the vault session, owns unlock
    /// lifetime. Cleared on quit when the process memory is freed.
    keys: Mutex<HashMap<PathBuf, crypto::Key>>,
    /// Per-run cancellation handles for in-flight LLM CLI subprocesses. Independent of the vault
    /// session — an LLM run isn't tied to which vault is open.
    llm: llm::LlmState,
}

struct VaultSession {
    root: PathBuf,
    conn: Connection,
    /// Kept alive for the session so the watcher isn't dropped (desktop only).
    #[cfg(desktop)]
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
    open_vault_at(root, state, app)
}

/// Open the vault rooted at `root`: build/rebuild the SQLite index, spawn the
/// (desktop-only) file watcher, build the tree, record it as recently-opened, and
/// install it as the active `VaultSession`. Shared by `open_vault` (desktop folder
/// path) and the mobile app-owned-vault commands, which differ only in how `root`
/// is derived — everything past that point is identical across platforms.
fn open_vault_at(
    root: PathBuf,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<vault::TreeNode, String> {
    let conn = index::open(&root).map_err(err)?;
    // One-time, gated by a marker: back-fill a stable `id` into every page missing one so renames can
    // repair links for any page from the start. The full-vault read+rewrite runs once per vault; after
    // the marker exists we skip straight to indexing. New pages get their id on create/save.
    let id_marker = root.join(".pinpoint").join("ids-assigned");
    if !id_marker.exists() {
        let _ = index::assign_missing_ids(&root);
        let _ = std::fs::create_dir_all(root.join(".pinpoint"));
        let _ = std::fs::write(&id_marker, b"1");
    }
    // Incremental: re-parse only files whose mtime changed since the last index (near-instant on a
    // warm vault). The index is a rebuildable cache, so this is always safe.
    index::rebuild_incremental(&conn, &root).map_err(err)?;

    // Spawn a watcher that re-indexes touched files and notifies the frontend.
    // Desktop only — on mobile (Android) the OS watcher facilities are unavailable,
    // so the frontend re-scans on app resume instead.
    #[cfg(desktop)]
    let watcher = {
        let app_handle = app.clone();
        let watch_root = root.clone();
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
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
        watcher
    };

    let tree = vault::build_tree(&root).map_err(err)?;

    // Remember this vault as the most-recently-opened so the app can re-open it next launch.
    recents::record(&config_dir(&app), &root, now_ms());

    *state.inner.lock().unwrap() = Some(VaultSession {
        root,
        conn,
        #[cfg(desktop)]
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

// --- App-owned vaults (mobile) ---------------------------------------------------
//
// On Android there is no arbitrary filesystem and no folder picker that yields a
// usable path, so vaults live under the device's *public* Documents directory
// (`/storage/emulated/0/Documents/PINPOINT/<name>`). This keeps the `.md` files
// visible to every file manager and other apps, and surviving uninstall — at the
// cost of needing the "All files access" (MANAGE_EXTERNAL_STORAGE) runtime grant
// (see `external_storage_*` below). Because the root is still a real on-disk
// directory, the entire vault/index/query/lock core works unchanged — only the way a
// root is *chosen* differs from desktop. These commands are the choice surface:
// list existing app vaults, create one, and open one by name.

/// The folder that holds app-owned vaults.
///
/// - Android: the public `Documents/PINPOINT` dir, so notes are visible everywhere.
/// - Desktop (used only for dev/testing of these commands): the app local-data dir,
///   to avoid scribbling into the developer's real Documents folder.
fn app_vaults_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        // On Android the public external storage root is a stable, well-known path.
        Ok(PathBuf::from("/storage/emulated/0/Documents/PINPOINT"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let base = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("no app data dir: {e}"))?;
        Ok(base.join("vaults"))
    }
}

/// Reject vault names that aren't a single safe path segment (no separators, no
/// traversal, no empties) so a name can never escape the vaults dir.
fn validate_vault_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("vault name can't be empty".into());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("invalid vault name".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('\0') {
        return Err("vault name can't contain slashes".into());
    }
    Ok(())
}

/// List app-owned vaults (each immediate subfolder of the vaults dir), most-recent
/// first by directory mtime. Shaped like the recents list so the frontend can render
/// them with the same Start-screen UI. Empty (and creates nothing) before any vault exists.
#[tauri::command]
fn list_app_vaults(app: tauri::AppHandle) -> Result<Vec<recents::RecentVault>, String> {
    let dir = app_vaults_dir(&app)?;
    let mut out: Vec<recents::RecentVault> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let last_opened = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            out.push(recents::RecentVault {
                path: path.to_string_lossy().to_string(),
                name,
                last_opened,
            });
        }
    }
    out.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    Ok(out)
}

/// Create a new app-owned vault named `name` and open it. Errors if a vault with
/// that name already exists, so the UI can prompt for a different one.
#[tauri::command]
fn create_app_vault(
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<vault::TreeNode, String> {
    validate_vault_name(&name)?;
    let root = app_vaults_dir(&app)?.join(name.trim());
    if root.exists() {
        return Err(format!("a vault named \"{}\" already exists", name.trim()));
    }
    std::fs::create_dir_all(&root).map_err(|e| format!("couldn't create vault: {e}"))?;
    open_vault_at(root, state, app)
}

/// Open the app-owned vault named `name`. Errors (rather than silently creating) if
/// it doesn't exist, so a stale reference surfaces instead of spawning an empty vault.
#[tauri::command]
fn open_app_vault(
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<vault::TreeNode, String> {
    validate_vault_name(&name)?;
    let root = app_vaults_dir(&app)?.join(name.trim());
    if !root.is_dir() {
        return Err(format!("vault \"{}\" not found", name.trim()));
    }
    open_vault_at(root, state, app)
}

// --- "All files access" permission (Android MANAGE_EXTERNAL_STORAGE) --------------
//
// Writing to the public Documents dir on Android 11+ requires the special
// "All files access" grant. It can't be requested through the normal runtime-
// permission dialog — the user must toggle it on a system Settings screen. These
// two commands (a) report whether it's already granted and (b) open that screen.
// Both are implemented via JNI against the running Activity; on desktop they're
// no-ops that report "granted" so the same frontend flow is harmless there.

/// Whether the app currently holds "All files access".
/// Desktop: always true (no such concept). Android: `Environment.isExternalStorageManager()`.
#[tauri::command]
fn external_storage_granted() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        android_storage::is_manager().map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(true)
    }
}

/// Open the system "All files access" settings screen for this app so the user can
/// grant the permission. No-op on desktop. Returns immediately; the frontend should
/// re-check `external_storage_granted` when the app resumes.
#[tauri::command]
fn request_external_storage() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android_storage::open_settings().map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
    }
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
    // Guarantee a stable `id` in frontmatter so renames can repair links and the index can key on it.
    let mut frontmatter = frontmatter;
    vault::ensure_id(&mut frontmatter);
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
    // Stamp a fresh `id` so the page is rename-safe from the moment it's created.
    let mut frontmatter = serde_json::json!({});
    vault::ensure_id(&mut frontmatter);
    vault::write_doc(&abs, &frontmatter, &body).map_err(err)?;
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
        // A folder can hold many pages with no folder-prefix link in the index, so rebuild.
        index::rebuild(&session.conn, &session.root).map_err(err)?;
    } else {
        std::fs::remove_file(&abs).map_err(err)?;
        // Single file: drop just its rows instead of re-indexing the whole vault.
        index::delete_file(&session.conn, &session.root, &abs).map_err(err)?;
    }
    Ok(())
}

/// Soft delete: move a file or folder into `.trash`, recorded in the manifest for later restore.
#[tauri::command]
fn trash_page(rel_path: String, state: State<AppState>) -> Result<vault::TrashEntry, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    // Note whether the target is a single file *before* the move, so we can take the cheap
    // incremental index path for files and only rebuild for folders (which may hold many pages).
    let abs = session.root.join(&rel_path);
    let was_single_file = abs.is_file();
    let entry = vault::trash_move(&session.root, &rel_path, now_ms()).map_err(err)?;
    if was_single_file {
        index::delete_file(&session.conn, &session.root, &abs).map_err(err)?;
    } else {
        index::rebuild(&session.conn, &session.root).map_err(err)?;
    }
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
    let was_md = from.extension().and_then(|e| e.to_str()) == Some("md");
    std::fs::rename(&from, &to).map_err(err)?;

    // Leaf names (minus .md) before/after — wikilinks target the leaf, so a leaf change is what can
    // strand `[[links]]`.
    let leaf = |rel: &str| -> String {
        rel.rsplit('/').next().unwrap_or(rel).strip_suffix(".md").unwrap_or(rel).to_string()
    };
    let old_name = leaf(&from_rel);
    let new_name = leaf(&to_rel);

    if was_md {
        // Single-page rename/move: incrementally swap the moved file's rows (old path out, new in),
        // then repair backlinks if the visible name changed — no full rebuild.
        index::delete_file(&session.conn, &session.root, &from).map_err(err)?;
        index::index_file(&session.conn, &session.root, &to).map_err(err)?;
        if old_name != new_name {
            // Resolve the renamed page's stable id from its (now relocated) frontmatter so we rewrite
            // only links that point at *this* page.
            let page_id = vault::read_doc(&to)
                .ok()
                .and_then(|d| d.frontmatter.get(vault::ID_KEY).and_then(|v| v.as_str()).map(String::from));
            if let Some(id) = page_id {
                index::rename_links(&session.conn, &session.root, &id, &old_name, &new_name)
                    .map_err(err)?;
            }
        }
    } else {
        // Folder rename/move: many pages' paths change but their leaf names (hence wikilinks) don't,
        // so no link rewrite is needed — just bring the index's paths back in sync incrementally.
        index::rebuild_incremental(&session.conn, &session.root).map_err(err)?;
    }
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

/// Set (or clear) a task's priority by rewriting its `priority:: <level>` field in place.
/// `level` is `"high"`/`"medium"`/`"low"`, or `None` to remove any priority. `line` is the 0-based
/// body line index from the tasks index.
#[tauri::command]
fn set_task_priority(
    rel_path: String,
    line: usize,
    level: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let abs = session.root.join(&rel_path);
    let doc = vault::read_doc(&abs).map_err(err)?;

    let mut lines: Vec<String> = doc.body.lines().map(|s| s.to_string()).collect();
    let target = lines.get(line).ok_or("task line out of range")?;
    let new_line = index::set_task_priority_line(target, level.as_deref()).ok_or("not a task line")?;
    lines[line] = new_line;
    let mut body = lines.join("\n");
    if doc.body.ends_with('\n') {
        body.push('\n');
    }

    vault::write_doc(&abs, &doc.frontmatter, &body).map_err(err)?;
    index::index_file(&session.conn, &session.root, &abs).map_err(err)?;
    Ok(())
}

/// Move a task (the line at `line` plus all of its more-indented child lines) out of `from_rel` and
/// append it under a `## Tasks` heading in `to_rel`. The destination must already exist (the caller
/// creates it from the periodic template first). The moved block is re-based to the left margin so
/// it reads as a top-level task in its new home. Both files are re-indexed.
#[tauri::command]
fn move_task_block(
    from_rel: String,
    line: usize,
    to_rel: String,
    state: State<AppState>,
) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    if from_rel == to_rel {
        return Err("source and destination are the same page".into());
    }
    let from_abs = session.root.join(&from_rel);
    let to_abs = session.root.join(&to_rel);

    // --- Cut the block from the source. ---
    let from_doc = vault::read_doc(&from_abs).map_err(err)?;
    let src_lines: Vec<&str> = from_doc.body.lines().collect();
    if line >= src_lines.len() {
        return Err("task line out of range".into());
    }
    let len = index::task_block_extent(&src_lines, line);
    let base_indent = {
        let l = src_lines[line];
        l.len() - l.trim_start().len()
    };
    // Re-base indentation: drop up to `base_indent` leading whitespace chars from every row.
    let rebased: Vec<String> = src_lines[line..line + len]
        .iter()
        .map(|l| {
            let strip = l.chars().take(base_indent).take_while(|c| c.is_whitespace()).count();
            l.chars().skip(strip).collect::<String>()
        })
        .collect();

    let remaining: Vec<&str> = src_lines
        .iter()
        .enumerate()
        .filter(|(i, _)| *i < line || *i >= line + len)
        .map(|(_, s)| *s)
        .collect();
    let mut from_body = remaining.join("\n");
    if from_doc.body.ends_with('\n') {
        from_body.push('\n');
    }

    // --- Insert under "## Tasks" in the destination. ---
    let to_doc = vault::read_doc(&to_abs).map_err(|_| format!("destination missing: {to_rel}"))?;
    let mut to_lines: Vec<String> = to_doc.body.lines().map(|s| s.to_string()).collect();
    let tasks_at = to_lines
        .iter()
        .position(|l| l.trim().eq_ignore_ascii_case("## Tasks") || l.trim().eq_ignore_ascii_case("# Tasks"));
    let insert_at = match tasks_at {
        Some(h) => {
            // After the heading's existing content: scan to the next heading or EOF.
            let mut j = h + 1;
            while j < to_lines.len() && !to_lines[j].trim_start().starts_with('#') {
                j += 1;
            }
            j
        }
        None => {
            if !to_lines.is_empty() && !to_lines.last().map(|l| l.trim().is_empty()).unwrap_or(true) {
                to_lines.push(String::new());
            }
            to_lines.push("## Tasks".to_string());
            to_lines.len()
        }
    };
    for (k, bl) in rebased.into_iter().enumerate() {
        to_lines.insert(insert_at + k, bl);
    }
    let mut to_body = to_lines.join("\n");
    if !to_body.ends_with('\n') {
        to_body.push('\n');
    }

    // --- Persist both, then re-index both. ---
    vault::write_doc(&from_abs, &from_doc.frontmatter, &from_body).map_err(err)?;
    vault::write_doc(&to_abs, &to_doc.frontmatter, &to_body).map_err(err)?;
    index::index_file(&session.conn, &session.root, &from_abs).map_err(err)?;
    index::index_file(&session.conn, &session.root, &to_abs).map_err(err)?;
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

// ---- Locking (encryption-at-rest) ---------------------------------------------------------------
// A "scope" is a folder marked by `.pinpoint-lock.json` (see lock.rs). Phase 1 targets the whole
// vault (scope == vault root) but the commands take a vault-relative `scope_rel` so folder-level
// locking in a later phase reuses them unchanged ("" == vault root).
//
// Locking sweeps every `.md` under the scope into a `<name>.md.enc` ciphertext and deletes the
// plaintext; the index rows for the scope are dropped so locked content isn't searchable while
// locked. Unlocking reverses the sweep into memory-held plaintext and caches the key for the session.

/// Resolve a vault-relative scope path to an absolute one, guarding against escaping the vault.
fn scope_abs(root: &Path, scope_rel: &str) -> Result<PathBuf, String> {
    let rel = scope_rel.trim_start_matches(['/', '\\']);
    let abs = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    // Reject traversal outside the vault.
    if !abs.starts_with(root) || rel.contains("..") {
        return Err("invalid scope path".into());
    }
    if !abs.is_dir() {
        return Err(format!("not a folder: {scope_rel}"));
    }
    Ok(abs)
}

/// Status of a scope for the UI: whether it's an encrypted scope at all, and if so whether it's
/// currently unlocked in this session.
#[derive(serde::Serialize)]
struct LockStatus {
    is_locked_scope: bool,
    unlocked: bool,
    hint: Option<String>,
}

/// Report whether a folder/vault is an encrypted scope and whether it's unlocked right now.
#[tauri::command]
fn lock_status(scope_rel: String, state: State<AppState>) -> Result<LockStatus, String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let abs = scope_abs(&session.root, &scope_rel)?;
    let is_scope = lock::is_locked_scope(&abs);
    let hint = if is_scope {
        lock::read_manifest(&abs).ok().and_then(|m| m.hint)
    } else {
        None
    };
    let unlocked = state.keys.lock().unwrap().contains_key(&abs);
    Ok(LockStatus {
        is_locked_scope: is_scope,
        unlocked,
        hint,
    })
}

/// Encrypt a folder/vault with a password: create the manifest, rewrite every `.md` under it as a
/// `.md.enc` blob, delete the plaintext, and drop the scope's rows from the index. The key is held
/// in memory afterwards so the just-locked scope is immediately usable this session.
#[tauri::command]
fn lock_vault(
    scope_rel: String,
    password: String,
    hint: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    if password.is_empty() {
        return Err("password must not be empty".into());
    }
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let scope = scope_abs(&session.root, &scope_rel)?;
    if lock::is_locked_scope(&scope) {
        return Err("this folder is already locked".into());
    }

    let dek = lock::create_scope(&scope, &password, hint).map_err(err)?;

    // Sweep plaintext → ciphertext. On any failure we bail; partial state is possible but the
    // manifest + already-encrypted files remain openable with the password, so no data is lost.
    for md in vault::iter_markdown(&scope) {
        let rel_in_scope = md
            .strip_prefix(&scope)
            .unwrap_or(&md)
            .to_string_lossy()
            .replace('\\', "/");
        let plaintext = std::fs::read(&md).map_err(err)?;
        let blob = lock::encrypt_file(&dek, &rel_in_scope, &plaintext).map_err(err)?;
        let enc_path = md.with_file_name(lock::enc_name(
            &md.file_name().unwrap().to_string_lossy(),
        ));
        std::fs::write(&enc_path, &blob).map_err(err)?;
        std::fs::remove_file(&md).map_err(err)?;
        index::delete_file(&session.conn, &session.root, &md).map_err(err)?;
    }

    state.keys.lock().unwrap().insert(scope, dek);
    Ok(())
}

/// Unlock an encrypted scope with a password. Verifies the password, decrypts every `.md.enc` back
/// to plaintext `.md` on disk for this session, re-indexes them, and caches the key. Wrong password
/// is rejected before any file is touched.
#[tauri::command]
fn unlock_vault(
    scope_rel: String,
    password: String,
    state: State<AppState>,
) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let scope = scope_abs(&session.root, &scope_rel)?;
    if !lock::is_locked_scope(&scope) {
        return Err("this folder is not locked".into());
    }

    let dek = lock::unlock_scope(&scope, &password).map_err(err)?;

    // Decrypt every `.enc` blob back to its plaintext `.md`.
    for entry in walk_enc_files(&scope) {
        let blob = std::fs::read(&entry).map_err(err)?;
        let enc_leaf = entry.file_name().unwrap().to_string_lossy().to_string();
        let plain_leaf = lock::plain_name(&enc_leaf).ok_or("not an .enc file")?;
        let plain_path = entry.with_file_name(&plain_leaf);
        let rel_in_scope = plain_path
            .strip_prefix(&scope)
            .unwrap_or(&plain_path)
            .to_string_lossy()
            .replace('\\', "/");
        let plaintext = lock::decrypt_file(&dek, &rel_in_scope, &blob).map_err(err)?;
        std::fs::write(&plain_path, &plaintext).map_err(err)?;
        std::fs::remove_file(&entry).map_err(err)?;
        index::index_file(&session.conn, &session.root, &plain_path).map_err(err)?;
    }

    state.keys.lock().unwrap().insert(scope, dek);
    Ok(())
}

/// Re-encrypt a scope's plaintext and forget its key (the manual "lock now" action, and what the
/// inactivity timeout calls). Requires the key to be currently held (scope must be unlocked).
#[tauri::command]
fn relock_vault(scope_rel: String, state: State<AppState>) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let scope = scope_abs(&session.root, &scope_rel)?;
    // Take the key out of the cache (drops/zeroizes it at end of scope).
    let dek = state
        .keys
        .lock()
        .unwrap()
        .remove(&scope)
        .ok_or("scope is not unlocked")?;

    for md in vault::iter_markdown(&scope) {
        let rel_in_scope = md
            .strip_prefix(&scope)
            .unwrap_or(&md)
            .to_string_lossy()
            .replace('\\', "/");
        let plaintext = std::fs::read(&md).map_err(err)?;
        let blob = lock::encrypt_file(&dek, &rel_in_scope, &plaintext).map_err(err)?;
        let enc_path = md.with_file_name(lock::enc_name(
            &md.file_name().unwrap().to_string_lossy(),
        ));
        std::fs::write(&enc_path, &blob).map_err(err)?;
        std::fs::remove_file(&md).map_err(err)?;
        index::delete_file(&session.conn, &session.root, &md).map_err(err)?;
    }
    Ok(())
}

/// Change a scope's password by re-wrapping its DEK — no files are re-encrypted. Requires the current
/// password (not just an unlocked session) to prove authorization.
#[tauri::command]
fn change_lock_password(
    scope_rel: String,
    old_password: String,
    new_password: String,
    state: State<AppState>,
) -> Result<(), String> {
    if new_password.is_empty() {
        return Err("new password must not be empty".into());
    }
    let guard = state.inner.lock().unwrap();
    let session = guard.as_ref().ok_or("no vault open")?;
    let scope = scope_abs(&session.root, &scope_rel)?;
    lock::change_password(&scope, &old_password, &new_password).map_err(err)
}

/// Collect every `.enc` file under a scope (skips dot-folders, like the markdown walker).
fn walk_enc_files(scope: &Path) -> Vec<PathBuf> {
    walkdir::WalkDir::new(scope)
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
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some(lock::ENC_EXT))
        .collect()
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

// --- LLM CLI integration -----------------------------------------------------------
//
// Drive the official `claude`/`gemini`/`codex` CLIs as subprocesses. The user's subscription
// login lives entirely inside the CLI (we never read its credentials); we just spawn the binary
// headlessly and stream its output. See src-tauri/src/llm.rs and docs/llm-cli-integration-plan.md.

/// Which CLIs are installed + logged in, for the provider-detection settings UI.
#[tauri::command]
fn llm_providers() -> Vec<llm::ProviderStatus> {
    llm::detect_all()
}

/// Start an LLM run. Streams normalized events to the `llm://<run_id>` event channel and
/// resolves when the subprocess exits. Not vault-gated — chatting doesn't require an open vault.
#[tauri::command]
async fn llm_run(
    req: llm::RunRequest,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    llm::run(app, &state.llm, req).await
}

/// Cancel an in-flight run by id (kills the subprocess). No-op if it already finished.
#[tauri::command]
fn llm_cancel(run_id: String, state: State<AppState>) {
    llm::cancel(&state.llm, &run_id);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is required on desktop (the updater plugin is appended below); on mobile that
    // block is compiled out, so silence the otherwise-spurious unused-mut lint there.
    #[cfg_attr(mobile, allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init());

    // The updater plugin only exists on desktop targets.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
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
            set_task_priority,
            move_task_block,
            get_settings,
            save_settings,
            lock_status,
            lock_vault,
            unlock_vault,
            relock_vault,
            change_lock_password,
            list_themes,
            read_theme,
            write_theme,
            delete_theme,
            rename_theme,
            seed_themes,
            list_recent_vaults,
            list_app_vaults,
            create_app_vault,
            open_app_vault,
            external_storage_granted,
            request_external_storage,
            llm_providers,
            llm_run,
            llm_cancel
        ])
        .setup(|app| {
            // Ensure state exists; nothing else needed at startup.
            let _ = app.handle();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running PINPOINT");
}
