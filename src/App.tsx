import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import {
  Plus,
  ChatCircle,
  ArrowsClockwise,
  GearSix,
  FolderOpen,
  ArrowSquareOut,
  PencilSimple,
  Copy,
  Link as LinkIcon,
  Trash,
  TrashSimple,
  Smiley,
  CircleNotch,
  CheckCircle,
  FileText,
  Folder,
  CaretLeft,
  CaretRight,
  CaretDown,
  X,
  File as FileIcon,
  Database,
  Stack,
  SidebarSimple,
  MagnifyingGlass,
  Tag,
  Lock,
  LockOpen,
  Key,
} from "@phosphor-icons/react";
import { api, isTauri, isAndroid, pickVaultFolder, resolveRecentVault, listRecentVaults, isRecentVaultError, createAppVault, openAppVault, debugLog } from "./api";
import { getTheme, seedStarterThemes } from "./themes-store";
import { applyTheme, resolveMode } from "./theme-apply";
import type { Theme } from "./types";
import { slideFade, transition } from "./motion";
import { useViewport } from "./hooks/useViewport";
import { useSwipeNav } from "./hooks/useSwipeNav";
import { haptic } from "./lib/haptics";
import { uiZoom } from "./lib/zoom";
import Breadcrumb from "./components/Breadcrumb";
import MobileNavbar, { type FolderOption } from "./components/MobileNavbar";
import PathBreadcrumb from "./components/PathBreadcrumb";
import FolderView from "./components/FolderView";
import Tooltip from "./components/Tooltip";
import StartScreen from "./components/StartScreen";
import type { LockStatus, NodeIcon, Settings, TreeNode } from "./types";
import { DEFAULT_SETTINGS, extForMime } from "./types";
import { collectTemplates, fillTemplate, stripCursor, type FillContext, type TemplateInfo } from "./templates";
import { pathFor, labelFor, template, type Period } from "./periodic";
import {
  conflictKey,
  findSyncConflicts,
  ignoreConflict,
  loadIgnoredConflicts,
  mergeBodies,
  type SyncConflict,
} from "./conflicts";
import Editor from "./components/Editor";
import FileTree, { type SelectMods, type TreeCommands } from "./components/FileTree";
import ContextMenu from "./components/ContextMenu";
import type { MenuItem } from "./components/ContextMenu";
import CreateDialog from "./components/CreateDialog";
import type { CreateKind, CreateRequest } from "./components/CreateDialog";
import TemplateMenu from "./components/TemplateMenu";
import TemplateBuilderBar from "./components/TemplateBuilderBar";
// Lazy-loaded: pulls in the full ~1500-icon Phosphor set, so it loads only on first open.
const IconPicker = lazy(() => import("./components/IconPicker"));
import { NodeIconView } from "./components/Icon";
import AssetViewer from "./components/AssetViewer";
import DatabaseView from "./components/DatabaseView";
import DbPageProperties from "./components/DbPageProperties";
import TasksView from "./components/TasksView";
import TrashView from "./components/TrashView";
import QueryView from "./components/QueryView";
import TagsView from "./components/TagsView";
import SettingsPanel from "./components/SettingsPanel";
import RightSidebar, { type Heading } from "./components/RightSidebar";
import { LlmPanel, type LlmChatTurn } from "./components/LlmPanel";
import { DialogHost, dialogs } from "./components/Dialogs";
import { ConflictDialogHost, conflictDialog } from "./components/ConflictDialog";
import { ToastHost, toast } from "./components/Toast";
import CommandPalette, { type PaletteAction } from "./components/CommandPalette";
import ShortcutsPopup from "./components/ShortcutsPopup";
import PageProperties from "./components/PageProperties";
import PageTitle from "./components/PageTitle";
import Titlebar from "./components/Titlebar";

// Platform-friendly modifier label for shortcut hints (⌘ on macOS, Ctrl elsewhere).
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);

type RightTab = "editor" | "tasks" | "query" | "tags" | "trash";

/** The three kinds of document an open tab can hold. */
type DocKind = "page" | "asset" | "db" | "folder";

// Pasted/dropped images live in a single vault-root `.attachments` folder (a dotfolder, so it
// stays out of the file tree like `.obsidian`). The markdown stores a vault-relative path into it
// and the editor's image node resolves that back through the API.
const ATTACHMENTS_DIR = ".attachments";

// The "open where I left off" feature remembers the last page a vault had open, per vault. This is
// volatile runtime state (it changes on every navigation), not a user preference, so it lives in
// app-global localStorage keyed by the vault id — NOT in the vault's settings.json (which would
// churn on every click and travel to other machines where the path is meaningless). The startup
// PREFERENCE (last / today / specific page) does live in settings.json. We hash the vault id into
// the key so an absolute path with odd characters still yields a safe, stable key.
function lastPageKey(vaultId: string): string {
  let h = 0;
  for (let i = 0; i < vaultId.length; i++) h = (Math.imul(31, h) + vaultId.charCodeAt(i)) | 0;
  return `pp.lastPage.${(h >>> 0).toString(36)}`;
}
function readLastPage(vaultId: string): string | null {
  try {
    return localStorage.getItem(lastPageKey(vaultId));
  } catch {
    return null;
  }
}
function writeLastPage(vaultId: string, relPath: string | null): void {
  try {
    if (relPath) localStorage.setItem(lastPageKey(vaultId), relPath);
    else localStorage.removeItem(lastPageKey(vaultId));
  } catch {
    /* storage unavailable (private mode / quota) — last-page restore just won't work */
  }
}

// Same-second pastes get a numeric suffix so two images in one batch never collide. The seconds
// timestamp already separates pastes across time; the counter only disambiguates within a second.
let lastAttachStamp = "";
let attachStampSeq = 0;

/** Build a unique vault-relative path under `.attachments` for a pasted image of the given type. */
function attachmentRelPath(mime: string, sourceName?: string): string {
  const ext = extForMime(mime) || sourceName?.split(".").pop()?.toLowerCase() || "png";
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  if (stamp === lastAttachStamp) attachStampSeq += 1;
  else {
    lastAttachStamp = stamp;
    attachStampSeq = 0;
  }
  const dedup = attachStampSeq > 0 ? `-${attachStampSeq}` : "";
  // Hyphenated, no spaces: a CommonMark image destination can't contain raw spaces, and the
  // editor stores images as plain `![](path)` markdown (the locked strict-round-trip constraint).
  return `${ATTACHMENTS_DIR}/Pasted-image-${stamp}${dedup}.${ext}`;
}

/** Matches a serialized task line (`- [ ] …` / `- [x] …`), at any indent — mirrors the editor's. */
const TASK_LINE_RE = /^\s*-\s*\[[ xX]\]/;

/**
 * Ordinal (0-based) of the task at body line `line` among ALL task lines in `body`, in document
 * order. The editor renders task items as `<li>` under `ul[data-type="taskList"]` in that same
 * order, so this ordinal indexes straight into that DOM node list — the bridge that lets us scroll
 * to a task picked in the calendar/Tasks panel (which only know the source line). Null if the line
 * isn't a task line.
 */
function taskOrdinalForLine(body: string, line: number): number | null {
  const lines = body.split("\n");
  if (line < 0 || line >= lines.length || !TASK_LINE_RE.test(lines[line])) return null;
  let ordinal = 0;
  for (let i = 0; i < line; i++) if (TASK_LINE_RE.test(lines[i])) ordinal++;
  return ordinal;
}

/**
 * Locate the Nth task <li> in the editor mounted for `key`. `key` scopes the lookup to the
 * destination editor: while navigating between pages the outgoing editor (with the previous
 * reloadKey) lingers in the DOM under AnimatePresence's `mode="wait"` swap, so we only match
 * `.editor-content[data-reload-key=key]` and the poll keeps retrying until that editor mounts.
 */
function findTaskRow(ordinal: number, key: string): HTMLElement | null {
  const root = document.querySelector(`.editor-content[data-reload-key="${CSS.escape(key)}"]`);
  // All task <li>s in document order — nested subtasks included, matching `taskOrdinalForLine`.
  const items = root?.querySelectorAll('ul[data-type="taskList"] li');
  return items && items.length > ordinal ? (items[ordinal] as HTMLElement) : null;
}

/**
 * Smooth-scroll the open editor to the task at `ordinal` (its index among rendered task items) and
 * flash an accent highlight on the row so the eye lands on it.
 *
 * Implementation note — why an overlay and not styling the <li>: Tiptap renders each task item as a
 * React NodeView and CONTINUOUSLY reconciles the <li>, wiping any inline `style`/class we set within
 * a frame (confirmed via logging — the paint applies then vanishes). So instead we drop an
 * app-owned <div> on top of the row, positioned to its bounding rect and kept glued to it across the
 * smooth-scroll via rAF. It lives outside the editor's managed DOM, so Tiptap can't touch it, and we
 * drive its opacity fade from JS so the global `prefers-reduced-motion` duration reset can't kill it.
 */
function flashTaskRow(ordinal: number, key: string, attempt = 0): void {
  const el = findTaskRow(ordinal, key);
  if (!el) {
    if (attempt < 40) setTimeout(() => flashTaskRow(ordinal, key, attempt + 1), 50);
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });

  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed",
    "z-index:50",
    "pointer-events:none",
    "border-radius:var(--r-sm)",
    "background:color-mix(in srgb, var(--accent) 24%, transparent)",
    "box-shadow:0 0 0 2px var(--accent), 0 0 16px 3px color-mix(in srgb, var(--accent) 55%, transparent)",
    "opacity:1",
  ].join(";");
  document.body.appendChild(overlay);

  // Keep the overlay glued to the row's rect while the smooth-scroll animates it into view.
  const start = performance.now();
  let raf = 0;
  const track = (now: number) => {
    const row = findTaskRow(ordinal, key) ?? el;
    const r = row.getBoundingClientRect();
    // `getBoundingClientRect` reports OUTER (zoomed) pixels, but the overlay is a child of the zoomed
    // `body` (position: fixed does NOT escape CSS `zoom`), so its inline left/top/width/height are read
    // in LOCAL (unzoomed) pixels. Divide the rect by the UI zoom factor so the box lands on the row at
    // any zoom; the ±px nudges are local-space design constants, applied AFTER the division. No-op at
    // 100%. See the css-zoom-coordinates note.
    const z = uiZoom();
    overlay.style.left = `${r.left / z - 6}px`;
    overlay.style.top = `${r.top / z - 3}px`;
    overlay.style.width = `${r.width / z + 12}px`;
    overlay.style.height = `${r.height / z + 6}px`;
    // Hold full strength for 1s, then fade opacity to 0 over the next 0.8s.
    const elapsed = now - start;
    overlay.style.opacity = elapsed < 1000 ? "1" : String(Math.max(0, 1 - (elapsed - 1000) / 800));
    if (elapsed < 1800) {
      raf = requestAnimationFrame(track);
    } else {
      overlay.remove();
    }
  };
  raf = requestAnimationFrame(track);
  // Safety: ensure cleanup even if rAF is throttled (e.g. tab backgrounded).
  setTimeout(() => {
    cancelAnimationFrame(raf);
    overlay.remove();
  }, 2500);
}

