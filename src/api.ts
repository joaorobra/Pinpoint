import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AssetData, DbSchema, ParsedDoc, QueryResult, RecentVault, Settings, TaskRow, TreeNode, TrashEntry } from "./types";
import { assetKindFor } from "./types";
import {
  webApi,
  pickVaultFolderWeb,
  isWebFsSupported,
  listRecentVaultsWeb,
  openRecentVaultWeb,
} from "./fsa-vault";

// PINPOINT runs in two hosts that share this one frontend:
//   - the Tauri desktop app, backed by a Rust filesystem + SQLite index (via `invoke`);
//   - a plain browser, backed by the File System Access API (see fsa-vault.ts).
// We pick the backend at runtime so neither path's APIs are invoked in the wrong host.

/** True when running inside the Tauri webview (its globals are injected on the window). */
function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Whether the current host can open a local vault at all (Tauri, or a Chromium browser). */
export function canOpenVault(): boolean {
  return isTauri() || isWebFsSupported();
}

export async function pickVaultFolder(): Promise<string | null> {
  if (isTauri()) {
    const selected = await open({ directory: true, multiple: false, title: "Open PINPOINT vault" });
    return typeof selected === "string" ? selected : null;
  }
  return pickVaultFolderWeb();
}

/** Recently-opened vaults, most-recent first. Empty before any vault is opened. */
export async function listRecentVaults(): Promise<RecentVault[]> {
  if (isTauri()) {
    return invoke<RecentVault[]>("list_recent_vaults");
  }
  return listRecentVaultsWeb();
}

/**
 * Resolve a recent vault's id to something `api.openVault` accepts:
 *  - desktop: the id IS the absolute path, returned as-is;
 *  - browser: re-grants permission on the persisted handle and returns the id.
 * Returns null if the vault can no longer be opened (handle gone).
 */
export async function resolveRecentVault(id: string): Promise<string | null> {
  if (isTauri()) return id; // the id is the path; open_vault re-validates it exists
  return openRecentVaultWeb(id, Date.now());
}

// Native implementation (Tauri commands).
const tauriApi = {
  openVault: (path: string) => invoke<TreeNode>("open_vault", { path }),
  getTree: () => invoke<TreeNode>("get_tree"),
  readPage: (relPath: string) => invoke<ParsedDoc>("read_page", { relPath }),
  readAsset: async (relPath: string): Promise<AssetData> => {
    // The Rust side returns a base64 `data:` URL; both <img> and <iframe> render it directly.
    const dataUrl = await invoke<string>("read_asset", { relPath });
    const dot = relPath.lastIndexOf(".");
    const kind = assetKindFor(dot >= 0 ? relPath.slice(dot + 1) : "");
    const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
    if (kind === "text") {
      // Decode the base64 payload back to text for the text viewer.
      const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      return { kind, url: new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))), mime };
    }
    return { kind, url: dataUrl, mime };
  },
  writePage: (relPath: string, frontmatter: Record<string, unknown>, body: string) =>
    invoke<void>("write_page", { relPath, frontmatter, body }),
  createPage: (relPath: string, body: string) => invoke<void>("create_page", { relPath, body }),
  /** Create a database folder (`.pinpoint-db.json` schema) at `relPath`; `name` seeds the schema. */
  createDatabase: (relPath: string, name: string) =>
    invoke<void>("create_database", { relPath, name }),
  /** Read a database folder's schema (`.pinpoint-db.json`). */
  readDbSchema: (relPath: string) => invoke<DbSchema>("read_db_schema", { relPath }),
  /** Persist a database folder's schema. */
  writeDbSchema: (relPath: string, schema: DbSchema) =>
    invoke<void>("write_db_schema", { relPath, schema }),
  deletePage: (relPath: string) => invoke<void>("delete_page", { relPath }),
  trashPage: (relPath: string) => invoke<TrashEntry>("trash_page", { relPath }),
  listTrash: () => invoke<TrashEntry[]>("list_trash"),
  restoreTrash: (id: string) => invoke<string>("restore_trash", { id }),
  purgeTrash: (id: string) => invoke<void>("purge_trash", { id }),
  emptyTrash: () => invoke<void>("empty_trash"),
  renamePath: (fromRel: string, toRel: string) => invoke<void>("rename_path", { fromRel, toRel }),
  reindex: () => invoke<number>("reindex"),
  runQuery: (dsl: string) => invoke<QueryResult>("run_query", { dsl }),
  listTasks: () => invoke<TaskRow[]>("list_tasks"),
  /**
   * Toggle a task's done state by rewriting its source line. `occurrence` is null for a plain task
   * (flips its checkbox) or an ISO date for one occurrence of a recurring task (toggles that date in
   * the line's `✅ …` completed list).
   */
  toggleTask: (relPath: string, line: number, occurrence: string | null) =>
    invoke<void>("toggle_task", { relPath, line, occurrence }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (s: Settings) => invoke<void>("save_settings", { s }),
};

// One object, two backends. Shapes are identical so callers don't branch.
const backend = isTauri() ? tauriApi : webApi;

// ---- Page timestamps (created / last-edited) ----
// Every page — a database row or a plain note — carries `created` and `updated` ISO-8601
// datetimes in its frontmatter. We stamp them here at the shared API boundary rather than in
// either host backend, so a single implementation covers desktop + web and *every* caller
// (the editor's /page command, periodic notes, duplicate, DB rows, …). The fields are kept out
// of the DB column schema unless a database opts in (Created time / Last edited time columns),
// but the data is always present regardless of whether any column surfaces it.
export const CREATED_KEY = "created";
export const UPDATED_KEY = "updated";

/** Stamp `created` (only if absent) and always-fresh `updated` onto a frontmatter map. */
function stampTimestamps(
  fm: Record<string, unknown>,
  { created }: { created: boolean }
): Record<string, unknown> {
  const now = new Date().toISOString();
  const out = { ...fm };
  if (created && !out[CREATED_KEY]) out[CREATED_KEY] = now;
  out[UPDATED_KEY] = now;
  return out;
}

// One object, two backends, wrapped so every page write maintains its timestamps.
export const api = {
  ...backend,
  writePage: (relPath: string, frontmatter: Record<string, unknown>, body: string) =>
    backend.writePage(relPath, stampTimestamps(frontmatter, { created: true }), body),
  createPage: async (relPath: string, body: string) => {
    // Seed brand-new pages with both timestamps. `create_page` only takes a body, so we create
    // it (clobber-safe) and then immediately write the stamped frontmatter back.
    await backend.createPage(relPath, body);
    await backend.writePage(relPath, stampTimestamps({}, { created: true }), body);
  },
};
