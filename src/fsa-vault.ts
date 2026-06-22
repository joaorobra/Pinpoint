// Browser data layer — File System Access API.
//
// The native app talks to a Rust/Tauri backend (filesystem + SQLite index). The browser has neither,
// so this module reimplements the SAME contract on top of `window.showDirectoryPicker()`:
//   - the user grants read/write access to a real local folder (their vault);
//   - we hold the directory handle and walk it on demand;
//   - frontmatter parsing, task extraction and the query DSL are computed in-memory.
// SQLite is just a cache in the native build, so emulating it in memory is faithful, not a shortcut.
//
// Supported in Chromium browsers (Chrome/Edge/Opera). Firefox/Safari lack the API — see isWebFsSupported.

import type { AssetData, DbSchema, ParsedDoc, QueryResult, RecentVault, Settings, TaskRow, TreeNode, TrashEntry } from "./types";
import { DEFAULT_SETTINGS, assetKindFor } from "./types";

/* ---------------------------------------------------------------------------
   Minimal File System Access typings (avoids adding @types/wicg-file-system-access).
   Only the members we actually use are declared.
--------------------------------------------------------------------------- */
interface FsHandle {
  kind: "file" | "directory";
  name: string;
}
interface FsFileHandle extends FsHandle {
  kind: "file";
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStreamLike>;
}
interface FsDirHandle extends FsHandle {
  kind: "directory";
  entries(): AsyncIterableIterator<[string, FsFileHandle | FsDirHandle]>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  // Permission API — handles persisted across sessions need re-granting on reuse.
  queryPermission?(opts?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(opts?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
}
interface FileSystemWritableFileStreamLike {
  write(data: string | BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
}
declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<FsDirHandle>;
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

/** True when running inside a browser that supports the File System Access API. */
export function isWebFsSupported(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

/* ---------------------------------------------------------------------------
   In-memory page model (mirrors the Rust SQLite `pages`/`fields`/`tags`/`tasks`).
--------------------------------------------------------------------------- */
interface Page {
  rel_path: string; // forward slashes, includes `.md`
  name: string; // title = file name without `.md`
  folder: string; // parent rel path ("" at root)
  frontmatter: Record<string, unknown>;
  body: string;
}

let rootDir: FsDirHandle | null = null;
let rootName = "vault";

// rel_path -> Page cache, rebuilt by scan(). Source of truth is always the files themselves.
let pageCache = new Map<string, Page>();
// Set of directory rel_paths that are databases (contain `.pinpoint-db.json`).
let dbDirs = new Set<string>();

function ensureRoot(): FsDirHandle {
  if (!rootDir) throw new Error("No vault is open. Pick a folder first.");
  return rootDir;
}

/* ---------------------------------------------------------------------------
   Directory traversal helpers.
--------------------------------------------------------------------------- */

/** Resolve a directory handle for a "/"-separated rel path (""/"." = root), optionally creating it. */
async function dirAt(relDir: string, create = false): Promise<FsDirHandle> {
  let dir = ensureRoot();
  const parts = relDir.split("/").filter((p) => p && p !== ".");
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

/** Resolve a file handle for a "/"-separated rel path, optionally creating it + parent dirs. */
async function fileAt(relPath: string, create = false): Promise<FsFileHandle> {
  const slash = relPath.lastIndexOf("/");
  const parentRel = slash >= 0 ? relPath.slice(0, slash) : "";
  const fileName = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  const dir = await dirAt(parentRel, create);
  return dir.getFileHandle(fileName, { create });
}

/* ---------------------------------------------------------------------------
   YAML frontmatter (scalars + flow/block lists). Matches the gray_matter subset
   the index relies on — deep nesting isn't needed for queries.
--------------------------------------------------------------------------- */

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

function parseFlowList(raw: string): unknown[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((s) => parseScalar(s));
}

/** Split a markdown file into [frontmatter, body], parsing a leading `---` YAML block. */
function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const norm = text.replace(/\r\n/g, "\n");
  // Frontmatter must start on the very first line.
  if (!norm.startsWith("---\n")) return { frontmatter: {}, body: norm };
  const end = norm.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: norm };
  const yaml = norm.slice(4, end + 1);
  // Body is everything after the closing fence line.
  let rest = norm.slice(end + 4);
  rest = rest.replace(/^[^\n]*\n/, ""); // drop remainder of the "---" line
  rest = rest.replace(/^\n+/, ""); // drop blank lines after the fence

  const fm: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const valRaw = m[2];
    if (valRaw.trim() === "") {
      // Possible block list: subsequent "  - item" lines.
      const items: unknown[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(parseScalar(lines[j].replace(/^\s+-\s+/, "")));
        j++;
      }
      if (items.length) {
        fm[key] = items;
        i = j - 1;
      } else {
        fm[key] = "";
      }
    } else if (valRaw.trim().startsWith("[")) {
      fm[key] = parseFlowList(valRaw);
    } else {
      fm[key] = parseScalar(valRaw);
    }
  }
  return { frontmatter: fm, body: rest };
}

function scalarToYaml(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  // Quote if it could be misread as a non-string scalar or contains YAML-significant chars.
  if (s === "" || /[:#\[\]{}",]|^\s|\s$|^(true|false|null|~|-?\d)/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/** Serialize frontmatter + body back to a file, omitting the `---` block when empty (Rust parity). */
function serializeDoc(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return body;
  const lines: string[] = [];
  for (const k of keys) {
    const v = frontmatter[k];
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${scalarToYaml(item)}`);
    } else {
      lines.push(`${k}: ${scalarToYaml(v)}`);
    }
  }
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

/* ---------------------------------------------------------------------------
   Tags + tasks extraction (mirrors index.rs).
--------------------------------------------------------------------------- */

/** Inline `#tag` tokens: # then [A-Za-z0-9_/-], preceded by start or whitespace. */
function extractTags(text: string): string[] {
  const out: string[] = [];
  const re = /(^|\s)#([A-Za-z0-9_/-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[2]);
  return out;
}

// Space after `]` is optional and the body may be empty, so `- [ ]` and `- [x]done` count. The
// same rule is mirrored in `toggleTaskLine` below and the Rust indexer/toggle (`parse_task_line` /
// `toggle_task_line`) — they must agree, or a line gets indexed as a task but the toggle rejects it
// with "not a task line".
const TASK_RE = /^\s*[-*]\s\[([ xX])\]\s?(.*)$/;
// Match a marker then everything up to the next field marker, mirroring index.rs `find_field`.
const DUE_RE = /(?:📅|due::)\s*([^📅🔁⏳✅]+)/;
const RRULE_RE = /(?:🔁|repeat::)\s*([^📅🔁⏳✅]+)/;
// The `✅ <iso>,<iso>` completed-occurrences list runs to end-of-line.
const DONE_DATES_RE = /✅\s*([^📅🔁⏳]+)/;

/** Parse the comma-separated ISO dates out of a `✅ …` value. */
function parseDoneDates(text: string): string[] {
  const raw = DONE_DATES_RE.exec(text)?.[1] ?? "";
  return raw.split(",").map((d) => d.trim()).filter(Boolean);
}

/**
 * Rewrite a task line to reflect a toggle. Mirror of `index::toggle_task_line` in the Rust backend
 * so both hosts behave identically.
 *  - `occurrence == null` (plain task): flip the `[ ]`⇄`[x]` checkbox.
 *  - `occurrence == <iso>` (a recurring occurrence): leave the checkbox open and add/remove that
 *    date from the trailing `✅ <iso>,<iso>` list.
 * Returns the new line, or null if the line isn't a task.
 */
export function toggleTaskLine(line: string, occurrence: string | null): string | null {
  const m = line.match(/^(\s*)([-*]\s)\[([ xX])\]\s?(.*)$/);
  if (!m) return null;
  const [, indent, bullet, mark, body] = m;

  if (occurrence == null) {
    const newMark = mark.toLowerCase() === "x" ? " " : "x";
    return `${indent}${bullet}[${newMark}] ${body}`;
  }

  // Split off any existing `✅ …` segment; everything before it is preserved verbatim.
  const idx = body.indexOf("✅");
  const head = (idx >= 0 ? body.slice(0, idx) : body).trimEnd();
  const dates = idx >= 0
    ? body.slice(idx + "✅".length).split(",").map((d) => d.trim()).filter(Boolean)
    : [];

  const at = dates.indexOf(occurrence);
  if (at >= 0) dates.splice(at, 1);
  else { dates.push(occurrence); dates.sort(); }

  return dates.length
    ? `${indent}${bullet}[ ] ${head} ✅ ${dates.join(",")}`
    : `${indent}${bullet}[ ] ${head}`;
}

/**
 * Normalize a due value the way index.rs does: keep only a leading `YYYY-MM-DD` so a fused marker
 * (`📅 2026-06-21🔁…`) or trailing text can't poison the stored date.
 */
function normalizeDue(raw: string | undefined): string | null {
  if (!raw) return null;
  const token = raw.trim().split(/\s+/)[0] ?? "";
  const ymd = token.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  return token || null;
}

function extractTasks(relPath: string, body: string): TaskRow[] {
  const rows: TaskRow[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_RE);
    if (!m) continue;
    const done = m[1].toLowerCase() === "x";
    const text = m[2];
    const due = normalizeDue(DUE_RE.exec(text)?.[1]);
    const rrule = RRULE_RE.exec(text)?.[1]?.trim() || null;
    const tags = extractTags(text);
    const doneDates = parseDoneDates(text);
    rows.push({
      rel_path: relPath,
      line: i,
      text,
      done,
      due,
      rrule,
      tags: tags.length ? tags.join(",") : null,
      done_dates: doneDates.length ? doneDates.join(",") : null,
    });
  }
  return rows;
}

/** Frontmatter `tags` (string or list) plus inline body tags, deduped. */
function pageTags(p: Page): Set<string> {
  const set = new Set<string>();
  const fmTags = p.frontmatter["tags"];
  if (typeof fmTags === "string") fmTags.split(/[,\s]+/).filter(Boolean).forEach((t) => set.add(t.replace(/^#/, "")));
  else if (Array.isArray(fmTags)) fmTags.forEach((t) => set.add(String(t).replace(/^#/, "")));
  extractTags(p.body).forEach((t) => set.add(t));
  return set;
}

/* ---------------------------------------------------------------------------
   Scan the vault into the in-memory cache + build the tree.
--------------------------------------------------------------------------- */

async function readFileText(h: FsFileHandle): Promise<string> {
  const f = await h.getFile();
  return f.text();
}

/** Recursively walk a directory, populating pageCache + dbDirs and returning its TreeNode. */
async function walk(dir: FsDirHandle, relDir: string): Promise<TreeNode> {
  const childDirs: TreeNode[] = [];
  const childFiles: TreeNode[] = [];
  let isDatabase = false;

  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(".")) {
      if (name === ".pinpoint-db.json") isDatabase = true;
      continue; // skip all dotfiles/dirs, like the Rust walker
    }
    const childRel = relDir ? `${relDir}/${name}` : name;
    if (handle.kind === "directory") {
      childDirs.push(await walk(handle as FsDirHandle, childRel));
    } else if (name.toLowerCase().endsWith(".md")) {
      const text = await readFileText(handle as FsFileHandle);
      const { frontmatter, body } = splitFrontmatter(text);
      pageCache.set(childRel, {
        rel_path: childRel,
        name: name.replace(/\.md$/i, ""),
        folder: relDir,
        frontmatter,
        body,
      });
      childFiles.push({ name, rel_path: childRel, is_dir: false, is_database: false, ext: "", children: [] });
    } else {
      // Non-markdown file (PDF, image, …): surface it in the tree, tagged with its extension.
      const dot = name.lastIndexOf(".");
      const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
      if (ext) {
        childFiles.push({ name, rel_path: childRel, is_dir: false, is_database: false, ext, children: [] });
      }
    }
  }

  if (isDatabase) dbDirs.add(relDir);
  // Dirs first, then files; each alphabetical (locale-agnostic) — matches Rust sort.
  childDirs.sort((a, b) => a.name.localeCompare(b.name));
  childFiles.sort((a, b) => a.name.localeCompare(b.name));

  return {
    name: relDir ? relDir.split("/").pop()! : rootName,
    rel_path: relDir,
    is_dir: true,
    is_database: isDatabase,
    ext: "",
    children: [...childDirs, ...childFiles],
  };
}

async function scan(): Promise<TreeNode> {
  pageCache = new Map();
  dbDirs = new Set();
  return walk(ensureRoot(), "");
}

/* ---------------------------------------------------------------------------
   Query DSL — TABLE/LIST/TASK ... FROM ... WHERE ... SORT ... LIMIT.
   Evaluated against pageCache. Mirrors query.rs semantics.
--------------------------------------------------------------------------- */

interface Cond {
  field: string;
  op: string;
  value: unknown;
}

function pageFieldValue(p: Page, field: string): unknown {
  switch (field) {
    case "file.name":
    case "title":
      return p.name;
    case "file.folder":
    case "folder":
      return p.folder;
    case "file.path":
    case "path":
      return p.rel_path;
    default:
      return p.frontmatter[field];
  }
}

function parseQueryValue(raw: string): unknown {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function compare(a: unknown, op: string, b: unknown): boolean {
  if (op === "contains") return String(a ?? "").toLowerCase().includes(String(b ?? "").toLowerCase());
  if (op === "=") return String(a ?? "") === String(b ?? "");
  if (op === "!=") return String(a ?? "") !== String(b ?? "");
  // Ordering: numeric when both sides are numbers, else lexical.
  const an = Number(a), bn = Number(b);
  const numeric = a !== "" && b !== "" && !Number.isNaN(an) && !Number.isNaN(bn);
  const x = numeric ? an : String(a ?? "");
  const y = numeric ? bn : String(b ?? "");
  switch (op) {
    case ">": return x > y;
    case "<": return x < y;
    case ">=": return x >= y;
    case "<=": return x <= y;
    default: return false;
  }
}

function runQueryDsl(dsl: string): QueryResult {
  const flat = dsl.replace(/\s+/g, " ").trim();
  // Split into clause segments while keeping order.
  const kindMatch = flat.match(/^(TABLE|LIST|TASK)\b/i);
  if (!kindMatch) throw new Error(`Query must start with TABLE, LIST or TASK`);
  const kind = kindMatch[1].toUpperCase() as "TABLE" | "LIST" | "TASK";

  const fromMatch = flat.match(/\bFROM\s+(#[\w/-]+|"[^"]*"|'[^']*')/i);
  const whereMatch = flat.match(/\bWHERE\s+(.+?)(?=\s+SORT\b|\s+LIMIT\b|$)/i);
  const sortMatch = flat.match(/\bSORT\s+([\w.]+)(\s+(ASC|DESC))?/i);
  const limitMatch = flat.match(/\bLIMIT\s+(\d+)/i);

  // Columns: only meaningful for TABLE, between the kind and the first clause keyword.
  let columns: string[] = [];
  if (kind === "TABLE") {
    const colsPart = flat
      .slice(kindMatch[0].length)
      .replace(/\b(FROM|WHERE|SORT|LIMIT)\b.*$/i, "")
      .trim();
    columns = colsPart ? colsPart.split(",").map((c) => c.trim()).filter(Boolean) : ["file.name"];
  }

  // FROM
  let rows = [...pageCache.values()];
  if (fromMatch) {
    const src = fromMatch[1];
    if (src.startsWith("#")) {
      const tag = src.slice(1);
      rows = rows.filter((p) => pageTags(p).has(tag));
    } else {
      const folder = src.replace(/^["']|["']$/g, "");
      rows = rows.filter((p) => p.rel_path.startsWith(folder));
    }
  }

  const parseCond = (s: string): Cond | null => {
    const m = s.trim().match(/^([\w.]+)\s*(>=|<=|!=|=|>|<|contains)\s*(.+)$/i);
    if (!m) return null;
    return { field: m[1], op: m[2].toLowerCase(), value: parseQueryValue(m[3]) };
  };

  // Evaluate the WHERE expr (OR of AND-groups) one cond at a time via `evalCond`. An unparsable
  // cond, or one `evalCond` returns undefined for, is treated as `true` — matching the lenient
  // behaviour both the page and task paths want.
  const matchesWhere = (evalCond: (c: Cond) => boolean | undefined): boolean => {
    if (!whereMatch) return true;
    const orGroups = whereMatch[1].split(/\s+OR\s+/i).map((g) => g.split(/\s+AND\s+/i));
    return orGroups.some((andGroup) =>
      andGroup.every((cs) => {
        const c = parseCond(cs);
        if (!c) return true;
        const r = evalCond(c);
        return r === undefined ? true : r;
      })
    );
  };

  // TASK kind: rows are tasks, not pages. FROM scopes by the task LINE (its own tags / source path)
  // and WHERE filters task fields — mirroring query.rs's `tasks`-table path, not the pages path.
  if (kind === "TASK") {
    let tasks: TaskRow[] = [];
    for (const p of pageCache.values()) tasks.push(...extractTasks(p.rel_path, p.body));

    if (fromMatch) {
      const src = fromMatch[1];
      if (src.startsWith("#")) {
        const tag = src.slice(1);
        tasks = tasks.filter((t) => (t.tags ? t.tags.split(",") : []).includes(tag));
      } else {
        const folder = src.replace(/^["']|["']$/g, "");
        tasks = tasks.filter((t) => t.rel_path.startsWith(folder));
      }
    }

    // Resolve a task field for WHERE, matching `task_field_sql`'s supported fields. `tag` needs
    // membership semantics rather than scalar compare, so it short-circuits via taskCond below.
    const taskField = (t: TaskRow, field: string): unknown => {
      switch (field) {
        case "done": return t.done;
        case "recurring": return t.rrule != null;
        case "due": return t.due ?? "";
        case "text": return t.text;
        case "file.path":
        case "path": return t.rel_path;
        default: return undefined;
      }
    };
    // Per-task WHERE: `tag = #x`/`tag contains x` test membership of the line's tags; everything
    // else compares scalars. Returns undefined when a cond doesn't apply, so the AND-group treats
    // it leniently (same as the page path).
    const taskCond = (t: TaskRow, c: Cond): boolean | undefined => {
      if (c.field === "tag") {
        const want = String(c.value ?? "").replace(/^#/, "").toLowerCase();
        const have = (t.tags ?? "").split(",").filter(Boolean).map((x) => x.toLowerCase());
        const present = have.includes(want);
        return c.op === "!=" ? !present : present;
      }
      return compare(taskField(t, c.field), c.op, c.value);
    };
    tasks = tasks.filter((t) => matchesWhere((c) => taskCond(t, c)));

    tasks.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
    return {
      kind: "task",
      columns: ["text", "due", "done", "recurring"],
      rows: tasks.map((t) => ({
        "file.path": t.rel_path,
        // Source line index — required so checkbox toggles rewrite the right line. Without it the
        // client falls back to line 0 and the toggle fails with "not a task line".
        line: t.line,
        text: t.text,
        due: t.due,
        done: t.done,
        rrule: t.rrule,
        recurring: t.rrule != null,
        tags: t.tags ?? "",
        done_dates: t.done_dates ?? "",
      })),
    };
  }

  // WHERE for pages.
  if (whereMatch) {
    rows = rows.filter((p) => matchesWhere((c) => compare(pageFieldValue(p, c.field), c.op, c.value)));
  }

  // SORT
  if (sortMatch) {
    const field = sortMatch[1];
    const desc = (sortMatch[3] ?? "").toUpperCase() === "DESC";
    rows.sort((a, b) => {
      const av = pageFieldValue(a, field), bv = pageFieldValue(b, field);
      const cmp = String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric: true });
      return desc ? -cmp : cmp;
    });
  }

  // LIMIT
  if (limitMatch) rows = rows.slice(0, parseInt(limitMatch[1], 10));

  if (kind === "LIST") {
    return {
      kind: "list",
      columns: ["file.name"],
      rows: rows.map((p) => ({ "file.name": p.name, "file.path": p.rel_path })),
    };
  }

  // TABLE
  return {
    kind: "table",
    columns,
    rows: rows.map((p) => {
      const row: Record<string, unknown> = {
        "file.path": p.rel_path,
        "file.name": p.name,
        "file.folder": p.folder,
      };
      for (const col of columns) row[col] = pageFieldValue(p, col) ?? "";
      return row;
    }),
  };
}

/* ---------------------------------------------------------------------------
   Settings — `.pinpoint/settings.json` inside the vault.
--------------------------------------------------------------------------- */

async function readSettings(): Promise<Settings> {
  try {
    const dir = await dirAt(".pinpoint", false);
    const fh = await dir.getFileHandle("settings.json");
    const txt = await readFileText(fh);
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(txt) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(s: Settings): Promise<void> {
  const dir = await dirAt(".pinpoint", true);
  const fh = await dir.getFileHandle("settings.json", { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(s, null, 2));
  await w.close();
}

/* ---------------------------------------------------------------------------
   Public adapter — same shape as the Tauri `api` object + pickVaultFolder.
--------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   Recent vaults — persisted FSA directory handles in IndexedDB.

   The browser never exposes a real filesystem path, but it CAN persist a
   directory handle across sessions. We store each handle under an opaque id and
   re-grant permission on reuse, mirroring the desktop build's recent-vaults list.
--------------------------------------------------------------------------- */

const DB_NAME = "pinpoint";
const STORE = "recent-vaults";

interface RecentRecord {
  id: string;
  name: string;
  last_opened: number;
  handle: FsDirHandle;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbAll(): Promise<RecentRecord[]> {
  return openDb()
    .then(
      (db) =>
        new Promise<RecentRecord[]>((resolve, reject) => {
          const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
          req.onsuccess = () => resolve(req.result as RecentRecord[]);
          req.onerror = () => reject(req.error);
        })
    )
    .catch(() => []); // private mode / blocked IndexedDB → behave as if there are no recents
}

function idbGet(id: string): Promise<RecentRecord | undefined> {
  return openDb()
    .then(
      (db) =>
        new Promise<RecentRecord | undefined>((resolve, reject) => {
          const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
          req.onsuccess = () => resolve(req.result as RecentRecord | undefined);
          req.onerror = () => reject(req.error);
        })
    )
    .catch(() => undefined);
}

function idbPut(rec: RecentRecord): Promise<void> {
  return openDb()
    .then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(rec);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        })
    )
    .catch(() => {
      /* persistence is best-effort; the session still works without it */
    });
}

/** Adopt a freshly-picked directory handle as the open vault and record it as recent. */
async function adoptVault(handle: FsDirHandle, now: number): Promise<string> {
  rootDir = handle;
  rootName = handle.name || "vault";
  // Reuse a stable id per folder name so re-picking the same vault updates, not duplicates.
  const id = `web:${rootName}`;
  await idbPut({ id, name: rootName, last_opened: now, handle });
  return id;
}

export async function listRecentVaultsWeb(): Promise<RecentVault[]> {
  const all = await idbAll();
  return all
    .map(({ id, name, last_opened }) => ({ id, name, last_opened }))
    .sort((a, b) => b.last_opened - a.last_opened);
}

/** Re-open a persisted vault by id, re-requesting read/write permission if needed. */
export async function openRecentVaultWeb(id: string, now: number): Promise<string | null> {
  const rec = await idbGet(id);
  if (!rec) return null;
  const handle = rec.handle;
  // A persisted handle loses its permission grant between sessions — re-query, then prompt.
  let perm = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (perm !== "granted") perm = (await handle.requestPermission?.({ mode: "readwrite" })) ?? "denied";
  if (perm !== "granted") throw new Error("Permission to access this vault was denied.");
  rootDir = handle;
  rootName = handle.name || rec.name || "vault";
  await idbPut({ ...rec, name: rootName, last_opened: now });
  return id;
}

export async function pickVaultFolderWeb(): Promise<string | null> {
  if (!isWebFsSupported()) {
    throw new Error(
      "This browser can't open local folders. Use Chrome, Edge or Opera — or download the desktop app."
    );
  }
  const handle = await window.showDirectoryPicker!({ mode: "readwrite" });
  // `Date.now()` is fine in app code (the no-Date rule applies only to Workflow scripts).
  return adoptVault(handle, Date.now());
}

async function writeFileText(relPath: string, text: string): Promise<void> {
  const fh = await fileAt(relPath, true);
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

/* ---------------------------------------------------------------------------
   Move + trash. The FSA API has no rename, so a "move" is copy-then-remove.
   `.trash` (a dotfolder) is skipped by walk(), so trashed items vanish from the
   tree exactly as they do in the native build.
--------------------------------------------------------------------------- */

/** Move a file or folder from one rel path to another (copy subtree, then remove the source). */
async function movePath(fromRel: string, toRel: string): Promise<void> {
  if (fromRel === toRel) return;
  const fromSlash = fromRel.lastIndexOf("/");
  const fromDir = await dirAt(fromSlash >= 0 ? fromRel.slice(0, fromSlash) : "", false);
  const fromName = fromSlash >= 0 ? fromRel.slice(fromSlash + 1) : fromRel;

  const copyDir = async (src: FsDirHandle, destRel: string) => {
    for await (const [name, handle] of src.entries()) {
      const childDest = destRel ? `${destRel}/${name}` : name;
      if (handle.kind === "directory") {
        await dirAt(childDest, true);
        await copyDir(handle as FsDirHandle, childDest);
      } else {
        const bytes = await (handle as FsFileHandle).getFile().then((f) => f.arrayBuffer());
        const fh = await fileAt(childDest, true);
        const w = await fh.createWritable();
        await w.write(bytes);
        await w.close();
      }
    }
  };

  let isDir = false;
  try {
    await fromDir.getDirectoryHandle(fromName);
    isDir = true;
  } catch {
    /* it's a file */
  }

  if (isDir) {
    await dirAt(toRel, true);
    await copyDir(await fromDir.getDirectoryHandle(fromName), toRel);
  } else {
    const src = await fromDir.getFileHandle(fromName);
    const bytes = await src.getFile().then((f) => f.arrayBuffer());
    const fh = await fileAt(toRel, true);
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  }
  await fromDir.removeEntry(fromName, { recursive: true });
}

/** Does a file or folder exist at this rel path? */
async function pathExists(relPath: string): Promise<boolean> {
  const slash = relPath.lastIndexOf("/");
  const parentRel = slash >= 0 ? relPath.slice(0, slash) : "";
  const name = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  let dir: FsDirHandle;
  try {
    dir = await dirAt(parentRel, false);
  } catch {
    return false;
  }
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    /* not a file */
  }
  try {
    await dir.getDirectoryHandle(name);
    return true;
  } catch {
    return false;
  }
}

const TRASH = ".trash";

async function readManifest(): Promise<TrashEntry[]> {
  try {
    const dir = await dirAt(TRASH, false);
    const fh = await dir.getFileHandle("manifest.json");
    return JSON.parse(await readFileText(fh)) as TrashEntry[];
  } catch {
    return [];
  }
}

async function writeManifest(entries: TrashEntry[]): Promise<void> {
  const dir = await dirAt(TRASH, true);
  const fh = await dir.getFileHandle("manifest.json", { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(entries, null, 2));
  await w.close();
}

/** Filesystem-safe, collision-resistant id from a timestamp + leaf name (mirrors the Rust side). */
function trashId(nowMs: number, leaf: string): string {
  const safe = leaf.replace(/[^a-zA-Z0-9]/g, "-");
  return `${nowMs}-${safe}`;
}

/** Resolve a rel path that doesn't clobber an existing item (appends " (restored)" etc.). */
async function nonClobberingRel(relPath: string): Promise<string> {
  if (!(await pathExists(relPath))) return relPath;
  const dot = relPath.lastIndexOf(".");
  const slash = relPath.lastIndexOf("/");
  const hasExt = dot > slash; // a dot after the last slash → real extension
  const stem = hasExt ? relPath.slice(0, dot) : relPath;
  const ext = hasExt ? relPath.slice(dot) : "";
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (restored)" : ` (restored ${n})`;
    const candidate = `${stem}${suffix}${ext}`;
    if (!(await pathExists(candidate))) return candidate;
  }
}

/** Default schema for a new database — mirrors the Rust `default_db_schema`. */
function defaultDbSchema(name: string): DbSchema {
  return {
    name,
    columns: [
      { id: "name", name: "Name", type: "title" },
      { id: "status", name: "Status", type: "select", options: [] },
    ],
  };
}

export const webApi = {
  openVault: async (_path: string): Promise<TreeNode> => scan(),
  getTree: async (): Promise<TreeNode> => scan(),

  readAsset: async (relPath: string): Promise<AssetData> => {
    const fh = await fileAt(relPath, false);
    const file = await fh.getFile();
    const dot = relPath.lastIndexOf(".");
    const ext = dot >= 0 ? relPath.slice(dot + 1) : "";
    const kind = assetKindFor(ext);
    if (kind === "text") {
      return { kind, url: await file.text(), mime: file.type || "text/plain" };
    }
    if (kind === "image" || kind === "pdf") {
      // An object URL streams the local file without copying it through base64 in JS.
      return { kind, url: URL.createObjectURL(file), mime: file.type };
    }
    return { kind: "other", url: "", mime: file.type };
  },

  readPage: async (relPath: string): Promise<ParsedDoc> => {
    const cached = pageCache.get(relPath);
    if (cached) return { frontmatter: cached.frontmatter, body: cached.body };
    const fh = await fileAt(relPath, false); // throws if missing → matches Rust error path
    const { frontmatter, body } = splitFrontmatter(await readFileText(fh));
    return { frontmatter, body };
  },

  writePage: async (relPath: string, frontmatter: Record<string, unknown>, body: string): Promise<void> => {
    await writeFileText(relPath, serializeDoc(frontmatter, body));
    pageCache.set(relPath, {
      rel_path: relPath,
      name: (relPath.split("/").pop() ?? relPath).replace(/\.md$/i, ""),
      folder: relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "",
      frontmatter,
      body,
    });
  },

  createPage: async (relPath: string, body: string): Promise<void> => {
    // Match Rust: refuse to clobber an existing file.
    let exists = true;
    try {
      await fileAt(relPath, false);
    } catch {
      exists = false;
    }
    if (exists) throw new Error(`File already exists: ${relPath}`);
    await writeFileText(relPath, body);
  },

  // Create a database: a folder containing a `.pinpoint-db.json` schema. Mirrors the Rust
  // `create_database` default schema so a DB made on either host is recognised by the other.
  createDatabase: async (relPath: string, name: string): Promise<void> => {
    let exists = true;
    try {
      const slash = relPath.lastIndexOf("/");
      const parent = await dirAt(slash >= 0 ? relPath.slice(0, slash) : "", false);
      await parent.getDirectoryHandle(slash >= 0 ? relPath.slice(slash + 1) : relPath);
    } catch {
      exists = false;
    }
    if (exists) throw new Error(`Folder already exists: ${relPath}`);
    await writeFileText(`${relPath}/.pinpoint-db.json`, JSON.stringify(defaultDbSchema(name), null, 2));
  },

  // Read a database folder's schema; fall back to a default if missing/malformed.
  readDbSchema: async (relPath: string): Promise<DbSchema> => {
    const name = relPath.split("/").pop() || "Database";
    try {
      const fh = await fileAt(`${relPath}/.pinpoint-db.json`, false);
      return JSON.parse(await readFileText(fh)) as DbSchema;
    } catch {
      return defaultDbSchema(name);
    }
  },

  // Persist a database folder's schema.
  writeDbSchema: async (relPath: string, schema: DbSchema): Promise<void> => {
    await writeFileText(`${relPath}/.pinpoint-db.json`, JSON.stringify(schema, null, 2));
  },

  // Permanent delete (shift-delete / "Delete forever"). For a restorable delete, use trashPage.
  deletePage: async (relPath: string): Promise<void> => {
    const slash = relPath.lastIndexOf("/");
    const dir = await dirAt(slash >= 0 ? relPath.slice(0, slash) : "", false);
    // `recursive` lets the same call remove a folder and its contents (used by the context menu).
    await dir.removeEntry(slash >= 0 ? relPath.slice(slash + 1) : relPath, { recursive: true });
    pageCache.delete(relPath);
  },

  // Soft delete: move the item under `.trash/<id>/<leaf>` and record it in the manifest.
  trashPage: async (relPath: string): Promise<TrashEntry> => {
    const now = Date.now();
    const leaf = relPath.split("/").pop() ?? relPath;
    let isDir = false;
    {
      const slash = relPath.lastIndexOf("/");
      const parent = await dirAt(slash >= 0 ? relPath.slice(0, slash) : "", false);
      try {
        await parent.getDirectoryHandle(leaf);
        isDir = true;
      } catch {
        /* it's a file */
      }
    }
    const id = trashId(now, leaf);
    await movePath(relPath, `${TRASH}/${id}/${leaf}`);
    const entry: TrashEntry = { id, orig_path: relPath, name: leaf, is_dir: isDir, deleted_at: now };
    const entries = await readManifest();
    entries.push(entry);
    await writeManifest(entries);
    pageCache.delete(relPath);
    return entry;
  },

  listTrash: async (): Promise<TrashEntry[]> => {
    const entries = await readManifest();
    return entries.sort((a, b) => b.deleted_at - a.deleted_at);
  },

  restoreTrash: async (id: string): Promise<string> => {
    const entries = await readManifest();
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error("trash entry not found");
    const src = `${TRASH}/${entry.id}/${entry.name}`;
    if (!(await pathExists(src))) {
      // Dangling manifest row — drop it.
      await writeManifest(entries.filter((e) => e.id !== id));
      throw new Error(`trashed item missing on disk: ${entry.name}`);
    }
    const dest = await nonClobberingRel(entry.orig_path);
    await movePath(src, dest);
    // Remove the now-empty per-item folder + manifest row.
    try {
      await (await dirAt(TRASH, false)).removeEntry(entry.id, { recursive: true });
    } catch {
      /* already gone */
    }
    await writeManifest(entries.filter((e) => e.id !== id));
    await scan();
    return dest;
  },

  purgeTrash: async (id: string): Promise<void> => {
    const entries = await readManifest();
    try {
      await (await dirAt(TRASH, false)).removeEntry(id, { recursive: true });
    } catch {
      /* already gone */
    }
    await writeManifest(entries.filter((e) => e.id !== id));
  },

  emptyTrash: async (): Promise<void> => {
    try {
      await ensureRoot().removeEntry(TRASH, { recursive: true });
    } catch {
      /* nothing to empty */
    }
  },

  // Rename / move a file or folder. The FSA API has no native rename, so we copy then delete.
  renamePath: async (fromRel: string, toRel: string): Promise<void> => {
    await movePath(fromRel, toRel);
    await scan();
  },

  reindex: async (): Promise<number> => {
    await scan();
    return pageCache.size;
  },

  runQuery: async (dsl: string): Promise<QueryResult> => {
    if (pageCache.size === 0) await scan();
    return runQueryDsl(dsl);
  },

  listTasks: async (): Promise<TaskRow[]> => {
    if (pageCache.size === 0) await scan();
    const out: TaskRow[] = [];
    for (const p of pageCache.values()) out.push(...extractTasks(p.rel_path, p.body));
    return out;
  },

  // Toggle a task's done state by rewriting its source line in place (mirrors the Rust command).
  toggleTask: async (relPath: string, line: number, occurrence: string | null): Promise<void> => {
    if (pageCache.size === 0) await scan();
    const fh = await fileAt(relPath, false);
    const { frontmatter, body } = splitFrontmatter(await readFileText(fh));
    const lines = body.split("\n");
    const target = lines[line];
    if (target == null) throw new Error("task line out of range");
    const next = toggleTaskLine(target, occurrence);
    if (next == null) throw new Error("not a task line");
    lines[line] = next;
    const newBody = lines.join("\n");
    await writeFileText(relPath, serializeDoc(frontmatter, newBody));
    pageCache.set(relPath, {
      rel_path: relPath,
      name: (relPath.split("/").pop() ?? relPath).replace(/\.md$/i, ""),
      folder: relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "",
      frontmatter,
      body: newBody,
    });
  },

  getSettings: (): Promise<Settings> => readSettings(),
  saveSettings: (s: Settings): Promise<void> => writeSettings(s),
};