export default function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [vaultName, setVaultName] = useState<string>("");
  // The id (absolute path on desktop, opaque handle key on web) of the open vault, used to key the
  // per-vault "last open page" in localStorage. Null when on the Start screen.
  const vaultIdRef = useRef<string | null>(null);
  // Holds the latest `openStartupDoc` so the vault-open callbacks (declared above it) can invoke the
  // startup behaviour without a declaration-order / TDZ dependency on the callback itself.
  const openStartupRef = useRef<((s: Settings, id: string) => Promise<void>) | null>(null);
  // True while the boot effect tries to auto-open the most recent vault, so we don't
  // flash the Start screen before we know whether there's a vault to restore.
  const [booting, setBooting] = useState(true);
  // The recent-vault id currently being opened from the Start screen (or "new" for the folder
  // picker), so the Start screen can show a spinner and block a second click. null = idle.
  const [openingVault, setOpeningVault] = useState<string | null>(null);
  // Bumped to make the Start screen re-fetch its recent list (e.g. after a dead entry is pruned).
  const [recentsNonce, setRecentsNonce] = useState(0);
  const [activePath, setActivePath] = useState<string | null>(null);
  // Multi-selected tree rows (rel_paths). Driven by ctrl/shift-click; a plain click collapses
  // this back to just the opened row. Used for bulk actions from the context menu.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // A non-markdown file (PDF/image/…) currently shown in the viewer pane, or null for the editor.
  const [activeAsset, setActiveAsset] = useState<TreeNode | null>(null);
  // The database folder currently shown in the table view, or null. Mutually exclusive with the
  // editor/asset panes (a database is a third kind of "doc").
  const [activeDb, setActiveDb] = useState<TreeNode | null>(null);
  // A plain folder opened "as a page": shown as a gallery of its child folders/pages, or null.
  // Mutually exclusive with the editor/asset/db panes (a fourth kind of "doc").
  const [activeFolder, setActiveFolder] = useState<TreeNode | null>(null);
  // ---- Open-document tabs + back/forward history (browser-style) ----
  // The strip of documents the user has open. A doc is a page or an asset, keyed by rel_path
  // (we never open the same path twice). `activePath` above stays the single rendered doc.
  const [openDocs, setOpenDocs] = useState<{ path: string; kind: DocKind }[]>([]);
  // Linear visit history of rel_paths with a cursor; navigating truncates forward entries
  // (classic browser behaviour). Back/forward just move the cursor. Refs because navigation
  // reads-then-writes synchronously and must not see stale closures.
  const histRef = useRef<string[]>([]);
  const histIdx = useRef<number>(-1);
  // Bumped purely to re-render the back/forward buttons when the cursor/stack changes.
  const [histTick, setHistTick] = useState(0);
  const [body, setBody] = useState<string>("");
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({});
  const [reloadKey, setReloadKey] = useState<string>("");
  const [tab, setTab] = useState<RightTab>("editor");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // The resolved active theme object (null = built-in default palette). Loaded from `.themes/`
  // whenever `settings.active_theme` changes; drives the core CSS tokens in the theming effect.
  const [activeTheme, setActiveTheme] = useState<Theme | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [taskRefresh, setTaskRefresh] = useState(0);
  // When the Tags view sends a tag to the Query panel, we seed the builder's FROM with `#tag`.
  // Bumped alongside the value so re-querying the same tag still re-seeds. Null = no pending seed.
  const [queryTagSeed, setQueryTagSeed] = useState<{ tag: string; n: number } | null>(null);
  // A tag to focus in the Tags view, set when an inline `#tag` pill is clicked in the editor.
  const [tagFocus, setTagFocus] = useState<{ tag: string; n: number } | null>(null);
  // Bumped whenever the trash contents change, so the Trash view re-fetches its list.
  const [trashRefresh, setTrashRefresh] = useState(0);
  // Count of trashed items, shown as a badge on the sidebar's Trash entry.
  const [trashCount, setTrashCount] = useState(0);
  // Open context menu: the right-clicked tree node + where to anchor the menu.
  const [menu, setMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null);
  // Lock (encryption) status per folder rel_path, refreshed alongside the tree. Only encrypted
  // scopes appear here; absence means "not a locked scope" (the common case). Drives both the tree
  // lock indicators and which lock/unlock actions the context menu offers. "" is the vault root.
  const [lockMap, setLockMap] = useState<Record<string, LockStatus>>({});
  // The sidebar ＋ "create" menu (New page / folder / database), anchored under the ＋ button.
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  // The "save panel" create dialog: name + destination-folder picker. Open via the ＋ menu.
  const [create, setCreate] = useState<CreateRequest | null>(null);
  // The "New from template" picker, anchored at (x,y). `parent` (a folder rel_path) lands the new
  // page inside it — set by the folder context menu; empty for the sidebar ＋ menu (vault root).
  const [templatePicker, setTemplatePicker] = useState<{ x: number; y: number; parent: string } | null>(null);
  // Bumped signal that asks the editor to insert a token at the caret (template builder chips).
  const [tokenInsert, setTokenInsert] = useState<{ text: string; n: number }>({ text: "", n: 0 });
  // rel_path of the tree row currently being renamed inline (Windows Explorer style), or null.
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  // rel_path of the node whose icon is being chosen in the picker, or null when closed.
  const [iconTarget, setIconTarget] = useState<string | null>(null);
  // rel_paths whose icon is being set in bulk from the multi-selection, or null when closed.
  const [iconBatch, setIconBatch] = useState<string[] | null>(null);
  // Whether the Cmd/Ctrl+K command palette overlay is open.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Whether the "?" keyboard-shortcuts cheat sheet is open.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const saveTimer = useRef<number | null>(null);
  // Live mirrors of the open page's path / body / dirty flag. The "vault-changed" watcher is
  // registered once and must read the CURRENT values without re-subscribing on every keystroke,
  // so it reads these refs instead of closing over stale state.
  const activePathRef = useRef<string | null>(null);
  const bodyRef = useRef<string>("");
  const dirtyRef = useRef<boolean>(false);
  // FileTree populates this with a reveal(relPath) fn so the breadcrumb can jump to a folder.
  const treeRevealRef = useRef<((relPath: string) => void) | null>(null);
  // FileTree populates this with expand/collapse commands so the folder context menu can drive them.
  const treeCmdRef = useRef<TreeCommands | null>(null);
  // True while a re-index is running, so the button can show a spinner + disable.
  const [reindexing, setReindexing] = useState(false);

  // ---- Resizable side panels ----
  // Widths (px) of the left and right sidebars, persisted in localStorage (app-global UI state,
  // not vault content). Clamped to a sane range; the editor column flexes to fill the rest.
  const LEFT_MIN = 200, LEFT_MAX = 560;
  const RIGHT_MIN = 200, RIGHT_MAX = 560;
  const CHAT_MIN = 280, CHAT_MAX = 640;
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("pp.leftWidth"));
    return v >= LEFT_MIN && v <= LEFT_MAX ? v : 286;
  });
  const [rightWidth, setRightWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("pp.rightWidth"));
    return v >= RIGHT_MIN && v <= RIGHT_MAX ? v : 280;
  });
  const [chatWidth, setChatWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("pp.chatWidth"));
    return v >= CHAT_MIN && v <= CHAT_MAX ? v : 360;
  });

  // Whether each sidebar is shown on DESKTOP. Persisted in localStorage (app-global UI state). When
  // a sidebar is hidden its grid column AND its resizer collapse to 0, so the editor reclaims the
  // space; a toggle button in the tabs bar brings it back. (Mobile drawers are driven separately —
  // see `mobileDrawer` below — so the desktop "both open" state never leaks onto a phone.)
  const [leftOpen, setLeftOpen] = useState<boolean>(
    () => localStorage.getItem("pp.leftOpen") !== "0"
  );
  const [rightOpen, setRightOpen] = useState<boolean>(
    () => localStorage.getItem("pp.rightOpen") !== "0"
  );

  // LLM chat dock (CLI integration) — an independent right-edge slide-over, toggled with
  // Ctrl/Cmd+J. Separate from the outline/tasks right sidebar above so the two don't fight for
  // the same track. Closed by default; choice persists. See src/components/LlmPanel.tsx.
  const [llmOpen, setLlmOpen] = useState<boolean>(
    () => localStorage.getItem("pp.llmOpen") === "1"
  );
  const toggleLlm = useCallback(
    () => setLlmOpen((v) => (localStorage.setItem("pp.llmOpen", v ? "0" : "1"), !v)),
    []
  );

  // The chat conversation lives HERE, not inside LlmPanel, so it survives the dock being hidden.
  // The dock is conditionally rendered (for the slide animation), which would otherwise unmount
  // LlmPanel and wipe its turns + resume session id every time the dock is toggled closed —
  // silently starting a brand-new conversation on the next message. Hoisting both into App keeps
  // a single long-lived conversation across open/close. `reset()` (New conversation) clears them.
  const [llmTurns, setLlmTurns] = useState<LlmChatTurn[]>([]);
  const llmSessionRef = useRef<string | undefined>(undefined);

  // ---- Responsive layout ----
  // Drives the desktop↔mobile switch: on a narrow viewport the grid collapses to a single column,
  // the sidebars become overlay drawers, the table view falls back to cards, and a breadcrumb
  // replaces the always-on sidebars as the orientation cue. `data-vp` on <body> lets styles.css
  // target the breakpoint where a plain @media query is awkward.
  const vp = useViewport();
  useEffect(() => {
    document.body.dataset.vp = vp.breakpoint;
  }, [vp.breakpoint]);

  // On mobile the two sidebars are mutually-exclusive overlay drawers driven by this session-local
  // state (NOT the persisted desktop flags above), so a phone always opens with both closed. This is
  // the fix for the old trap where two 86vw drawers buried the editor with no tappable scrim to
  // escape. Only one drawer is ever open, so the scrim always has room to dismiss it.
  const [mobileDrawer, setMobileDrawer] = useState<"left" | "right" | null>(null);
  // Effective visibility: the mobile drawer on a phone, the persisted flag on desktop.
  const showLeft = vp.isMobile ? mobileDrawer === "left" : leftOpen;
  const showRight = vp.isMobile ? mobileDrawer === "right" : rightOpen;

  const toggleLeft = useCallback(() => {
    if (vp.isMobile) { setMobileDrawer((d) => (d === "left" ? null : "left")); return; }
    setLeftOpen((v) => (localStorage.setItem("pp.leftOpen", v ? "0" : "1"), !v));
  }, [vp.isMobile]);
  const toggleRight = useCallback(() => {
    if (vp.isMobile) { setMobileDrawer((d) => (d === "right" ? null : "right")); return; }
    setRightOpen((v) => (localStorage.setItem("pp.rightOpen", v ? "0" : "1"), !v));
  }, [vp.isMobile]);

  // Tapping the scrim (or selecting an item) dismisses whichever drawer is open on mobile.
  const closeDrawers = useCallback(() => { haptic("tap"); setMobileDrawer(null); }, []);
  // Auto-close the drawer after navigating to a file on mobile, so the editor is revealed.
  const closeLeftOnMobile = useCallback(() => {
    if (vp.isMobile) setMobileDrawer(null);
  }, [vp.isMobile]);
  // Open the left (file-tree) drawer to reveal something in it — the mobile overlay on a phone, the
  // persisted panel on desktop. Used by reveal-in-tree and breadcrumb folder jumps.
  const openLeftDrawer = useCallback(() => {
    if (vp.isMobile) { haptic("tap"); setMobileDrawer("left"); return; }
    setLeftOpen((v) => (v ? v : (localStorage.setItem("pp.leftOpen", "1"), true)));
  }, [vp.isMobile]);

  // Pane-swipe navigation (mobile): a horizontal flick moves left drawer ⇄ editor ⇄ right drawer,
  // one step per swipe, mirroring the navbar toggles and their haptic tap. Swipe-left steps toward
  // the right pane, swipe-right toward the left. Bound to the app root so it works over the editor
  // and an open drawer alike; the hook leaves vertical scroll, inner horizontal scrollers, and
  // modals untouched.
  const appRef = useRef<HTMLDivElement>(null);
  const stepTowardRight = useCallback(() => { haptic("tap"); setMobileDrawer((d) => (d === "left" ? null : "right")); }, []);
  const stepTowardLeft = useCallback(() => { haptic("tap"); setMobileDrawer((d) => (d === "right" ? null : "left")); }, []);
  useSwipeNav(appRef, { enabled: vp.isMobile, onSwipeLeft: stepTowardRight, onSwipeRight: stepTowardLeft });

  // Begin dragging a sidebar divider. `side` picks which edge; the handler tracks the pointer
  // until release, clamps the new width, and persists it.
  const startResize = useCallback(
    (side: "left" | "right" | "chat") => (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = side === "left" ? leftWidth : side === "right" ? rightWidth : chatWidth;
      const min = side === "left" ? LEFT_MIN : side === "right" ? RIGHT_MIN : CHAT_MIN;
      const max = side === "left" ? LEFT_MAX : side === "right" ? RIGHT_MAX : CHAT_MAX;
      const setW = side === "left" ? setLeftWidth : side === "right" ? setRightWidth : setChatWidth;
      const storeKey = side === "left" ? "pp.leftWidth" : side === "right" ? "pp.rightWidth" : "pp.chatWidth";
      // Left edge grows with rightward drag; right & chat edges grow with leftward drag.
      const dir = side === "left" ? 1 : -1;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      // Suspend the grid-track easing so the panel tracks the pointer 1:1 while dragging.
      document.querySelector(".app")?.classList.add("resizing");
      const onMove = (ev: PointerEvent) => {
        const next = Math.min(max, Math.max(min, startW + dir * (ev.clientX - startX)));
        setW(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.querySelector(".app")?.classList.remove("resizing");
        // Read the committed width off the element via the setter's latest value.
        setW((w) => (localStorage.setItem(storeKey, String(w)), w));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [leftWidth, rightWidth, chatWidth]
  );

  // Load (or clear) the active theme object whenever the selected theme name changes. A name with
  // no matching file falls back to the built-in default rather than erroring.
  useEffect(() => {
    let live = true;
    if (!settings.active_theme) {
      setActiveTheme(null);
      return;
    }
    getTheme(settings.active_theme).then((t) => {
      if (live) setActiveTheme(t);
    });
    return () => {
      live = false;
    };
  }, [settings.active_theme]);

  // ---- Theming: apply settings (and the active theme) to CSS variables ----
  // Order is deliberate: the theme paints the six core tokens first, then the user's explicit
  // accent / background / text overrides from Settings are layered on top, so a one-off override
  // always wins over the theme. Re-runs on the OS light/dark flip too (for "system" appearance).
  useEffect(() => {
    const apply = () => {
      const root = document.documentElement;
      root.dataset.theme = settings.theme;
      // 1) Theme core tokens (or clear them so the stock stylesheet wins when no theme is active).
      applyTheme(activeTheme, resolveMode(settings.theme));
      // 2) Typography: the active theme owns it (fonts, size, line-height, page width); any field the
      // theme leaves unset ("Inherit") falls back to the global Settings value, so palette-only themes
      // don't disturb the reader's type choices.
      const ty = activeTheme?.type;
      root.style.setProperty("--font-ui", ty?.ui || settings.font_family);
      root.style.setProperty("--font-editor", ty?.editor || settings.editor_font_family);
      root.style.setProperty("--font-size", `${ty?.size || settings.font_size}px`);
      root.style.setProperty("--line-height", String(ty?.lineHeight || settings.line_height));
      root.style.setProperty("--page-width", `${ty?.pageWidth || settings.page_width || 820}px`);
      // Whole-UI scaling: `zoom` scales layout + fonts + icons uniformly while keeping the app
      // filling the viewport and scrollbars/hit-testing correct (unlike transform: scale).
      document.body.style.zoom = String(settings.ui_zoom || 1);
      // 3) Explicit Settings overrides last. With a theme active, the theme owns the core palette
      // (accent/bg/text live in the theme editor), so the standalone overrides apply only to the
      // built-in default — this keeps a single source of truth and avoids the default accent
      // silently clobbering a theme's accent.
      if (!activeTheme) {
        root.style.setProperty("--accent", settings.accent_color);
        if (settings.background_color) root.style.setProperty("--bg-override", settings.background_color);
        else root.style.removeProperty("--bg-override");
        if (settings.text_color) root.style.setProperty("--text-override", settings.text_color);
        else root.style.removeProperty("--text-override");
      } else {
        // Theme paints --bg/--text directly; ensure stale standalone overrides don't linger.
        root.style.removeProperty("--bg-override");
        root.style.removeProperty("--text-override");
      }
      root.classList.toggle("show-line-numbers", settings.show_line_numbers);
      // Strike through completed to-do items (and dim them) when enabled.
      root.classList.toggle("strike-done-tasks", settings.strike_done_tasks);
      // Dim or hide completed to-dos in the editor body (data-attr so CSS can branch on the mode).
      root.dataset.completedTasks = settings.completed_task_display;
      // How inline `priority::` pills render: flag + word / flag only / word only.
      root.dataset.priorityDisplay = settings.priority_display;
      // Collapses the custom titlebar to a top-edge hover strip ("semi-fullscreen").
      root.classList.toggle("titlebar-auto-hide", settings.auto_hide_titlebar);
    };
    apply();
    // Under "system", track the OS scheme so the right theme variant repaints live.
    if (settings.theme === "system" && window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [settings, activeTheme]);

  const refreshTree = useCallback(async () => {
    try {
      setTree(await api.getTree());
    } catch (e) {
      console.error(e);
    }
  }, []);

  // Refresh the per-folder lock-status map whenever the tree changes. We query every folder (plus the
  // vault root, "") and keep only encrypted scopes — so `lockMap` is empty on the web build and on
  // vaults with nothing locked, and absence means "not a locked scope". Cheap: one IPC call per
  // folder, and only encrypted scopes ever read their manifest.
  useEffect(() => {
    if (!tree) {
      setLockMap({});
      return;
    }
    let cancelled = false;
    const folders: string[] = [""];
    const visit = (n: TreeNode) => {
      if (n.is_dir && n.rel_path) folders.push(n.rel_path);
      n.children.forEach(visit);
    };
    tree.children.forEach(visit);
    (async () => {
      const entries = await Promise.all(
        folders.map(async (rel) => {
          try {
            return [rel, await api.lockStatus(rel)] as const;
          } catch {
            return [rel, null] as const;
          }
        })
      );
      if (cancelled) return;
      const map: Record<string, LockStatus> = {};
      for (const [rel, status] of entries) {
        if (status?.is_locked_scope) map[rel] = status;
      }
      setLockMap(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [tree]);

  // Keep the watcher-facing refs in lockstep with the open page's state.
  useEffect(() => { activePathRef.current = activePath; }, [activePath]);
  useEffect(() => { bodyRef.current = body; }, [body]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  // ---- File watcher: the Tauri backend emits "vault-changed". The browser build has no
  //      native watcher, so we simply skip it there (the user re-indexes with ⟳). ----
  //
  // Besides refreshing the tree + task views, we reload the OPEN page when its file changed on
  // disk underneath us (e.g. an external editor, a sync client, or an AI agent wrote to it). Without
  // this the editor keeps a stale in-memory copy and the next autosave silently clobbers the external
  // edit. We only reload a CLEAN buffer — never one with unsaved edits — and only when the on-disk
  // body actually differs, which also makes our own saves (whose echo carries identical content) no-ops.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    listen("vault-changed", () => {
      refreshTree();
      setTaskRefresh((k) => k + 1);

      const rel = activePathRef.current;
      if (!rel || dirtyRef.current) return; // nothing open, or unsaved edits we won't overwrite
      // A debounced save may still be queued (buffer clean but write not yet flushed); skip the
      // reload and let that write win, otherwise we'd race it.
      if (saveTimer.current) return;
      void api
        .readPage(rel)
        .then((doc) => {
          // Re-check: the user may have started typing, or switched pages, during the async read.
          if (activePathRef.current !== rel || dirtyRef.current) return;
          if (doc.body === bodyRef.current) return; // unchanged (typically our own save echo)
          setBody(doc.body);
          setFrontmatter(doc.frontmatter as Record<string, unknown>);
          setReloadKey(rel + ":" + Date.now()); // remount the editor on the fresh content
        })
        .catch(() => {
          /* file vanished or unreadable — the tree refresh above already reflects it */
        });
    })
      .then((f) => {
        dispose = f;
      })
      .catch(() => {
        /* not running under Tauri — no file watcher available */
      });
    return () => dispose?.();
  }, [refreshTree]);

  // Open the vault at `path` (an absolute path on desktop, an opaque handle key on web)
  // and load its tree + settings into the UI. Returns the loaded settings + vault id so the caller
  // can apply the configured startup behaviour (open last page / today / a specific page).
  // Load an already-opened vault tree into the UI (set tree/name/id, fetch settings,
  // seed themes). Shared by the desktop path-open flow and the Android app-vault flow:
  // on Android the vault is opened server-side by create_app_vault/open_app_vault, which
  // return the tree directly, so we must NOT re-call open_vault — we just adopt the tree.
  const loadVaultFromTree = useCallback(async (t: TreeNode, id: string) => {
    setTree(t);
    setVaultName(t.name);
    vaultIdRef.current = id;
    const loaded = await api.getSettings();
    setSettings(loaded);
    // Seed curated starter themes the first time a vault is opened (no-op if `.themes/` exists).
    seedStarterThemes();
    return { settings: loaded, id };
  }, []);

  const loadVault = useCallback(
    async (path: string) => {
      const t = await api.openVault(path);
      return loadVaultFromTree(t, path);
    },
    [loadVaultFromTree]
  );

  // Android: create a new app-owned vault by name (no folder dialog exists on mobile).
  // The Rust command creates the folder, opens it, and returns its tree.
  const createMobileVault = useCallback(
    async (name: string) => {
      if (openingVault) return;
      setOpeningVault("new");
      try {
        const t = await createAppVault(name);
        const { settings: loaded, id } = await loadVaultFromTree(t, t.name);
        await openStartupRef.current?.(loaded, id);
      } catch (e) {
        console.error(e);
        toast.show({
          message: e instanceof Error ? e.message : "Couldn’t create that vault. Please try again.",
          durationMs: 7000,
        });
      } finally {
        setOpeningVault(null);
      }
    },
    [openingVault, loadVaultFromTree]
  );

  // Android: open an *existing* folder (chosen in the folder browser) as a vault.
  // The path is a real on-disk directory, so the normal `open_vault` flow applies —
  // `loadVault` calls `api.openVault(path)` and records it in recents like any vault.
  const openExistingVault = useCallback(
    async (path: string) => {
      if (openingVault) return;
      setOpeningVault("new");
      try {
        debugLog(`openExistingVault: start ${path}`);
        const { settings: loaded, id } = await loadVault(path);
        debugLog(`openExistingVault: loadVault ok id=${id}`);
        await openStartupRef.current?.(loaded, id);
        debugLog(`openExistingVault: openStartup ok`);
      } catch (e) {
        console.error(e);
        debugLog(`openExistingVault FAILED: ${e instanceof Error ? e.message : String(e)}`);
        toast.show({
          message: e instanceof Error ? e.message : "Couldn’t open that folder. Please try again.",
          durationMs: 7000,
        });
      } finally {
        setOpeningVault(null);
      }
    },
    [openingVault, loadVault]
  );

  // Pick a brand-new vault folder, then open it.
  const openVault = useCallback(async () => {
    let path: string | null;
    try {
      path = await pickVaultFolder();
    } catch (e) {
      // User dismissed the picker (AbortError) — say nothing, that was intentional.
      if (e instanceof DOMException && e.name === "AbortError") return;
      // A real failure: unsupported browser, or the FSA picker threw. Tell the user why.
      console.error(e);
      toast.show({
        message: e instanceof Error ? e.message : "Couldn’t open that folder. Please try again.",
        durationMs: 7000,
      });
      return;
    }
    if (!path) return; // picker returned nothing (also a quiet cancel)
    setOpeningVault("new");
    try {
      const { settings: loaded, id } = await loadVault(path);
      await openStartupRef.current?.(loaded, id);
    } catch (e) {
      // The folder was picked but couldn't be read/indexed (permissions, gone mid-flight, …).
      console.error(e);
      toast.show({
        message: e instanceof Error ? e.message : "Couldn’t open that vault. Please try again.",
        durationMs: 7000,
      });
    } finally {
      setOpeningVault(null);
    }
  }, [loadVault]);

  // Re-open a vault from the Start screen's recent list. On the browser this re-grants the folder
  // permission first; that, and the folder read, can each fail — so we surface a clear, actionable
  // message (and a one-tap "Open folder" fallback) instead of doing nothing on click.
  const openRecent = useCallback(
    async (id: string) => {
      if (openingVault) return; // a vault is already opening — ignore the double-click
      setOpeningVault(id);
      try {
        if (isAndroid()) {
          // On Android the id is the vault *name*; open_app_vault opens it server-side
          // and returns its tree (no path, no folder dialog).
          const t = await openAppVault(id);
          const { settings: loaded, id: vid } = await loadVaultFromTree(t, t.name);
          await openStartupRef.current?.(loaded, vid);
          return;
        }
        const path = await resolveRecentVault(id);
        const { settings: loaded, id: vid } = await loadVault(path);
        await openStartupRef.current?.(loaded, vid);
      } catch (e) {
        console.error(e);
        if (isRecentVaultError(e)) {
          // A dead recent (folder moved/deleted, or no longer saved) has already been pruned in the
          // data layer; refresh the Start screen's list so it stops offering it.
          if (e.prune) setRecentsNonce((n) => n + 1);
          toast.show({
            message: e.message,
            // Offer the manual picker as an escape hatch for declined-permission / missing cases.
            action: { label: "Open folder", run: () => void openVault() },
            durationMs: 8000,
          });
        } else {
          // Desktop open_vault failure (e.g. folder deleted while the Start screen was open), or any
          // other unexpected error.
          toast.show({
            message: e instanceof Error ? e.message : "Couldn’t open that vault. Please try again.",
            action: { label: "Open folder", run: () => void openVault() },
            durationMs: 8000,
          });
        }
      } finally {
        setOpeningVault(null);
      }
    },
    [loadVault, loadVaultFromTree, openVault, openingVault]
  );

  // Return to the Start screen to pick a different vault. The open document state is
  // cleared so nothing from the old vault leaks into the next one.
  const switchVault = useCallback(() => {
    setTree(null);
    setVaultName("");
    vaultIdRef.current = null;
    setActivePath(null);
    setActiveAsset(null);
    setBody("");
    setFrontmatter({});
    setTab("editor");
    setBooting(false);
    // Drop all open tabs + history so nothing from the old vault leaks into the next.
    setOpenDocs([]);
    histRef.current = [];
    histIdx.current = -1;
  }, []);

  // ---- Boot: auto-open the most recently used vault, if any. ----
  // Desktop re-opens silently from the saved path. The browser can only re-open a
  // persisted handle if its permission is still granted from this session; if it would
  // need a fresh prompt (which browsers block outside a click), resolveRecentVault
  // throws and we simply fall through to the Start screen, where one tap re-grants it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const recents = await listRecentVaults();
        if (cancelled || recents.length === 0) return;
        const path = await resolveRecentVault(recents[0].id);
        if (cancelled || !path) return;
        const { settings: loaded, id } = await loadVault(path);
        if (!cancelled) await openStartupRef.current?.(loaded, id);
      } catch (e) {
        // Most-recent vault gone or needs a gesture — show the Start screen instead.
        console.error(e);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadVault]);

  // Remember the page currently open, per vault, so "open last page" on the next launch can restore
  // it. Keyed by vault id in localStorage (see lastPageKey) — volatile state, kept out of settings.
  useEffect(() => {
    const id = vaultIdRef.current;
    if (id && activePath) writeLastPage(id, activePath);
  }, [activePath]);

  // True while replaying a back/forward navigation, so the open* helpers don't push a new history
  // entry for a move that's just walking the existing stack.
  const replaying = useRef(false);

  // Add `path` to the open-tabs strip if it isn't already there.
  const addTab = useCallback((path: string, kind: DocKind) => {
    setOpenDocs((prev) => (prev.some((d) => d.path === path) ? prev : [...prev, { path, kind }]));
  }, []);

  // Record a navigation to `path` in history, unless we're replaying back/forward or it's already
  // the current entry. Truncates any forward entries (browser-style).
  const pushHistory = useCallback((path: string) => {
    if (replaying.current) return;
    if (histRef.current[histIdx.current] === path) return;
    histRef.current = [...histRef.current.slice(0, histIdx.current + 1), path];
    histIdx.current = histRef.current.length - 1;
    setHistTick((n) => n + 1);
  }, []);

  // Open a page in the editor. When `taskLine` is given (a click on a task in the calendar agenda
  // or Tasks panel), scroll to that task's row and flash it once the editor has rendered.
  const openPage = useCallback(
    async (relPath: string, taskLine?: number) => {
      const doc = await api.readPage(relPath);
      setActiveAsset(null);
      setActiveDb(null);
      setActiveFolder(null);
      setActivePath(relPath);
      setBody(doc.body);
      setFrontmatter(doc.frontmatter as Record<string, unknown>);
      const key = relPath + ":" + Date.now();
      setReloadKey(key);
      setTab("editor");
      setDirty(false);
      addTab(relPath, "page");
      pushHistory(relPath);
      closeLeftOnMobile();
      if (taskLine != null) {
        const ordinal = taskOrdinalForLine(doc.body, taskLine);
        // Scope the flash to the editor that mounts for THIS key, so the poll waits out the
        // AnimatePresence crossfade instead of flashing a row on the outgoing page.
        if (ordinal != null) flashTaskRow(ordinal, key);
      }
    },
    [addTab, pushHistory, closeLeftOnMobile]
  );

  // An inline TASK query block toggled a checkbox on disk. Refresh task-derived views, and if the
  // toggle hit the file currently open in the editor, re-open it so its own rendered checkboxes
  // reflect the change (otherwise they stay stale until a manual reload).
  const onTaskToggled = useCallback(
    (relPath: string) => {
      setTaskRefresh((k) => k + 1);
      if (relPath === activePath) void openPage(relPath);
    },
    [activePath, openPage]
  );

  // Open a non-markdown file (PDF, image, …) in the viewer pane instead of the editor.
  const openAsset = useCallback(
    (node: TreeNode) => {
      setActiveAsset(node);
      setActiveDb(null);
      setActiveFolder(null);
      setActivePath(node.rel_path);
      setTab("editor");
      addTab(node.rel_path, "asset");
      pushHistory(node.rel_path);
      closeLeftOnMobile();
    },
    [addTab, pushHistory, closeLeftOnMobile]
  );

  // Open a database folder in the table view (a third "doc" kind alongside pages and assets).
  const openDatabase = useCallback(
    (node: TreeNode) => {
      setActiveAsset(null);
      setActiveDb(node);
      setActiveFolder(null);
      setActivePath(node.rel_path);
      setReloadKey(node.rel_path + ":" + Date.now());
      setTab("editor");
      setDirty(false);
      addTab(node.rel_path, "db");
      pushHistory(node.rel_path);
      closeLeftOnMobile();
    },
    [addTab, pushHistory, closeLeftOnMobile]
  );

  // Open a plain folder "as a page": show its direct children (subfolders + pages) as a gallery.
  // A fourth doc kind alongside pages, assets, and databases.
  const openFolder = useCallback(
    (node: TreeNode) => {
      setActiveAsset(null);
      setActiveDb(null);
      setActiveFolder(node);
      setActivePath(node.rel_path);
      setReloadKey(node.rel_path + ":" + Date.now());
      setTab("editor");
      setDirty(false);
      addTab(node.rel_path, "folder");
      pushHistory(node.rel_path);
      closeLeftOnMobile();
    },
    [addTab, pushHistory, closeLeftOnMobile]
  );

  // Single dispatcher: open any tree node in its natural view (database/folder gallery for dirs,
  // editor for markdown, viewer for other assets). Used by the folder gallery's card clicks.
  const openNode = useCallback(
    (node: TreeNode) => {
      if (node.is_dir) {
        if (node.is_database) openDatabase(node);
        else openFolder(node);
      } else if (node.ext === "") {
        void openPage(node.rel_path);
      } else {
        openAsset(node);
      }
    },
    [openDatabase, openFolder, openPage, openAsset]
  );

  // Find a node anywhere in the tree by rel_path (used to re-open an asset tab/history entry,
  // which only stores the path).
  const findNode = useCallback(
    (relPath: string): TreeNode | null => {
      let found: TreeNode | null = null;
      const visit = (n: TreeNode) => {
        if (found) return;
        if (n.rel_path === relPath) found = n;
        else n.children.forEach(visit);
      };
      if (tree) tree.children.forEach(visit);
      return found;
    },
    [tree]
  );

  // A folder crumb in a breadcrumb was clicked: open that folder as a gallery page (its natural
  // view), and reveal it in the tree for orientation. Falls back to a tree reveal if the node
  // can't be resolved (e.g. mid-refresh).
  const openFolderCrumb = useCallback(
    (folderRelPath: string) => {
      const node = findNode(folderRelPath);
      if (node) openNode(node);
      treeRevealRef.current?.(folderRelPath);
    },
    [findNode, openNode]
  );

  // Activate an already-known doc (tab click / history replay) by path, picking page/asset/db.
  const activateDoc = useCallback(
    (path: string, kind: DocKind) => {
      if (kind === "asset") {
        const node = findNode(path);
        if (node) openAsset(node);
      } else if (kind === "db") {
        const node = findNode(path);
        if (node) openDatabase(node);
      } else if (kind === "folder") {
        const node = findNode(path);
        if (node) openFolder(node);
      } else {
        openPage(path);
      }
    },
    [findNode, openPage, openAsset, openDatabase, openFolder]
  );

  // Switch to an open tab without recording new history.
  const selectTab = useCallback(
    (path: string) => {
      if (path === activePath) return;
      const doc = openDocs.find((d) => d.path === path);
      if (!doc) return;
      replaying.current = true;
      try {
        activateDoc(path, doc.kind);
        // Selecting a tab is still a navigation — record it so back returns here.
        replaying.current = false;
        pushHistory(path);
      } finally {
        replaying.current = false;
      }
    },
    [activePath, openDocs, activateDoc, pushHistory]
  );

  // Move the history cursor by delta (−1 back, +1 forward), skipping entries whose tab was closed.
  const navHistory = useCallback(
    (delta: number) => {
      let next = histIdx.current + delta;
      while (next >= 0 && next < histRef.current.length) {
        const path = histRef.current[next];
        const doc = openDocs.find((d) => d.path === path);
        if (doc) {
          histIdx.current = next;
          setHistTick((n) => n + 1);
          replaying.current = true;
          try {
            activateDoc(path, doc.kind);
          } finally {
            replaying.current = false;
          }
          return;
        }
        next += delta; // closed tab — keep moving the same direction
      }
    },
    [openDocs, activateDoc]
  );

  // Close a tab. If it was active, fall back to the right neighbour (or left if last). Removes the
  // path from history so back/forward won't resurrect it.
  const closeTab = useCallback(
    (path: string) => {
      const i = openDocs.findIndex((d) => d.path === path);
      if (i === -1) return;
      const next = openDocs.filter((d) => d.path !== path);
      setOpenDocs(next);
      // Scrub from history, fixing the cursor.
      const before = histRef.current.slice(0, histIdx.current + 1).filter((p) => p === path).length;
      histRef.current = histRef.current.filter((p) => p !== path);
      histIdx.current = Math.max(-1, Math.min(histIdx.current - before, histRef.current.length - 1));
      setHistTick((n) => n + 1);
      // Re-activate a neighbour only if we closed the active doc.
      if (activePath === path) {
        const fallback = next[i] ?? next[i - 1] ?? null;
        if (fallback) {
          replaying.current = true;
          try {
            activateDoc(fallback.path, fallback.kind);
          } finally {
            replaying.current = false;
          }
        } else {
          setActivePath(null);
          setActiveAsset(null);
          setActiveDb(null);
          setBody("");
          setFrontmatter({});
        }
      }
    },
    [openDocs, activePath, activateDoc]
  );

  // Apply a tree-row click to the multi-selection set.
  // - plain click: selection becomes just this row (and the row opens, handled in FileTree)
  // - ctrl/cmd click: toggle this row in/out, keeping the rest
  // - shift click: select the whole resolved range (replaces the current selection)
  const onSelect = useCallback(
    (node: TreeNode, mods: SelectMods, range: string[]) => {
      setSelected((prev) => {
        if (mods.range) return new Set(range);
        if (mods.toggle) {
          const next = new Set(prev);
          next.has(node.rel_path) ? next.delete(node.rel_path) : next.add(node.rel_path);
          return next;
        }
        return new Set([node.rel_path]);
      });
    },
    []
  );

  // Templates available in the configured Templates folder (plain `.md` pages with {{variables}}).
  const templates = useMemo<TemplateInfo[]>(
    () => collectTemplates(tree, settings.templates_folder),
    [tree, settings.templates_folder]
  );

  // A FillContext that prompts for custom {{variables}} via the in-app dialog and resolves built-in
  // date/time tokens against the user's configured formats. `extra` adds title/period overrides.
  const makeFillCtx = useCallback(
    (extra?: Partial<FillContext>): FillContext => ({
      formats: { dateFormat: settings.date_format, timeFormat: settings.time_format },
      dailyFormat: settings.periodic_label_format,
      vaultName,
      prompt: (_key, label) =>
        dialogs.prompt({ title: "Fill template", message: label, placeholder: label }),
      ...extra,
    }),
    [settings.date_format, settings.time_format, settings.periodic_label_format, vaultName]
  );

  // Read a template file and return its variable-filled body + frontmatter, or null if the user
  // cancelled a prompt (or the template is unreadable). Built-in tokens never prompt.
  const applyTemplate = useCallback(
    async (relPath: string, extra?: Partial<FillContext>): Promise<{ body: string; frontmatter: Record<string, unknown> } | null> => {
      try {
        const doc = await api.readPage(relPath);
        return await fillTemplate(doc.body, doc.frontmatter, makeFillCtx(extra));
      } catch (e) {
        console.error("Failed to apply template:", e);
        return null;
      }
    },
    [makeFillCtx]
  );

  // Open or create a periodic note. When the note doesn't exist yet we create it from the period's
  // bound template (settings.periodic_templates) if one is set, else the built-in `fallbackBody`.
  // `period`/`periodDate` enable the {{period}}/{{periodStart}}/{{periodEnd}} tokens in templates.
  const openPeriodic = useCallback(
    async (relPath: string, fallbackBody: string, period?: Period, periodDate?: Date) => {
      try {
        await api.readPage(relPath);
      } catch {
        let body = fallbackBody;
        const bound = period ? settings.periodic_templates[period] : undefined;
        if (bound) {
          const leaf = (relPath.split("/").pop() ?? relPath).replace(/\.md$/i, "");
          const filled = await applyTemplate(bound, { title: leaf, date: periodDate, period, periodDate, relPath });
          if (filled) body = stripCursor(filled.body); // null = cancelled prompt → keep built-in starter
        }
        await api.createPage(relPath, body);
        await refreshTree();
      }
      await openPage(relPath);
    },
    [openPage, refreshTree, settings.periodic_templates, applyTemplate]
  );

  // Apply the vault's configured startup behaviour after it loads (see Settings → Vault → "On open"):
  //  - "today": open/create today's daily note;
  //  - "page":  open the chosen page (falls back to last-page if it's gone);
  //  - "last":  reopen the page that was active when this vault was last closed.
  // Takes the freshly-loaded settings + vault id explicitly so it doesn't race the `settings` state
  // update from loadVault. A missing target page is a silent no-op (lands on the empty editor).
  const openStartupDoc = useCallback(
    async (loaded: Settings, vaultId: string) => {
      const exists = async (rel: string) => {
        try {
          await api.readPage(rel);
          return true;
        } catch {
          return false;
        }
      };
      if (loaded.startup_behavior === "today") {
        const today = new Date();
        const rel = pathFor(loaded.periodic_folder, "daily", today);
        await openPeriodic(rel, template("daily", today, loaded.periodic_label_format), "daily", today);
        return;
      }
      if (loaded.startup_behavior === "page" && loaded.startup_page && (await exists(loaded.startup_page))) {
        await openPage(loaded.startup_page);
        return;
      }
      // "last" (or a "page" target that no longer exists): restore the remembered page if still there.
      const last = readLastPage(vaultId);
      if (last && (await exists(last))) await openPage(last);
    },
    [openPage, openPeriodic]
  );
  openStartupRef.current = openStartupDoc;

  // Editor context-menu "Send to": MOVE the task line (and its subtasks) under the caret into a
  // periodic note — the same action as the Tasks view's "Send to", not a due-date stamp. `line` is
  // the 0-based index of the task in the live editor's serialized markdown; we flush the open doc to
  // disk first so that index lines up with what `moveTaskBlock` reads. If the destination note
  // doesn't exist we ask before creating it (from the period's bound template, else the starter).
  const onSendTaskFromEditor = useCallback(
    async (line: number, target: { period: Period; date: Date }) => {
      if (!activePath) return;
      const toRel = pathFor(settings.periodic_folder, target.period, target.date);
      const label = labelFor(target.period, target.date, settings.periodic_label_format);
      if (toRel === activePath) {
        toast.show({ message: "That task is already in this note." });
        return;
      }
      try {
        // Flush the open document so the on-disk body matches the line index we were handed.
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        await api.writePage(activePath, frontmatter, body);
        setDirty(false);

        // Ensure the destination exists — warn before creating it, then build from the template.
        let exists = true;
        try {
          await api.readPage(toRel);
        } catch {
          exists = false;
        }
        if (!exists) {
          const ok = await dialogs.confirm({
            title: "Create destination note?",
            message: `“${label}” doesn’t exist yet. It will be created from the ${target.period} template before the task is moved there.`,
            confirmLabel: "Create & move",
          });
          if (!ok) return;
          let starter = template(target.period, target.date, settings.periodic_label_format);
          const bound = settings.periodic_templates[target.period];
          if (bound) {
            const leaf = (toRel.split("/").pop() ?? toRel).replace(/\.md$/i, "");
            const filled = await applyTemplate(bound, {
              title: leaf, date: target.date, period: target.period, periodDate: target.date, relPath: toRel,
            });
            if (filled) starter = stripCursor(filled.body); // null = cancelled prompt → keep starter
          }
          await api.createPage(toRel, starter);
          await refreshTree();
        }

        await api.moveTaskBlock(activePath, line, toRel);
        // Reload the editor so the moved task disappears from the current doc, and refresh tasks.
        const doc = await api.readPage(activePath);
        setBody(doc.body);
        setFrontmatter(doc.frontmatter);
        setReloadKey(activePath + ":" + Date.now());
        setTaskRefresh((k) => k + 1);
        toast.show({
          message: `Moved to ${label}`,
          action: { label: "Open", run: () => openPage(toRel) },
        });
      } catch (e) {
        console.error(e);
        toast.show({ message: "Couldn’t move the task." });
      }
    },
    [activePath, body, frontmatter, settings.periodic_folder, settings.periodic_label_format,
     settings.periodic_templates, applyTemplate, refreshTree, openPage]
  );

  const onEditorChange = useCallback(
    (md: string) => {
      setBody(md);
      setDirty(true);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
        if (!activePath) return;
        await api.writePage(activePath, frontmatter, md);
        setDirty(false);
        setTaskRefresh((k) => k + 1);
      }, 600);
    },
    [activePath, frontmatter]
  );

  // Create a page. When `name` is omitted we prompt (sidebar ＋ button); when provided (the editor's
  // `/page` command) we skip the prompt. Returns the created page's display name so the caller can
  // link to it, or null if nothing was created.
  const newPage = useCallback(
    async (name?: string): Promise<string | null> => {
      const input =
        name ??
        (await dialogs.prompt({ title: "New page", placeholder: "Notes/Idea" })) ??
        "";
      if (!input.trim()) return null;
      const rel = input.endsWith(".md") ? input : `${input}.md`;
      const display = (rel.split("/").pop() ?? rel).replace(/\.md$/i, "");
      try {
        await api.createPage(rel, `# ${display}\n\n`);
      } catch (e) {
        // Most likely the file already exists — still let the caller link to it.
        console.error(e);
      }
      await refreshTree();
      // When invoked from the sidebar (no name passed) open the new page in the editor.
      if (name === undefined) await openPage(rel);
      return display;
    },
    [refreshTree, openPage]
  );

  // Create a standalone page from a template (sidebar + menu / command palette). Prompts for the
  // page name, fills the template's {{variables}} against it, writes body + frontmatter, and opens
  // it. A null `templateRel` (or cancelled prompt) aborts silently.
  const newPageFromTemplate = useCallback(
    async (templateRel: string | null, parentRel = "") => {
      if (!templateRel) return;
      const input = await dialogs.prompt({ title: "New page from template", placeholder: "Notes/Idea" });
      if (!input?.trim()) return;
      // Land the page inside `parentRel` (a right-clicked folder) unless the user typed an absolute
      // path of their own. A leading "/" or an explicit nested path opts out of the parent prefix.
      const typed = input.trim().replace(/^\/+/, "");
      const base = parentRel && !input.trim().startsWith("/") ? `${parentRel}/${typed}` : typed;
      const rel = base.endsWith(".md") ? base : `${base}.md`;
      const display = (rel.split("/").pop() ?? rel).replace(/\.md$/i, "");
      const filled = await applyTemplate(templateRel, { title: display, relPath: rel });
      if (!filled) return; // cancelled a variable prompt
      const filledBody = stripCursor(filled.body); // file create — no live caret to place
      try {
        await api.createPage(rel, filledBody);
        if (Object.keys(filled.frontmatter).length) {
          await api.writePage(rel, filled.frontmatter, filledBody);
        }
      } catch (e) {
        console.error(e);
      }
      await refreshTree();
      await openPage(rel);
    },
    [applyTemplate, refreshTree, openPage]
  );

  // Create a new template file (sidebar + menu). Prompts for a name, creates it inside the configured
  // templates folder with a starter body showing the {{variable}} syntax, and opens it for editing.
  const newTemplate = useCallback(async () => {
    const input = await dialogs.prompt({ title: "New template", placeholder: "Meeting Notes" });
    const name = input?.trim().replace(/\.md$/i, "");
    if (!name) return;
    const folder = settings.templates_folder.replace(/^\/+|\/+$/g, "");
    const rel = `${folder ? folder + "/" : ""}${name}.md`;
    // Starter that demonstrates a built-in token and a prompted one, so the syntax is discoverable.
    const starter = `# {{title}}\n\nCreated {{date}}\n\n`;
    try {
      await api.createPage(rel, starter);
    } catch (e) {
      console.error(e);
    }
    await refreshTree();
    await openPage(rel);
  }, [settings.templates_folder, refreshTree, openPage]);

  // Save a pasted/dropped image into the vault's `.attachments` folder and hand the editor back its
  // vault-relative path (inserted as a markdown image). No tree refresh: `.attachments` is a
  // dotfolder, hidden from the tree, so nothing visible changes.
  const addAttachment = useCallback(
    async ({ bytes, mime, name }: { bytes: Uint8Array; mime: string; name?: string }): Promise<string | null> => {
      try {
        const rel = attachmentRelPath(mime, name);
        await api.writeAsset(rel, bytes);
        return rel;
      } catch (e) {
        console.error("Failed to save attachment:", e);
        return null;
      }
    },
    []
  );

  // An image was deleted from a note and its `.attachments` file is now orphaned. Ask what to do
  // with the file: keep it (dismiss), move it to Trash (recoverable), or delete it permanently.
  const onAttachmentRemoved = useCallback((relPath: string) => {
    const leaf = relPath.split("/").pop() ?? relPath;
    void (async () => {
      const choice = await dialogs.choose({
        title: "Delete image file?",
        message: `“${leaf}” is no longer used in this note. Keep the file, move it to Trash (recoverable), or delete it permanently?`,
        cancelLabel: "Keep file",
        options: [
          { label: "Move to Trash", value: "trash" },
          { label: "Delete permanently", value: "delete", danger: true },
        ],
      });
      try {
        if (choice === "trash") await api.trashPage(relPath);
        else if (choice === "delete") await api.deletePage(relPath);
        // null / dismiss → keep the file in `.attachments`.
      } catch (e) {
        await dialogs.alert({ title: "Couldn’t remove the image file", message: String(e) });
      }
    })();
  }, []);

  // Create a database (folder + `.pinpoint-db.json` schema). When `name` is omitted we prompt
  // (sidebar use); when provided (the editor's `/database` command) we skip the prompt. Returns the
  // created database's rel_path so the editor can link to it, or null if nothing was created.
  const newDatabase = useCallback(
    async (name?: string): Promise<string | null> => {
      const input =
        name ??
        (await dialogs.prompt({ title: "New database", placeholder: "Projects" })) ??
        "";
      const rel = input.trim().replace(/\.md$/i, "");
      if (!rel) return null;
      const display = rel.split("/").pop() ?? rel;
      try {
        await api.createDatabase(rel, display);
      } catch (e) {
        // Most likely the folder already exists — still let the caller link to it.
        console.error(e);
      }
      await refreshTree();
      // Open the new (empty) database in the table view. The freshly-created folder has no rows
      // yet, so a synthesized node is sufficient; later loads re-read children from the tree.
      const dbNode: TreeNode = {
        name: display,
        rel_path: rel,
        is_dir: true,
        is_database: true,
        ext: "",
        children: [],
      };
      openDatabase(dbNode);
      return rel;
    },
    [refreshTree, openDatabase]
  );

  // Create a plain folder (the sidebar ＋ menu). Prompts for a name, then refreshes the tree so
  // the new — possibly empty — folder appears. Nothing is opened: a folder has no view of its own.
  const newFolder = useCallback(
    async (name?: string): Promise<string | null> => {
      const input =
        name ??
        (await dialogs.prompt({ title: "New folder", placeholder: "Projects" })) ??
        "";
      const rel = input.trim().replace(/\.md$/i, "").replace(/^\/+|\/+$/g, "");
      if (!rel) return null;
      try {
        await api.createFolder(rel);
      } catch (e) {
        await dialogs.alert({ title: "Couldn’t create folder", message: String(e) });
        return null;
      }
      await refreshTree();
      return rel;
    },
    [refreshTree]
  );

  // Convert an existing folder into a database in place (explorer "Convert to Database" action).
  // Writes a default schema into the folder; its `.md` files become rows. Refreshes the tree, then
  // opens the now-database folder in the table view.
  const convertToDatabase = useCallback(
    async (node: TreeNode) => {
      const display = node.name;
      try {
        await api.convertToDatabase(node.rel_path, display);
      } catch (e) {
        await dialogs.alert({ title: "Couldn’t convert folder", message: String(e) });
        return;
      }
      await refreshTree();
      openDatabase({ ...node, is_database: true });
    },
    [refreshTree, openDatabase]
  );

  // Apply the create dialog's result: join the chosen folder + leaf name into a full rel path and
  // dispatch to the matching creator. Each creator already accepts a full path and skips its prompt.
  const runCreate = useCallback(
    async (kind: CreateKind, leaf: string, parentRel: string) => {
      const rel = parentRel ? `${parentRel}/${leaf}` : leaf;
      setCreate(null);
      if (kind === "page") {
        const full = rel.endsWith(".md") ? rel : `${rel}.md`;
        await newPage(full);
        await openPage(full);
      } else if (kind === "folder") {
        await newFolder(rel);
      } else {
        await newDatabase(rel);
      }
    },
    [newPage, openPage, newFolder, newDatabase]
  );

  // Database folders, for resolving `/database` wikilinks and the command palette.
  const databases = useMemo(() => {
    const out: { name: string; rel_path: string }[] = [];
    const visit = (n: TreeNode) => {
      if (n.is_dir && n.is_database) out.push({ name: n.name, rel_path: n.rel_path });
      n.children.forEach(visit);
    };
    if (tree) tree.children.forEach(visit);
    return out;
  }, [tree]);

  // The database folder the active page is a row of, or null. A page is a database row when its
  // immediate parent folder is a database; the properties panel keys off this.
  const activePageDb = useMemo(() => {
    if (!activePath || activeAsset || activeDb) return null;
    const slash = activePath.lastIndexOf("/");
    if (slash < 0) return null;
    const parent = activePath.slice(0, slash);
    return databases.find((d) => d.rel_path === parent) ?? null;
  }, [activePath, activeAsset, activeDb, databases]);

  // Whether the active page lives in the Templates folder (so the template builder bar applies).
  // A periodic template (one bound under Periodic/<Kind>) also gets the {{period}} chips.
  const activeTemplate = useMemo(() => {
    if (!activePath || activeAsset || activeDb) return null;
    const folder = settings.templates_folder.replace(/^\/+|\/+$/g, "");
    if (!folder || !activePath.startsWith(`${folder}/`)) return null;
    // Show the {{period}} chips when this exact path is bound to a period in settings.
    const isPeriodic = Object.values(settings.periodic_templates).includes(activePath);
    return { isPeriodic };
  }, [activePath, activeAsset, activeDb, settings.templates_folder, settings.periodic_templates]);

  // Persist a database-row page's properties (frontmatter), keeping App's frontmatter state in sync
  // so the body-save loop never writes a stale map back over a property edit.
  const setRowFields = useCallback(
    (fields: Record<string, unknown>) => {
      if (!activePath) return;
      setFrontmatter(fields);
      api.writePage(activePath, fields, body).catch(console.error);
      setTaskRefresh((k) => k + 1);
    },
    [activePath, body]
  );

  // Rename the active database-row page from the properties panel's title field. The title of a row
  // is its file name, so this is a path rename; reuse `commitRename` (which remaps open tabs +
  // history and re-opens the moved page) by resolving the active node.
  const renameRowTitle = useCallback(
    (title: string) => {
      if (!activePath) return;
      const node = findNode(activePath);
      if (node) void commitRename(node, title);
    },
    [activePath, findNode]
  );

  // Flat list of markdown pages for the editor's `/link` slash command and wikilink resolution.
  // Declared before the callbacks below so they can reference it without a TDZ error.
  const pages = useMemo(() => {
    const out: { name: string; rel_path: string }[] = [];
    const visit = (n: TreeNode) => {
      if (!n.is_dir && n.ext === "") out.push({ name: n.name.replace(/\.md$/i, ""), rel_path: n.rel_path });
      n.children.forEach(visit);
    };
    if (tree) tree.children.forEach(visit);
    return out;
  }, [tree]);

  // Set of all existing markdown page rel_paths, so the calendar can show which days already
  // have a daily note (and which don't).
  const pagePaths = useMemo(() => new Set(pages.map((p) => p.rel_path)), [pages]);

  // Flat, depth-tagged list of every (non-database) folder, in tree order, for the mobile
  // quick-capture "New note" destination picker. Databases are excluded — a note isn't a row.
  const folders = useMemo<FolderOption[]>(() => {
    const out: FolderOption[] = [];
    const visit = (n: TreeNode, depth: number) => {
      if (n.is_dir && !n.is_database) {
        out.push({ path: n.rel_path, depth });
        n.children.forEach((c) => visit(c, depth + 1));
      }
    };
    if (tree) tree.children.forEach((c) => visit(c, 0));
    return out;
  }, [tree]);

  // ---- Mobile quick capture ----

  // Append a task line to today's daily note (creating it from the daily template if missing).
  // The note is created silently in the background — the user stays on their current page and gets
  // a toast with an Open action. Keeping capture frictionless: a task you jot mid-flow shouldn't
  // yank you out of the note you're in.
  const quickAddTask = useCallback(
    async (text: string) => {
      const today = new Date();
      const rel = pathFor(settings.periodic_folder, "daily", today);
      const label = labelFor("daily", today, settings.periodic_label_format);
      try {
        // Ensure today's note exists, building it from the bound daily template (else the starter).
        let exists = true;
        try {
          await api.readPage(rel);
        } catch {
          exists = false;
        }
        if (!exists) {
          let starter = template("daily", today, settings.periodic_label_format);
          const bound = settings.periodic_templates.daily;
          if (bound) {
            const leaf = (rel.split("/").pop() ?? rel).replace(/\.md$/i, "");
            const filled = await applyTemplate(bound, {
              title: leaf, date: today, period: "daily", periodDate: today, relPath: rel,
            });
            if (filled) starter = stripCursor(filled.body); // null = cancelled prompt → keep starter
          }
          await api.createPage(rel, starter);
          await refreshTree();
        }
        // Append the task, keeping a single trailing newline.
        const doc = await api.readPage(rel);
        const trimmed = doc.body.replace(/\s*$/, "");
        const next = `${trimmed}\n- [ ] ${text}\n`;
        await api.writePage(rel, doc.frontmatter as Record<string, unknown>, next);
        setTaskRefresh((k) => k + 1);
        // If today's note happens to be the open doc, reload it so the new task shows immediately.
        if (activePath === rel) {
          setBody(next);
          setReloadKey(rel + ":" + Date.now());
        }
        toast.show({
          message: `Added to ${label}`,
          action: { label: "Open", run: () => void openPage(rel) },
        });
      } catch (e) {
        console.error(e);
        toast.show({ message: "Couldn’t add the task." });
      }
    },
    [settings.periodic_folder, settings.periodic_label_format, settings.periodic_templates,
     applyTemplate, refreshTree, openPage, activePath]
  );

  // Create a new note under `parentRel` ("" = vault root) and open it. Delegates to newPage, which
  // creates the file, refreshes the tree, and opens it in the editor.
  const quickNewNote = useCallback(
    async (title: string, parentRel: string) => {
      const leaf = title.trim().replace(/\.md$/i, "");
      if (!leaf) return;
      const rel = (parentRel ? `${parentRel}/${leaf}` : leaf) + ".md";
      await newPage(rel);
      await openPage(rel);
    },
    [newPage, openPage]
  );

  // Every tag in the vault, fed to the editor's `#` autocomplete. Refreshed on the same signal as
  // tasks (saves, reindex, file-watcher), so newly-typed tags become suggestable across pages.
  const [allTags, setAllTags] = useState<string[]>([]);
  useEffect(() => {
    if (!tree) return;
    api
      .listTags()
      .then((ts) => setAllTags(ts.map((t) => t.tag)))
      .catch(console.error);
  }, [tree, taskRefresh]);

  // Resolve a `[[wikilink]]` name to a page and open it, creating the page if it doesn't exist yet.
  const openPageByName = useCallback(
    async (name: string) => {
      const target = name.trim();
      if (!target) return;
      const lower = target.toLowerCase();
      // A wikilink may point at a database folder (e.g. the `/database` command's link). Resolve
      // those to the table view before falling back to page matching.
      const db =
        databases.find((d) => d.name.toLowerCase() === lower) ??
        databases.find((d) => d.rel_path.toLowerCase() === lower);
      if (db) {
        const node = findNode(db.rel_path);
        if (node) {
          openDatabase(node);
          return;
        }
      }
      const match =
        pages.find((p) => p.name.toLowerCase() === lower) ??
        pages.find((p) => p.rel_path.replace(/\.md$/i, "").toLowerCase() === lower);
      if (match) {
        await openPage(match.rel_path);
        return;
      }
      // Unresolved link — create the page (under the typed path) then open it.
      await newPage(target);
      const rel = target.endsWith(".md") ? target : `${target}.md`;
      await openPage(rel);
    },
    [pages, databases, findNode, openDatabase, openPage, newPage]
  );

  const saveSettings = async (s: Settings) => {
    setSettings(s);
    await api.saveSettings(s);
  };

  // ---- Zoom: scale the WHOLE UI (Ctrl +/-/0). Applied as `zoom` on the body (see the theming
  //      effect) and persisted as settings.ui_zoom, so it survives restarts. `delta` is an additive
  //      step in zoom factor (e.g. +0.1 = +10%); "reset" returns to 100%. ----
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2.0;
  const ZOOM_STEP = 0.1;
  const changeZoom = useCallback(
    (delta: number | "reset") => {
      setSettings((prev) => {
        const cur = prev.ui_zoom || 1;
        // Round to one decimal so repeated steps don't accumulate float drift (1.0999999…).
        const raw = delta === "reset" ? 1 : cur + delta;
        const next = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw)) * 10) / 10;
        if (next === cur) return prev;
        const updated = { ...prev, ui_zoom: next };
        api.saveSettings(updated).catch(console.error);
        return updated;
      });
    },
    []
  );

  // ---- Page width: the editor ruler (Ctrl+R). Persisted as settings.page_width and applied to
  //      every page via the --page-width CSS variable, so it travels with the vault. Clamped to a
  //      sane reading range; no-op writes are skipped so a drag that lands on the same value
  //      doesn't touch disk. ----
  const PAGE_WIDTH_MIN = 480;
  const PAGE_WIDTH_MAX = 1400;
  const setPageWidth = useCallback((px: number) => {
    setSettings((prev) => {
      const next = Math.round(Math.min(PAGE_WIDTH_MAX, Math.max(PAGE_WIDTH_MIN, px)));
      if (next === (prev.page_width || 820)) return prev;
      const updated = { ...prev, page_width: next };
      api.saveSettings(updated).catch(console.error);
      return updated;
    });
  }, []);

  // ---- Per-node icons ----

  // Set or replace the icon for a node, persisting the whole settings blob.
  const setNodeIcon = useCallback(
    async (relPath: string, icon: NodeIcon) => {
      const next: Settings = { ...settings, node_icons: { ...settings.node_icons, [relPath]: icon } };
      await saveSettings(next);
    },
    [settings]
  );

  // Remove a node's icon override (revert to the type default).
  const clearNodeIcon = useCallback(
    async (relPath: string) => {
      if (!settings.node_icons[relPath]) return;
      const node_icons = { ...settings.node_icons };
      delete node_icons[relPath];
      await saveSettings({ ...settings, node_icons });
    },
    [settings]
  );

  // ---- Explorer context-menu actions ----

  // "Rename" menu action: start inline editing of the row in the explorer (Windows Explorer style).
  const renameNode = useCallback((node: TreeNode) => setRenamingPath(node.rel_path), []);

  // Commit an inline rename. `input` is the edited leaf name (no path). Returns to view mode either
  // way. A no-op (empty or unchanged) just cancels.
  const commitRename = useCallback(
    async (node: TreeNode, input: string) => {
      setRenamingPath(null);
      const trimmed = input.trim();
      // The inline editor shows the display name (markdown pages without their `.md`), so compare
      // against the same form to detect a no-op edit.
      const rawLeaf = node.rel_path.split("/").pop() ?? node.rel_path;
      const displayLeaf = node.is_dir || node.ext !== "" ? rawLeaf : rawLeaf.replace(/\.md$/i, "");
      if (!trimmed || trimmed === displayLeaf) return;
      const parent = node.rel_path.includes("/") ? node.rel_path.slice(0, node.rel_path.lastIndexOf("/")) : "";
      // Preserve the markdown extension if the user dropped it on a page.
      let leaf = trimmed;
      if (!node.is_dir && node.ext === "" && !/\.md$/i.test(leaf)) leaf += ".md";
      const toRel = parent ? `${parent}/${leaf}` : leaf;
      try {
        await api.renamePath(node.rel_path, toRel);
      } catch (e) {
        await dialogs.alert({ title: "Rename failed", message: String(e) });
        return;
      }
      // Carry any icon override across to the new path (and re-key descendants for folders).
      setSettings((prev) => {
        const fromPrefix = node.rel_path + "/";
        const toPrefix = toRel + "/";
        let changed = false;
        const node_icons: Record<string, NodeIcon> = {};
        for (const [key, val] of Object.entries(prev.node_icons)) {
          if (key === node.rel_path) {
            node_icons[toRel] = val;
            changed = true;
          } else if (node.is_dir && key.startsWith(fromPrefix)) {
            node_icons[toPrefix + key.slice(fromPrefix.length)] = val;
            changed = true;
          } else {
            node_icons[key] = val;
          }
        }
        if (!changed) return prev;
        const next = { ...prev, node_icons };
        api.saveSettings(next).catch(console.error);
        return next;
      });
      await refreshTree();
      // Re-key any open tabs + history entries for the moved path (and, for a folder, its
      // descendants) so tabs follow the rename instead of pointing at dead paths.
      const fromPrefix = node.rel_path + "/";
      const toPrefix = toRel + "/";
      const remap = (p: string) =>
        p === node.rel_path ? toRel : node.is_dir && p.startsWith(fromPrefix) ? toPrefix + p.slice(fromPrefix.length) : p;
      setOpenDocs((prev) => prev.map((d) => ({ ...d, path: remap(d.path) })));
      histRef.current = histRef.current.map(remap);
      // If the renamed item was the open doc, re-render it from its new path (replaying, so this
      // doesn't add a history entry — we just remapped the existing one).
      if (activePath === node.rel_path) {
        if (node.is_dir) {
          setActivePath(null);
          setActiveAsset(null);
        } else {
          replaying.current = true;
          try {
            if (node.ext === "") await openPage(toRel);
            else openAsset({ ...node, rel_path: toRel, name: leaf });
          } finally {
            replaying.current = false;
          }
        }
      }
      setTaskRefresh((k) => k + 1);
    },
    [activePath, openPage, openAsset, refreshTree]
  );

  // Move one or more nodes into a destination folder (destDir = "" is the vault root) by renaming
  // each to `<destDir>/<leaf>`. This is the drop handler for sidebar drag-and-drop. It reuses the
  // same icon / open-tab / history re-keying as a rename, since a move is a rename to a new parent.
  const moveNodes = useCallback(
    async (paths: string[], destDir: string) => {
      // Resolve each path to its node for ext / is_dir, via a flat tree lookup.
      const byPath = new Map<string, TreeNode>();
      const index = (n: TreeNode) => {
        if (n.rel_path) byPath.set(n.rel_path, n);
        n.children.forEach(index);
      };
      if (tree) index(tree);

      // Skip no-op and invalid moves: a node already in destDir, dropping a folder into itself or a
      // descendant, or dropping onto its own current parent.
      const plans: { from: string; to: string; node: TreeNode }[] = [];
      for (const from of paths) {
        const node = byPath.get(from);
        if (!node) continue;
        const parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
        if (parent === destDir) continue; // already here
        if (node.is_dir && (destDir === from || destDir.startsWith(from + "/"))) continue; // into self/descendant
        const leaf = from.split("/").pop() ?? from;
        const to = destDir ? `${destDir}/${leaf}` : leaf;
        plans.push({ from, to, node });
      }
      if (!plans.length) return;

      // Deepest paths first so a folder's descendants move before the folder itself re-keys them.
      plans.sort((a, b) => b.from.split("/").length - a.from.split("/").length);
      const failed: string[] = [];
      for (const { from, to, node } of plans) {
        try {
          await api.renamePath(from, to);
        } catch (e) {
          failed.push(`${from} → ${to}: ${String(e)}`);
          continue;
        }
        // Carry icon overrides across to the new path (and re-key descendants for folders).
        setSettings((prev) => {
          const fromPrefix = from + "/";
          const toPrefix = to + "/";
          let changed = false;
          const node_icons: Record<string, NodeIcon> = {};
          for (const [key, val] of Object.entries(prev.node_icons)) {
            if (key === from) {
              node_icons[to] = val;
              changed = true;
            } else if (node.is_dir && key.startsWith(fromPrefix)) {
              node_icons[toPrefix + key.slice(fromPrefix.length)] = val;
              changed = true;
            } else {
              node_icons[key] = val;
            }
          }
          if (!changed) return prev;
          const next = { ...prev, node_icons };
          api.saveSettings(next).catch(console.error);
          return next;
        });
        // Re-key open tabs + history entries for the moved path (and a folder's descendants).
        const fromPrefix = from + "/";
        const toPrefix = to + "/";
        const remap = (p: string) =>
          p === from ? to : node.is_dir && p.startsWith(fromPrefix) ? toPrefix + p.slice(fromPrefix.length) : p;
        setOpenDocs((prev) => prev.map((d) => ({ ...d, path: remap(d.path) })));
        histRef.current = histRef.current.map(remap);
        if (activePath === from || (node.is_dir && activePath?.startsWith(fromPrefix))) {
          setActivePath((cur) => (cur ? remap(cur) : cur));
        }
      }
      await refreshTree();
      setSelected(new Set());
      setTaskRefresh((k) => k + 1);
      if (failed.length) {
        await dialogs.alert({ title: "Some moves failed", message: failed.join("\n") });
      }
    },
    [tree, activePath, refreshTree]
  );

  const duplicateNode = useCallback(
    async (node: TreeNode) => {
      // Only pages duplicate cleanly via the page API; assets/folders are excluded in the menu.
      const doc = await api.readPage(node.rel_path);
      const base = node.rel_path.replace(/\.md$/i, "");
      const copyRel = `${base} copy.md`;
      // Drop the source's stable `id` so the copy gets its own (writePage mints a fresh one); two
      // pages sharing an id would break rename link-repair and backlinks.
      const { id: _omitId, ...fmCopy } = doc.frontmatter as Record<string, unknown>;
      await api.writePage(copyRel, fmCopy, doc.body);
      await refreshTree();
      await openPage(copyRel);
    },
    [openPage, refreshTree]
  );

  // Remove every open tab + history entry whose path matches `gone` (a deleted/moved file or any
  // descendant of a deleted folder). If the active doc was among them, fall back to a remaining tab
  // so the pane never points at a vanished file.
  const forgetTabs = useCallback(
    (gone: (path: string) => boolean) => {
      setOpenDocs((prev) => {
        const survivors = prev.filter((d) => !gone(d.path));
        if (survivors.length === prev.length) return prev;
        // Re-activate a survivor if the current doc was removed.
        setActivePath((cur) => {
          if (cur && gone(cur)) {
            const fallback = survivors[survivors.length - 1] ?? null;
            if (fallback) {
              replaying.current = true;
              try {
                activateDoc(fallback.path, fallback.kind);
              } finally {
                replaying.current = false;
              }
              return fallback.path;
            }
            setActiveAsset(null);
            setActiveDb(null);
            setBody("");
            setFrontmatter({});
            return null;
          }
          return cur;
        });
        return survivors;
      });
      histRef.current = histRef.current.filter((p) => !gone(p));
      histIdx.current = Math.min(histIdx.current, histRef.current.length - 1);
      setHistTick((n) => n + 1);
    },
    [activateDoc]
  );

  // ---- Sync-conflict duplicates: cloud sync (Google Drive & co.) resolves a write conflict by
  //      keeping both versions as "<name> (1).md". Detect them after every tree load and offer a
  //      resolution. This matters most for periodic notes: the app always re-opens the canonical
  //      "2026-07-21.md", so edits stranded in the "(1)" copy would otherwise be silently lost. ----

  // Walk the user through resolving one conflict pair (dialog → file ops → Undo toast).
  const resolveSyncConflict = useCallback(
    async (c: SyncConflict) => {
      let origDoc, dupDoc;
      try {
        [origDoc, dupDoc] = await Promise.all([api.readPage(c.original), api.readPage(c.duplicate)]);
      } catch {
        return; // one side vanished since detection (resolved externally) — nothing to do
      }
      const name = (p: string) => p.split("/").pop() ?? p;
      const dupName = name(c.duplicate);
      const origName = name(c.original);
      // Side-by-side compare dialog: shows an aligned line diff of both versions so the user can
      // see exactly what differs before picking a resolution.
      const choice = await conflictDialog.show({
        originalPath: c.original,
        duplicatePath: c.duplicate,
        originalBody: origDoc.body,
        duplicateBody: dupDoc.body,
        identical: origDoc.body.trim() === dupDoc.body.trim(),
        periodic: c.periodic,
      });
      if (!choice) return; // "Later" — re-alerts next launch

      try {
        if (choice === "merge") {
          // Append the copy's unique content to the original (identical/contained bodies collapse),
          // then trash the copy. Undo restores both the original body and the trashed file.
          const merged = mergeBodies(origDoc.body, dupDoc.body);
          await api.writePage(c.original, origDoc.frontmatter as Record<string, unknown>, merged);
          const trashed = await api.trashPage(c.duplicate);
          forgetTabs((p) => p === c.duplicate);
          await refreshTree();
          if (activePathRef.current === c.original && !dirtyRef.current) void openPage(c.original);
          toast.show({
            message: `Merged “${dupName}” into “${origName}”`,
            action: {
              label: "Undo",
              run: async () => {
                await api
                  .writePage(c.original, origDoc.frontmatter as Record<string, unknown>, origDoc.body)
                  .catch(() => {});
                await api.restoreTrash(trashed.id).catch(() => {});
                await refreshTree();
              },
            },
          });
        } else if (choice === "trash-dup") {
          const trashed = await api.trashPage(c.duplicate);
          forgetTabs((p) => p === c.duplicate);
          await refreshTree();
          toast.show({
            message: `Moved “${dupName}” to Trash`,
            action: {
              label: "Undo",
              run: async () => {
                await api.restoreTrash(trashed.id).catch(() => {});
                await refreshTree();
                setTrashRefresh((k) => k + 1);
              },
            },
          });
        } else if (choice === "keep-dup") {
          // rename_path refuses to overwrite, so trash the original first, then move the copy into
          // its place. The copy carries the same frontmatter `id`, so links keep resolving.
          const trashed = await api.trashPage(c.original);
          try {
            await api.renamePath(c.duplicate, c.original);
          } catch (e) {
            await api.restoreTrash(trashed.id).catch(() => {});
            throw e;
          }
          forgetTabs((p) => p === c.duplicate);
          await refreshTree();
          if (activePathRef.current === c.original && !dirtyRef.current) void openPage(c.original);
          toast.show({
            message: `“${dupName}” replaced “${origName}”`,
            action: {
              label: "Undo",
              run: async () => {
                await api.renamePath(c.original, c.duplicate).catch(() => {});
                await api.restoreTrash(trashed.id).catch(() => {});
                await refreshTree();
                setTrashRefresh((k) => k + 1);
              },
            },
          });
        } else if (choice === "keep-both") {
          // The copy shares the original's stable `id`; two pages with one id breaks backlinks and
          // rename link-repair, so drop it and let writePage mint a fresh one (same as Duplicate).
          const { id: _omitId, ...fmCopy } = dupDoc.frontmatter as Record<string, unknown>;
          await api.writePage(c.duplicate, fmCopy, dupDoc.body);
          ignoreConflict(conflictKey(vaultIdRef.current ?? "", c));
          await refreshTree();
        }
      } catch (e) {
        await dialogs.alert({ title: "Couldn’t resolve the conflict", message: String(e) });
      }
    },
    [openPage, refreshTree, forgetTabs]
  );

  // Resolve a batch one dialog at a time (each re-reads its files, so pairs already resolved or
  // externally deleted mid-batch are skipped quietly).
  const reviewConflicts = useCallback(
    async (conflicts: SyncConflict[]) => {
      for (const c of conflicts) await resolveSyncConflict(c);
    },
    [resolveSyncConflict]
  );

  // Alerted pairs this session (keys include the vault id, so switching vaults can't collide).
  const alertedConflicts = useRef<Set<string>>(new Set());

  // Detect conflicts on every tree load — the desktop watcher refreshes the tree when the sync
  // client drops a copy in, so alerts appear live; on web this fires on open/manual reindex.
  useEffect(() => {
    if (!tree) return;
    const vaultId = vaultIdRef.current ?? "";
    const ignored = loadIgnoredConflicts();
    const fresh = findSyncConflicts(tree, settings.periodic_folder).filter((c) => {
      const key = conflictKey(vaultId, c);
      return !ignored.has(key) && !alertedConflicts.current.has(key);
    });
    if (fresh.length === 0) return;
    for (const c of fresh) alertedConflicts.current.add(conflictKey(vaultId, c));
    const periodicHit = fresh.some((c) => c.periodic);
    const message =
      fresh.length === 1
        ? fresh[0].periodic
          ? `Sync conflict: a duplicate of your ${fresh[0].periodic} note “${fresh[0].original.split("/").pop()}” appeared`
          : `Sync conflict: “${fresh[0].duplicate.split("/").pop()}” duplicates “${fresh[0].original.split("/").pop()}”`
        : `${fresh.length} sync-conflict copies found${periodicHit ? ", including periodic notes" : ""}`;
    toast.show({
      message,
      // Periodic-note conflicts stay until acted on — edits stranded in the copy are otherwise
      // invisible; regular pages get a long-but-transient toast.
      durationMs: periodicHit ? 0 : 10000,
      action: { label: "Review", run: () => void reviewConflicts(fresh) },
    });
  }, [tree, settings.periodic_folder, reviewConflicts]);

  // Delete a single node. By default it's a soft delete (move to `.trash`, restorable from the
  // Trash tab); `permanent` (shift-delete) skips the trash and removes it irreversibly.
  const deleteNode = useCallback(
    async (node: TreeNode, permanent = false) => {
      const what = node.is_dir ? "folder (and everything in it)" : "file";
      // Permanent delete is irreversible → confirm. Soft-trash is recoverable → skip confirm and
      // offer Undo instead, matching deleteMany.
      if (permanent) {
        const ok = await dialogs.confirm({
          title: `Permanently delete this ${what}?`,
          message: `${node.rel_path}\n\nThis can't be undone.`,
          confirmLabel: "Delete forever",
          danger: true,
        });
        if (!ok) return;
      }
      let trashedId: string | null = null;
      try {
        if (permanent) await api.deletePage(node.rel_path);
        else trashedId = (await api.trashPage(node.rel_path)).id;
      } catch (e) {
        await dialogs.alert({ title: "Delete failed", message: String(e) });
        return;
      }
      // Drop any icon override(s) for the deleted node and its descendants.
      setSettings((prev) => {
        const prefix = node.rel_path + "/";
        const entries = Object.entries(prev.node_icons).filter(
          ([key]) => key !== node.rel_path && !key.startsWith(prefix)
        );
        if (entries.length === Object.keys(prev.node_icons).length) return prev;
        const next = { ...prev, node_icons: Object.fromEntries(entries) };
        api.saveSettings(next).catch(console.error);
        return next;
      });
      await refreshTree();
      const prefix = node.rel_path + "/";
      forgetTabs((p) => p === node.rel_path || p.startsWith(prefix));
      setTrashRefresh((k) => k + 1);
      setTaskRefresh((k) => k + 1);
      if (trashedId) {
        const id = trashedId;
        toast.show({
          message: `Moved “${node.name}” to Trash`,
          action: {
            label: "Undo",
            run: async () => {
              await api.restoreTrash(id).catch(() => {});
              await refreshTree();
              setTrashRefresh((k) => k + 1);
              setTaskRefresh((k) => k + 1);
            },
          },
        });
      }
    },
    [refreshTree, forgetTabs]
  );

  // ---- Locking (encryption-at-rest) ----
  // A folder/vault can be encrypted with a password. Locking rewrites its `.md` as `.md.enc`
  // ciphertext and removes plaintext; unlocking decrypts for the session and holds the key in
  // memory. See the Rust `lock`/`crypto` modules. Desktop-only for now (web stubs reject).

  /** Encrypt a folder with a new password (with confirmation). After locking, refresh the tree. */
  const lockNode = useCallback(
    async (node: TreeNode) => {
      const got = await dialogs.password({
        title: `Lock “${node.name}”`,
        message:
          "Choose a password. Its contents will be encrypted on disk and unreadable without it.\n\n⚠ If you forget this password, the data cannot be recovered.",
        fields: [
          { key: "new", label: "Password", placeholder: "Enter a strong password" },
          { key: "confirm", label: "Confirm password", placeholder: "Re-enter password" },
        ],
        requireMatch: ["new", "confirm"],
        minLength: 4,
        confirmLabel: "Lock",
      });
      if (!got) return;
      try {
        await api.lockVault(node.rel_path, got.new, null);
      } catch (e) {
        await dialogs.alert({ title: "Lock failed", message: String(e) });
        return;
      }
      // Locked content drops out of the index; refresh tree and dependent views.
      forgetTabs((p) => p === node.rel_path || p.startsWith(node.rel_path + "/"));
      await refreshTree();
      setTaskRefresh((k) => k + 1);
      toast.show({ message: `Locked “${node.name}”` });
    },
    [refreshTree, forgetTabs]
  );

  /** Prompt for a password and unlock a scope for this session. */
  const unlockNode = useCallback(
    async (node: TreeNode) => {
      let status: Awaited<ReturnType<typeof api.lockStatus>>;
      try {
        status = await api.lockStatus(node.rel_path);
      } catch (e) {
        await dialogs.alert({ title: "Unlock failed", message: String(e) });
        return;
      }
      const got = await dialogs.password({
        title: `Unlock “${node.name}”`,
        message: status.hint ? `Hint: ${status.hint}` : undefined,
        fields: [{ key: "password", label: "Password", placeholder: "Enter password" }],
        confirmLabel: "Unlock",
      });
      if (!got) return;
      try {
        await api.unlockVault(node.rel_path, got.password);
      } catch (e) {
        // The Rust side returns "wrong password" for a bad key; surface it plainly.
        await dialogs.alert({ title: "Couldn't unlock", message: String(e) });
        return;
      }
      await refreshTree();
      setTaskRefresh((k) => k + 1);
      toast.show({ message: `Unlocked “${node.name}”` });
    },
    [refreshTree]
  );

  /** Re-encrypt an unlocked scope now and forget its key. */
  const relockNode = useCallback(
    async (node: TreeNode) => {
      try {
        await api.relockVault(node.rel_path);
      } catch (e) {
        await dialogs.alert({ title: "Lock failed", message: String(e) });
        return;
      }
      forgetTabs((p) => p === node.rel_path || p.startsWith(node.rel_path + "/"));
      await refreshTree();
      setTaskRefresh((k) => k + 1);
      toast.show({ message: `Locked “${node.name}”` });
    },
    [refreshTree, forgetTabs]
  );

  /** Change a locked scope's password (re-wraps the key; no files re-encrypt). */
  const changePasswordNode = useCallback(async (node: TreeNode) => {
    const got = await dialogs.password({
      title: `Change password for “${node.name}”`,
      fields: [
        { key: "old", label: "Current password", placeholder: "Enter current password" },
        { key: "new", label: "New password", placeholder: "Enter new password" },
        { key: "confirm", label: "Confirm new password", placeholder: "Re-enter new password" },
      ],
      requireMatch: ["new", "confirm"],
      minLength: 4,
      confirmLabel: "Change password",
    });
    if (!got) return;
    try {
      await api.changeLockPassword(node.rel_path, got.old, got.new);
    } catch (e) {
      await dialogs.alert({ title: "Couldn't change password", message: String(e) });
      return;
    }
    toast.show({ message: "Password changed" });
  }, []);

  // Delete every currently-selected row in one confirm. Skips descendants whose ancestor is also
  // selected (deleting the folder already removes them) to avoid "not found" errors. Soft-deletes
  // to `.trash` by default; `permanent` (shift-delete) removes irreversibly.
  const deleteMany = useCallback(
    async (paths: string[], permanent = false) => {
      // Drop any path that has an ancestor folder also in the set.
      const set = new Set(paths);
      const roots = paths.filter((p) => {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++) {
          if (set.has(parts.slice(0, i).join("/"))) return false;
        }
        return true;
      });
      // Permanent delete is irreversible → confirm. Soft-trash is recoverable, so we skip the
      // confirm and offer an Undo toast instead (forgiving-by-default).
      if (permanent) {
        const ok = await dialogs.confirm({
          title: `Permanently delete ${roots.length} item${roots.length === 1 ? "" : "s"}?`,
          message: `${roots.join("\n")}\n\nThis can't be undone.`,
          confirmLabel: "Delete forever",
          danger: true,
        });
        if (!ok) return;
      }
      const failed: string[] = [];
      // Trash-entry ids captured so the Undo toast can restore exactly what we just trashed.
      const trashedIds: string[] = [];
      for (const p of roots) {
        try {
          if (permanent) await api.deletePage(p);
          else trashedIds.push((await api.trashPage(p)).id);
        } catch {
          failed.push(p);
        }
      }
      // Drop icon overrides for every deleted path and its descendants.
      setSettings((prev) => {
        const entries = Object.entries(prev.node_icons).filter(
          ([key]) => !roots.some((r) => key === r || key.startsWith(r + "/"))
        );
        if (entries.length === Object.keys(prev.node_icons).length) return prev;
        const next = { ...prev, node_icons: Object.fromEntries(entries) };
        api.saveSettings(next).catch(console.error);
        return next;
      });
      await refreshTree();
      forgetTabs((p) => roots.some((r) => p === r || p.startsWith(r + "/")));
      setSelected(new Set());
      setTrashRefresh((k) => k + 1);
      setTaskRefresh((k) => k + 1);
      if (failed.length) {
        await dialogs.alert({ title: "Some deletes failed", message: failed.join("\n") });
      }
      // Offer one-click undo for the soft-trash path.
      if (!permanent && trashedIds.length) {
        const n = trashedIds.length;
        toast.show({
          message: `Moved ${n} item${n === 1 ? "" : "s"} to Trash`,
          action: {
            label: "Undo",
            run: async () => {
              for (const id of trashedIds) {
                await api.restoreTrash(id).catch(() => {});
              }
              await refreshTree();
              setTrashRefresh((k) => k + 1);
              setTaskRefresh((k) => k + 1);
            },
          },
        });
      }
    },
    [refreshTree, forgetTabs]
  );

  // Restore a trashed item, then refresh the tree (and open it if it's a page).
  const restoreTrash = useCallback(
    async (id: string) => {
      let rel: string;
      try {
        rel = await api.restoreTrash(id);
      } catch (e) {
        await dialogs.alert({ title: "Restore failed", message: String(e) });
        return;
      }
      await refreshTree();
      setTrashRefresh((k) => k + 1);
      setTaskRefresh((k) => k + 1);
      // Open restored markdown pages so the user lands back where they were.
      if (rel.toLowerCase().endsWith(".md")) await openPage(rel);
    },
    [refreshTree, openPage]
  );

  // Rebuild the search/query index, with visible feedback (spinner while running, toast on done).
  const doReindex = useCallback(async () => {
    if (reindexing) return;
    setReindexing(true);
    try {
      const count = await api.reindex();
      setTaskRefresh((k) => k + 1);
      toast.show({ message: `Re-indexed ${count} item${count === 1 ? "" : "s"}` });
    } catch (e) {
      await dialogs.alert({ title: "Re-index failed", message: String(e) });
    } finally {
      setReindexing(false);
    }
  }, [reindexing]);

  // Add a prefix or suffix to the display name of every selected row, in one prompt.
  // The affix is inserted into the leaf name only (path and extension are preserved), and any
  // icon overrides follow the moved paths. Renames run deepest-first so renaming a parent folder
  // doesn't invalidate a child's path mid-batch.
  const affixMany = useCallback(
    async (paths: string[], where: "prefix" | "suffix") => {
      const affix = await dialogs.prompt({
        title: where === "prefix" ? `Add prefix to ${paths.length} items` : `Add suffix to ${paths.length} items`,
        placeholder: where === "prefix" ? "e.g. WIP " : "e.g.  (draft)",
      });
      if (!affix) return;

      // Resolve each selected path to its node (for ext / is_dir) via a flat tree lookup.
      const byPath = new Map<string, TreeNode>();
      const index = (n: TreeNode) => {
        if (n.rel_path) byPath.set(n.rel_path, n);
        n.children.forEach(index);
      };
      if (tree) index(tree);

      // Deepest paths first: a folder rename re-keys its descendants, so children must move first.
      const ordered = [...paths].sort((a, b) => b.split("/").length - a.split("/").length);
      const failed: string[] = [];
      for (const from of ordered) {
        const node = byPath.get(from);
        if (!node) continue;
        const parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
        const rawLeaf = from.split("/").pop() ?? from;
        const isMd = !node.is_dir && node.ext === "";
        // Split the leaf into name + extension so the affix lands on the visible name.
        const ext = node.is_dir ? "" : isMd ? ".md" : `.${node.ext}`;
        const stem = ext ? rawLeaf.slice(0, rawLeaf.length - ext.length) : rawLeaf;
        const newStem = where === "prefix" ? `${affix}${stem}` : `${stem}${affix}`;
        const toLeaf = `${newStem}${ext}`;
        if (toLeaf === rawLeaf) continue;
        const to = parent ? `${parent}/${toLeaf}` : toLeaf;
        try {
          await api.renamePath(from, to);
        } catch {
          failed.push(from);
          continue;
        }
        // Carry icon overrides across (and re-key descendants for folders).
        setSettings((prev) => {
          const fromPrefix = from + "/";
          const toPrefix = to + "/";
          let changed = false;
          const node_icons: Record<string, NodeIcon> = {};
          for (const [key, val] of Object.entries(prev.node_icons)) {
            if (key === from) {
              node_icons[to] = val;
              changed = true;
            } else if (node.is_dir && key.startsWith(fromPrefix)) {
              node_icons[toPrefix + key.slice(fromPrefix.length)] = val;
              changed = true;
            } else {
              node_icons[key] = val;
            }
          }
          if (!changed) return prev;
          const next = { ...prev, node_icons };
          api.saveSettings(next).catch(console.error);
          return next;
        });
      }
      await refreshTree();
      setActivePath(null);
      setActiveAsset(null);
      setSelected(new Set());
      setTaskRefresh((k) => k + 1);
      if (failed.length) {
        await dialogs.alert({ title: "Some renames failed", message: failed.join("\n") });
      }
    },
    [tree, refreshTree]
  );

  // Apply one icon to every selected row at once.
  const setIconMany = useCallback(
    async (paths: string[], icon: NodeIcon) => {
      const node_icons = { ...settings.node_icons };
      for (const p of paths) node_icons[p] = icon;
      await saveSettings({ ...settings, node_icons });
    },
    [settings]
  );

  const clearIconMany = useCallback(
    async (paths: string[]) => {
      const node_icons = { ...settings.node_icons };
      let changed = false;
      for (const p of paths) {
        if (node_icons[p]) {
          delete node_icons[p];
          changed = true;
        }
      }
      if (changed) await saveSettings({ ...settings, node_icons });
    },
    [settings]
  );

  const newPageIn = useCallback(
    async (folderRel: string) => {
      const leaf = await dialogs.prompt({ title: "New page", placeholder: "Page name" });
      if (!leaf?.trim()) return;
      const name = folderRel ? `${folderRel}/${leaf.trim()}` : leaf.trim();
      await newPage(name);
      const rel = name.endsWith(".md") ? name : `${name}.md`;
      await openPage(rel);
    },
    [newPage, openPage]
  );

  // Build the menu for a right-clicked node. Pages, assets, and folders get tailored actions.
  const menuItems = useCallback(
    (node: TreeNode): MenuItem[] => {
      const MI = 15; // menu icon size
      const items: MenuItem[] = [];
      // Encryption is desktop-only for now; the web build has no Rust crypto backend.
      const canLock = isTauri();

      // Bulk menu: the right-clicked row is part of a multi-selection of 2+ rows.
      if (selected.size > 1 && selected.has(node.rel_path)) {
        const paths = [...selected];
        items.push({
          label: `Set icon for ${paths.length} items…`,
          icon: <Smiley size={MI} />,
          onClick: () => setIconBatch(paths),
        });
        items.push({
          label: "Add prefix…",
          icon: <PencilSimple size={MI} />,
          onClick: () => affixMany(paths, "prefix"),
        });
        items.push({
          label: "Add suffix…",
          icon: <PencilSimple size={MI} />,
          onClick: () => affixMany(paths, "suffix"),
        });
        items.push({
          label: `Copy ${paths.length} paths`,
          icon: <Copy size={MI} />,
          separator: true,
          onClick: () => navigator.clipboard?.writeText(paths.join("\n")),
        });
        items.push({
          label: `Move ${paths.length} items to Trash`,
          icon: <Trash size={MI} />,
          danger: true,
          separator: true,
          onClick: () => deleteMany(paths),
        });
        items.push({
          label: `Delete ${paths.length} permanently`,
          icon: <TrashSimple size={MI} />,
          danger: true,
          onClick: () => deleteMany(paths, true),
        });
        return items;
      }

      const hasIcon = !!settings.node_icons[node.rel_path];
      const iconItem: MenuItem = {
        label: hasIcon ? "Change icon…" : "Set icon…",
        icon: <Smiley size={MI} />,
        onClick: () => setIconTarget(node.rel_path),
      };
      if (node.is_dir) {
        items.push({ label: "New page here", icon: <Plus size={MI} />, onClick: () => newPageIn(node.rel_path) });
        if (templates.length && !node.is_database) {
          items.push({
            label: "New page from template here",
            icon: <FileText size={MI} />,
            onClick: () => setTemplatePicker({ x: menu?.x ?? 0, y: menu?.y ?? 0, parent: node.rel_path }),
          });
        }
        if (!node.is_database) {
          items.push({ label: "Convert to Database", icon: <Database size={MI} />, onClick: () => convertToDatabase(node) });
        }
        // Expand / collapse the whole subtree at once. Only offered when the folder actually
        // contains sub-folders — otherwise the commands would be no-ops.
        const hasSubfolders = node.children.some((c) => c.is_dir);
        if (hasSubfolders) {
          items.push({
            label: "Expand all",
            icon: <CaretDown size={MI} />,
            separator: true,
            onClick: () => treeCmdRef.current?.expand(node.rel_path),
          });
          items.push({
            label: "Collapse all",
            icon: <CaretRight size={MI} />,
            onClick: () => treeCmdRef.current?.collapse(node.rel_path),
          });
        }
        // Lock / unlock (encryption-at-rest). Offered only on desktop, where `lockStatus` can report
        // a real scope (the web stub always returns not-a-scope, so `lockMap` is empty there).
        if (canLock) {
          const status = lockMap[node.rel_path];
          if (!status) {
            // Plain folder → offer to encrypt it. (A folder already inside a locked, unlocked scope
            // can still be independently locked; that's a Phase 2 nicety — for now we allow it.)
            items.push({
              label: "Lock with password…",
              icon: <Lock size={MI} />,
              separator: true,
              onClick: () => lockNode(node),
            });
          } else if (status.unlocked) {
            items.push({
              label: "Lock now",
              icon: <Lock size={MI} />,
              separator: true,
              onClick: () => relockNode(node),
            });
            items.push({
              label: "Change password…",
              icon: <Key size={MI} />,
              onClick: () => changePasswordNode(node),
            });
          } else {
            items.push({
              label: "Unlock…",
              icon: <LockOpen size={MI} />,
              separator: true,
              onClick: () => unlockNode(node),
            });
            items.push({
              label: "Change password…",
              icon: <Key size={MI} />,
              onClick: () => changePasswordNode(node),
            });
          }
        }
        items.push(iconItem);
        items.push({ label: "Rename", icon: <PencilSimple size={MI} />, onClick: () => renameNode(node) });
        items.push({ label: "Copy path", icon: <Copy size={MI} />, onClick: () => navigator.clipboard?.writeText(node.rel_path) });
        items.push({ label: "Move to Trash", icon: <Trash size={MI} />, danger: true, separator: true, onClick: () => deleteNode(node) });
        items.push({ label: "Delete permanently", icon: <TrashSimple size={MI} />, danger: true, onClick: () => deleteNode(node, true) });
        return items;
      }
      const isMd = node.ext === "";
      items.push({
        label: "Open",
        icon: <ArrowSquareOut size={MI} />,
        onClick: () => (isMd ? openPage(node.rel_path) : openAsset(node)),
      });
      items.push(iconItem);
      items.push({ label: "Rename", icon: <PencilSimple size={MI} />, onClick: () => renameNode(node) });
      if (isMd) items.push({ label: "Duplicate", icon: <Copy size={MI} />, onClick: () => duplicateNode(node) });
      items.push({ label: "Copy path", icon: <LinkIcon size={MI} />, onClick: () => navigator.clipboard?.writeText(node.rel_path) });
      items.push({ label: "Move to Trash", icon: <Trash size={MI} />, danger: true, separator: true, onClick: () => deleteNode(node) });
      items.push({ label: "Delete permanently", icon: <TrashSimple size={MI} />, danger: true, onClick: () => deleteNode(node, true) });
      return items;
    },
    [selected, deleteMany, affixMany, settings.node_icons, openPage, openAsset, renameNode, duplicateNode, deleteNode, newPageIn, convertToDatabase, templates, menu, lockMap, lockNode, unlockNode, relockNode, changePasswordNode]
  );

  // ---- Global keyboard shortcuts ----
  // Ctrl/Cmd+K  → open the command palette
  // Ctrl/Cmd+N  → new page
  // Ctrl/Cmd+= / + → zoom in,  Ctrl/Cmd+- → zoom out,  Ctrl/Cmd+0 → reset zoom
  // ?           → toggle the keyboard-shortcuts popup (see ShortcutsPopup.tsx, kept in sync)
  // Registered only once a vault is open (tree != null). Shortcuts that would otherwise be
  // swallowed by the browser/OS (zoom, new-window) are preventDefault'd.
  useEffect(() => {
    if (!tree) return;
    const onKey = (e: KeyboardEvent) => {
      // Never hijack keys while typing in the editor, an input, or a contenteditable surface.
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);

      // Delete / Shift+Delete act on the explorer selection (or the open page) when not typing.
      // Plain Delete → Trash; Shift+Delete → permanent.
      if (!typing && (e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const targets = selected.size ? [...selected] : activePath ? [activePath] : [];
        if (!targets.length) return;
        e.preventDefault();
        deleteMany(targets, e.shiftKey);
        return;
      }

      // History navigation: Alt+←/→ (browser-standard), works regardless of typing state.
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        navHistory(e.key === "ArrowLeft" ? -1 : 1);
        return;
      }

      // "?" toggles the keyboard-shortcuts cheat sheet (no modifier; "?" is Shift+/).
      if (!typing && e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setShortcutsOpen((open) => !open);
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;

      const key = e.key;
      if (e.shiftKey && (key === "l" || key === "L")) {
        // Toggle dark ↔ light (Ctrl/Cmd+Shift+L). Flip relative to what's actually showing, so from
        // "system" it lands on the opposite of the current OS scheme rather than getting stuck.
        // Persisted like the other settings shortcuts so the choice survives a restart.
        e.preventDefault();
        setSettings((prev) => {
          const updated: Settings = {
            ...prev,
            theme: resolveMode(prev.theme) === "dark" ? "light" : "dark",
          };
          api.saveSettings(updated).catch(console.error);
          return updated;
        });
        return;
      }
      if ((key === "w" || key === "W") && activePath) {
        // Close the active document tab.
        e.preventDefault();
        closeTab(activePath);
      } else if (key === "k" || key === "K") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === "j" || key === "J") {
        // Toggle the LLM chat dock (CLI integration).
        e.preventDefault();
        toggleLlm();
      } else if (key === "n" || key === "N") {
        e.preventDefault();
        newPage();
      } else if (key === "=" || key === "+") {
        // "=" is the unshifted key for "+"; both map to zoom-in.
        e.preventDefault();
        changeZoom(ZOOM_STEP);
      } else if (key === "-" || key === "_") {
        e.preventDefault();
        changeZoom(-ZOOM_STEP);
      } else if (key === "0") {
        e.preventDefault();
        changeZoom("reset");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tree, newPage, changeZoom, selected, activePath, deleteMany, navHistory, closeTab, setShortcutsOpen, toggleLlm]);

  // Keep the sidebar Trash badge count in sync: refresh on vault open and after any trash change.
  useEffect(() => {
    if (!tree) return;
    api.listTrash().then((t) => setTrashCount(t.length)).catch(() => setTrashCount(0));
  }, [tree, trashRefresh]);

  // Global actions offered by the command palette, alongside page jumps.
  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      { id: "new-page", label: "New page", hint: "Ctrl+N", icon: Plus, run: () => newPage() },
      {
        id: "reindex",
        label: "Re-index vault",
        hint: "Rescan files",
        icon: ArrowsClockwise,
        run: () => void doReindex(),
      },
      { id: "settings", label: "Open settings", hint: "Appearance & more", icon: GearSix, run: () => setShowSettings(true) },
      { id: "switch-vault", label: "Switch vault", hint: "Back to start", icon: FolderOpen, run: switchVault },
      { id: "tab-tasks", label: "Go to Tasks", icon: CheckCircle, run: () => setTab("tasks") },
      { id: "tab-query", label: "Go to Query", icon: FileText, run: () => setTab("query") },
      { id: "tab-trash", label: "Open Trash", hint: "Restore deleted items", icon: Trash, run: () => setTab("trash") },
    ],
    [newPage, switchVault, doReindex]
  );

  // Scroll the editor to a heading picked in the right sidebar's outline. The editor renders
  // markdown headings as <h1>…<h6> inside `.editor-content`; we map the heading's ordinal among
  // ALL headings to the Nth heading element in the DOM, so duplicate texts still resolve.
  const jumpToHeading = useCallback((h: Heading) => {
    if (tab !== "editor") setTab("editor");
    // Defer to the next frame in case the editor tab just mounted.
    requestAnimationFrame(() => {
      const root = document.querySelector(".editor-content");
      if (!root) return;
      const all = root.querySelectorAll("h1, h2, h3, h4, h5, h6");
      const el = all[h.ordinal] as HTMLElement | undefined;
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [tab]);

  const headerStatus = useMemo(() => {
    if (!activePath || activeAsset) return null;
    return dirty ? (
      <span className="status-dot">
        <CircleNotch size={13} weight="bold" /> unsaved
      </span>
    ) : (
      <span className="status-dot">
        <CheckCircle size={13} weight="fill" /> saved
      </span>
    );
  }, [activePath, activeAsset, dirty]);

  // Back/forward availability, recomputed whenever the history cursor/stack changes (histTick).
  const canBack = useMemo(() => histIdx.current > 0, [histTick]);
  const canForward = useMemo(() => histIdx.current < histRef.current.length - 1, [histTick]);

  // While booting we keep the Start screen's animated backdrop but hide its content,
  // so a restored vault appears without a jarring flash of the welcome copy.
  if (!tree) {
    return (
      <>
        <Titlebar autoHide={settings.auto_hide_titlebar} />
        {booting ? (
          <div className="start" />
        ) : (
          <StartScreen
            onOpenNew={openVault}
            onOpenRecent={openRecent}
            onCreateMobileVault={createMobileVault}
            onOpenExisting={openExistingVault}
            openingId={openingVault}
            refreshKey={recentsNonce}
          />
        )}
      </>
    );
  }

  return (
    <>
    <Titlebar title={vaultName} autoHide={settings.auto_hide_titlebar} />
    <div
      className="app"
      ref={appRef}
      data-mobile={vp.isMobile ? "" : undefined}
      style={{
        // On mobile the grid collapses to a single column; the sidebars become fixed overlay
        // drawers (positioned by CSS) instead of grid tracks, so they no longer reserve space.
        gridTemplateColumns: vp.isMobile
          ? "1fr"
          : `${leftOpen ? `${leftWidth}px 6px` : "0px 0px"} 1fr ${
              rightOpen ? `6px ${rightWidth}px` : "0px 0px"
            } ${llmOpen ? `6px ${chatWidth}px` : "0px 0px"}`,
      }}
    >
      {/* Dim, tap-to-dismiss backdrop behind an open drawer on mobile. */}
      <AnimatePresence>
        {vp.isMobile && mobileDrawer && (
          <motion.div
            key="drawer-scrim"
            className="drawer-scrim"
            onClick={closeDrawers}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transition("fast")}
          />
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
      {showLeft && (
      <motion.aside
        className="sidebar"
        {...slideFade({ axis: "x", distance: vp.isMobile ? -340 : -24, speed: "slow" })}
      >
        <div className="sidebar-header">
          <button
            className="vault-name"
            title={`${vaultName} — switch vault`}
            onClick={switchVault}
          >
            <FolderOpen size={16} weight="fill" /> {vaultName}
          </button>
          <div className="sidebar-actions">
            <Tooltip label="Create…">
              <button
                className={addMenu ? "is-active" : undefined}
                aria-label="Create…"
                aria-haspopup="menu"
                aria-expanded={addMenu ? true : false}
                onClick={(e) => {
                  if (addMenu) { setAddMenu(null); return; }
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setAddMenu({ x: r.left, y: r.bottom + 4 });
                }}
              >
                <Plus size={16} weight="bold" />
              </button>
            </Tooltip>
            <Tooltip label={reindexing ? "Re-indexing…" : "Re-index"}>
              <button
                onClick={() => void doReindex()}
                disabled={reindexing}
                aria-label="Re-index vault"
              >
                <ArrowsClockwise size={16} weight="bold" className={reindexing ? "spin" : undefined} />
              </button>
            </Tooltip>
            <Tooltip label="Settings">
              <button onClick={() => setShowSettings(true)} aria-label="Settings"><GearSix size={16} weight="bold" /></button>
            </Tooltip>
            <Tooltip label="Hide sidebar">
              <button onClick={toggleLeft} aria-label="Hide sidebar"><SidebarSimple size={16} weight="bold" /></button>
            </Tooltip>
          </div>
        </div>
        <button
          className="sidebar-search"
          onClick={() => setPaletteOpen(true)}
          title="Search & commands"
          aria-keyshortcuts={IS_MAC ? "Meta+K" : "Control+K"}
        >
          <MagnifyingGlass size={15} weight="bold" />
          <span className="sidebar-search-label">Search…</span>
          <kbd className="sidebar-search-kbd">{IS_MAC ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        {/* Mobile only: the drawer doubles as the navigation hub, so the views that live in the
            desktop top bar (Tasks / Query / Tags) are reachable here. Picking one switches the main
            view and dismisses the drawer to reveal it. Settings (header gear) and Trash (footer)
            round out the hub. */}
        {vp.isMobile && (
          <nav className="sidebar-views" aria-label="Views">
            <button
              className={`sidebar-view${tab === "tasks" ? " active" : ""}`}
              onClick={() => { haptic("select"); setTab("tasks"); setMobileDrawer(null); }}
            >
              <CheckCircle size={16} weight={tab === "tasks" ? "fill" : "regular"} />
              <span>Tasks</span>
            </button>
            <button
              className={`sidebar-view${tab === "query" ? " active" : ""}`}
              onClick={() => { haptic("select"); setTab("query"); setMobileDrawer(null); }}
            >
              <MagnifyingGlass size={16} weight={tab === "query" ? "fill" : "regular"} />
              <span>Query</span>
            </button>
            <button
              className={`sidebar-view${tab === "tags" ? " active" : ""}`}
              onClick={() => { haptic("select"); setTab("tags"); setMobileDrawer(null); }}
            >
              <Tag size={16} weight={tab === "tags" ? "fill" : "regular"} />
              <span>Tags</span>
            </button>
          </nav>
        )}
        <div className="tree">
          <FileTree
            node={tree}
            activePath={activePath}
            selected={selected}
            onSelect={onSelect}
            nodeIcons={settings.node_icons}
            lockStatuses={lockMap}
            onUnlockFolder={unlockNode}
            onOpen={openPage}
            onOpenAsset={openAsset}
            onOpenDatabase={openDatabase}
            onOpenFolder={openFolder}
            onContextMenu={(node, x, y) => {
              // Right-clicking outside the current multi-selection resets it to that row,
              // so the bulk menu only shows when you right-click within the selection.
              if (!selected.has(node.rel_path)) setSelected(new Set([node.rel_path]));
              setMenu({ node, x, y });
            }}
            onPickIcon={(node) => setIconTarget(node.rel_path)}
            selectedSnapshot={selected}
            onMove={moveNodes}
            renamingPath={renamingPath}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRenamingPath(null)}
            revealRef={treeRevealRef}
            cmdRef={treeCmdRef}
          />
        </div>
        <button
          className={`sidebar-trash${tab === "trash" ? " active" : ""}`}
          onClick={() => setTab("trash")}
          title="Trash — restore deleted items"
        >
          <Trash size={16} weight={tab === "trash" ? "fill" : "regular"} />
          <span className="sidebar-trash-label">Trash</span>
          {trashCount > 0 && <span className="sidebar-trash-count">{trashCount}</span>}
        </button>
      </motion.aside>
      )}
      </AnimatePresence>

      {leftOpen && !vp.isMobile && (
        <div className="resizer" onPointerDown={startResize("left")} title="Drag to resize" />
      )}

      {/* Pin main to the 3rd grid column on desktop. The sidebars/resizers are conditionally
          rendered, so without an explicit placement `main` would auto-flow into the
          first (0px) column when the left panel is hidden, blanking the screen. On mobile the
          grid is a single column, so main lives in column 1 and the sidebars overlay it. */}
      <main className="main" style={{ gridColumn: vp.isMobile ? 1 : 3 }}>
        {vp.isMobile && (
          <Breadcrumb
            path={activePath ?? ""}
            onNavigateFolder={openFolderCrumb}
          />
        )}
        <div className="tabs">
          <div className="nav-arrows">
            {!leftOpen && (
              <Tooltip label="Show sidebar">
                <button
                  className="nav-arrow"
                  onClick={toggleLeft}
                  aria-label="Show sidebar"
                >
                  <SidebarSimple size={15} weight="bold" />
                </button>
              </Tooltip>
            )}
            <Tooltip label="Back (Alt+←)">
              <button
                className="nav-arrow"
                disabled={!canBack}
                onClick={() => navHistory(-1)}
                aria-label="Back"
              >
                <CaretLeft size={15} weight="bold" />
              </button>
            </Tooltip>
            <Tooltip label="Forward (Alt+→)">
              <button
                className="nav-arrow"
                disabled={!canForward}
                onClick={() => navHistory(1)}
                aria-label="Forward"
              >
                <CaretRight size={15} weight="bold" />
              </button>
            </Tooltip>
          </div>

          <div className="doc-tabs" role="tablist">
            {openDocs.map((d) => {
              const isActive = d.path === activePath && tab === "editor";
              const label = (d.path.split("/").pop() ?? d.path).replace(/\.md$/i, "");
              return (
                <div
                  key={d.path}
                  className={`doc-tab${isActive ? " active" : ""}`}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  title={d.path}
                  onMouseDown={(e) => {
                    // Middle-click closes, like a browser.
                    if (e.button === 1) {
                      e.preventDefault();
                      closeTab(d.path);
                    }
                  }}
                  onClick={() => {
                    if (tab !== "editor") setTab("editor");
                    selectTab(d.path);
                  }}
                >
                  <button
                    className="doc-tab-icon"
                    title="Change icon"
                    aria-label={`Change icon for ${label}`}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      // Edit the tab's icon instead of switching to it — same picker the tree uses.
                      e.stopPropagation();
                      setIconTarget(d.path);
                    }}
                  >
                    <NodeIconView
                      icon={settings.node_icons[d.path]}
                      fallback={d.kind === "asset" ? FileIcon : d.kind === "db" ? Database : d.kind === "folder" ? Folder : FileText}
                    />
                  </button>
                  <span className="doc-tab-label">{label}</span>
                  <button
                    className="doc-tab-close"
                    title="Close (Ctrl+W)"
                    aria-label={`Close ${label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(d.path);
                    }}
                  >
                    <X size={12} weight="bold" />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="view-tabs">
            <Tooltip label="Tasks">
              <button
                className={tab === "tasks" ? "active" : ""}
                onClick={() => setTab("tasks")}
                aria-label="Tasks"
              >
                <CheckCircle size={15} weight="bold" />
              </button>
            </Tooltip>
            <Tooltip label="Query">
              <button
                className={tab === "query" ? "active" : ""}
                onClick={() => setTab("query")}
                aria-label="Query"
              >
                <MagnifyingGlass size={15} weight="bold" />
              </button>
            </Tooltip>
            <Tooltip label="Tags">
              <button
                className={tab === "tags" ? "active" : ""}
                onClick={() => setTab("tags")}
                aria-label="Tags"
              >
                <Tag size={15} weight="bold" />
              </button>
            </Tooltip>
            <Tooltip label={rightOpen ? "Hide right panel" : "Show right panel"} side="left">
              <button
                className={`right-toggle${rightOpen ? " active" : ""}`}
                onClick={toggleRight}
                aria-label={rightOpen ? "Hide right panel" : "Show right panel"}
              >
                <SidebarSimple size={15} weight="bold" style={{ transform: "scaleX(-1)" }} />
              </button>
            </Tooltip>
            <Tooltip label={llmOpen ? "Hide AI chat" : "AI chat (Ctrl/Cmd+J)"} side="left">
              <button
                className={`right-toggle${llmOpen ? " active" : ""}`}
                onClick={toggleLlm}
                aria-label={llmOpen ? "Hide AI chat" : "Show AI chat"}
              >
                <ChatCircle size={15} weight="bold" />
              </button>
            </Tooltip>
          </div>
          {activePath && !activeAsset && !activeDb && tab === "editor" && (
            <PageProperties
              path={activePath}
              frontmatter={frontmatter}
              dateFormat={settings.date_format}
            />
          )}
          <span className="status">{headerStatus}</span>
        </div>

        <div className="content">
          <AnimatePresence mode="wait" initial={false}>
          <motion.div
            // Key on the *view identity*, not the document body: the tab plus which doc/db/asset is
            // open. This crossfades when you switch tabs or open a different page, but keeps the
            // Editor mounted (key unchanged) while you type, so focus/cursor survive keystrokes.
            key={
              tab === "editor"
                ? `editor:${activeFolder?.rel_path ?? activeDb?.rel_path ?? activeAsset?.rel_path ?? activePath ?? "empty"}`
                : tab
            }
            className="content-view"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={transition("fast")}
          >
          {tab === "editor" &&
            (activeFolder ? (
              <FolderView
                node={activeFolder}
                nodeIcons={settings.node_icons}
                onOpenNode={openNode}
                onPickIcon={(n) => setIconTarget(n.rel_path)}
                onCreate={(kind, folderRel) =>
                  tree && setCreate({ kind, tree, initialParent: folderRel })
                }
                onRevealInTree={openFolderCrumb}
                onNavigateRoot={() => {
                  openLeftDrawer();
                }}
              />
            ) : activeDb ? (
              <DatabaseView
                node={activeDb}
                reloadKey={reloadKey}
                onOpenRow={openPage}
                onTreeChange={refreshTree}
                dateFormat={settings.date_format}
                nodeIcons={settings.node_icons}
                onSetNodeIcon={setNodeIcon}
                onClearNodeIcon={clearNodeIcon}
                templates={templates}
                onApplyTemplate={applyTemplate}
              />
            ) : activeAsset ? (
              <AssetViewer relPath={activeAsset.rel_path} />
            ) : activePath ? (
              <Editor
                value={body}
                onChange={onEditorChange}
                reloadKey={reloadKey}
                pages={pages}
                tags={allTags}
                templates={templates}
                onInsertTemplate={async (rel) => {
                  // Fill the template against the current page's title + path and insert its body.
                  // The {{cursor}} sentinel is preserved; the editor places the caret there.
                  const title = (activePath?.split("/").pop() ?? "").replace(/\.md$/i, "");
                  const filled = await applyTemplate(rel, { title, relPath: activePath ?? undefined });
                  return filled ? filled.body : null;
                }}
                onCreatePage={newPage}
                onCreateDatabase={newDatabase}
                onOpenPage={openPageByName}
                onOpenPath={openPage}
                currentPath={activePath}
                onOpenTag={(t) => {
                  setTagFocus((s) => ({ tag: t, n: (s?.n ?? 0) + 1 }));
                  setTab("tags");
                }}
                onAddAttachment={addAttachment}
                onAttachmentRemoved={onAttachmentRemoved}
                onTaskToggled={onTaskToggled}
                onSendTask={onSendTaskFromEditor}
                pageWidth={settings.page_width || 820}
                onPageWidthChange={setPageWidth}
                dateFormat={settings.date_format}
                timeFormat={settings.time_format}
                taskDateFormat={settings.task_date_format}
                stampDoneDate={settings.stamp_done_date}
                doneDateFormat={settings.done_date_format}
                doneDatePrefix={settings.done_date_prefix}
                highlightDueDates={settings.highlight_due_dates}
                insertText={tokenInsert}
                smartReplacements={settings.smart_replacements}
                snippets={settings.snippets}
                snippetDelimiter={settings.snippet_delimiter}
                showToolbar={settings.show_format_toolbar}
                headerSlot={
                  <>
                    {activePath && !vp.isMobile && (
                      <PathBreadcrumb
                        path={activePath}
                        icons={settings.node_icons}
                        onNavigateRoot={() => {
                          openLeftDrawer();
                        }}
                        onNavigateFolder={openFolderCrumb}
                      />
                    )}
                    {activePath && (
                      <PageTitle
                        title={(activePath.split("/").pop() ?? "").replace(/\.md$/i, "")}
                        icon={settings.node_icons[activePath]}
                        fallback={FileText}
                        onCommit={(next) => {
                          const node = findNode(activePath);
                          if (node) void commitRename(node, next);
                        }}
                        onPickIcon={() => setIconTarget(activePath)}
                      />
                    )}
                    {activePageDb ? (
                      <DbPageProperties
                        dbPath={activePageDb.rel_path}
                        pagePath={activePath}
                        frontmatter={frontmatter}
                        onChange={setRowFields}
                        onRenameTitle={renameRowTitle}
                        dateFormat={settings.date_format}
                      />
                    ) : activeTemplate ? (
                      <TemplateBuilderBar
                        onInsert={(text) => setTokenInsert((s) => ({ text, n: s.n + 1 }))}
                        dateFormat={settings.date_format}
                        timeFormat={settings.time_format}
                        showPeriodic={activeTemplate.isPeriodic}
                      />
                    ) : null}
                  </>
                }
              />
            ) : (
              <div className="empty">
                Select a page from the sidebar, or create one with <Plus size={14} weight="bold" />.
              </div>
            ))}
          {tab === "tasks" && (
            <TasksView
              onOpen={openPage}
              onOpenName={openPageByName}
              refreshKey={taskRefresh}
              dateFormat={settings.task_date_format}
              periodicFolder={settings.periodic_folder}
              dailyFormat={settings.periodic_label_format}
              onChanged={() => setTaskRefresh((k) => k + 1)}
            />
          )}
          {tab === "query" && <QueryView seedFrom={queryTagSeed} />}
          {tab === "tags" && (
            <TagsView
              onOpen={openPage}
              refreshKey={taskRefresh}
              focusTag={tagFocus}
              onQueryTag={(tag) => {
                setQueryTagSeed((s) => ({ tag, n: (s?.n ?? 0) + 1 }));
                setTab("query");
              }}
            />
          )}
          {tab === "trash" && (
            <TrashView
              refreshKey={trashRefresh}
              onRestore={restoreTrash}
              onChanged={() => {
                setTrashRefresh((k) => k + 1);
                setTaskRefresh((k) => k + 1);
              }}
            />
          )}
          </motion.div>
          </AnimatePresence>
        </div>
      </main>

      {rightOpen && !vp.isMobile && (
        <div className="resizer" onPointerDown={startResize("right")} title="Drag to resize" />
      )}

      <AnimatePresence initial={false}>
      {showRight && (
      <motion.div
        key="right-sidebar"
        className="right-sidebar-wrap"
        {...slideFade({ axis: "x", distance: vp.isMobile ? 340 : 24, speed: "slow" })}
        style={{ gridColumn: vp.isMobile ? 1 : 5, display: "flex", minHeight: 0 }}
      >
        <RightSidebar
          body={body}
          hasPage={!!activePath && !activeAsset && tab === "editor"}
          onJumpToHeading={jumpToHeading}
          periodicFolder={settings.periodic_folder}
          dailyFormat={settings.periodic_label_format}
          activePath={activePath}
          existingPaths={pagePaths}
          onOpenPeriodic={openPeriodic}
          onOpenPath={openPage}
          onOpenName={openPageByName}
          taskRefresh={taskRefresh}
        />
      </motion.div>
      )}
      </AnimatePresence>

      {/* LLM chat dock (CLI integration) — a SECOND right sidebar living in the grid (cols 6–7), so
          toggling it reflows the editor instead of overlaying it. Its own drag-resizer sits at col 6.
          On mobile it falls back to a fixed overlay drawer (see styles.css). Toggle with Ctrl/Cmd+J. */}
      {llmOpen && !vp.isMobile && (
        <div className="resizer" onPointerDown={startResize("chat")} title="Drag to resize" style={{ gridColumn: 6 }} />
      )}
      <AnimatePresence initial={false}>
        {llmOpen && (
          <motion.div
            key="llm-dock"
            className="llm-dock"
            {...slideFade({ axis: "x", distance: vp.isMobile ? 340 : 24, speed: "slow" })}
            style={{ gridColumn: vp.isMobile ? 1 : 7, display: "flex", minHeight: 0 }}
          >
            <LlmPanel
              onClose={toggleLlm}
              turns={llmTurns}
              setTurns={setLlmTurns}
              sessionRef={llmSessionRef}
              pages={pages}
              activePath={activePath}
              readPage={async (rel) => (await api.readPage(rel)).body}
              defaults={{
                provider: settings.ai_provider,
                model: settings.ai_model,
                effort: settings.ai_effort,
                mode: settings.ai_mode,
                preset: settings.ai_preset,
              }}
              vaultRoot={vaultIdRef.current}
              vaultRelToAbs={(rel) => {
                // On desktop the vault id is the absolute root path; join with the platform sep.
                const root = vaultIdRef.current ?? "";
                if (!root) return rel;
                const sep = root.includes("\\") ? "\\" : "/";
                const relOs = sep === "\\" ? rel.replace(/\//g, "\\") : rel;
                return root.replace(/[\\/]$/, "") + sep + relOs;
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {showSettings && (
        <SettingsPanel settings={settings} onChange={saveSettings} onClose={() => setShowSettings(false)} templates={templates} pages={pages} />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.node)} onClose={() => setMenu(null)} />
      )}

      {addMenu && (
        <ContextMenu
          x={addMenu.x}
          y={addMenu.y}
          onClose={() => setAddMenu(null)}
          items={[
            { label: "New page", icon: <FileText size={15} />, onClick: () => tree && setCreate({ kind: "page", tree }) },
            ...(templates.length
              ? [{ label: "New from template…", icon: <FileText size={15} />, onClick: () => setTemplatePicker({ x: addMenu.x, y: addMenu.y, parent: "" }) }]
              : []),
            { label: "New folder", icon: <Folder size={15} />, onClick: () => tree && setCreate({ kind: "folder", tree }) },
            { label: "New database", icon: <Database size={15} />, onClick: () => tree && setCreate({ kind: "database", tree }) },
            { label: "New template", icon: <Stack size={15} />, onClick: () => void newTemplate() },
          ]}
        />
      )}

      {templatePicker && (
        <div className="template-picker-anchor" style={{ left: templatePicker.x, top: templatePicker.y }}>
          <TemplateMenu
            templates={templates}
            blankLabel="Blank page"
            onPick={(rel) =>
              rel
                ? void newPageFromTemplate(rel, templatePicker.parent)
                : templatePicker.parent
                  ? void newPageIn(templatePicker.parent)
                  : tree && setCreate({ kind: "page", tree })
            }
            onClose={() => setTemplatePicker(null)}
          />
        </div>
      )}

      {create && (
        <CreateDialog
          req={create}
          onCancel={() => setCreate(null)}
          onSubmit={(leaf, parentRel) => void runCreate(create.kind, leaf, parentRel)}
        />
      )}

      {iconTarget !== null && (
        <Suspense fallback={null}>
          <IconPicker
            targetLabel={(iconTarget.split("/").pop() ?? iconTarget).replace(/\.md$/i, "") || "Vault"}
            current={settings.node_icons[iconTarget]}
            onPick={(icon) => {
              setNodeIcon(iconTarget, icon);
              setIconTarget(null);
            }}
            onRemove={() => {
              clearNodeIcon(iconTarget);
              setIconTarget(null);
            }}
            onClose={() => setIconTarget(null)}
          />
        </Suspense>
      )}

      {iconBatch !== null && (
        <Suspense fallback={null}>
          <IconPicker
            targetLabel={`${iconBatch.length} items`}
            onPick={(icon) => {
              setIconMany(iconBatch, icon);
              setIconBatch(null);
            }}
            onRemove={() => {
              clearIconMany(iconBatch);
              setIconBatch(null);
            }}
            onClose={() => setIconBatch(null)}
          />
        </Suspense>
      )}

      <AnimatePresence>
        {paletteOpen && (
          <CommandPalette
            pages={pages}
            actions={paletteActions}
            onOpenPage={openPage}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {shortcutsOpen && <ShortcutsPopup onClose={() => setShortcutsOpen(false)} />}
      </AnimatePresence>

      {vp.isMobile && (
        <MobileNavbar
          onToggleLeft={toggleLeft}
          onToggleRight={toggleRight}
          leftOpen={showLeft}
          rightOpen={showRight}
          onSearch={() => setPaletteOpen(true)}
          onAddTask={quickAddTask}
          onNewNote={quickNewNote}
          folders={folders}
        />
      )}

      <DialogHost />
      <ConflictDialogHost />
      <ToastHost />
    </div>
    </>
  );
}
