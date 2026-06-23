import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import {
  Plus,
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
  X,
  File as FileIcon,
  Database,
  Stack,
  SidebarSimple,
} from "@phosphor-icons/react";
import { api, pickVaultFolder, resolveRecentVault, listRecentVaults } from "./api";
import { getTheme, seedStarterThemes } from "./themes-store";
import { applyTheme, resolveMode } from "./theme-apply";
import type { Theme } from "./types";
import { slideFade, transition } from "./motion";
import StartScreen from "./components/StartScreen";
import type { NodeIcon, Settings, TreeNode } from "./types";
import { DEFAULT_SETTINGS, extForMime } from "./types";
import { collectTemplates, fillTemplate, stripCursor, type FillContext, type TemplateInfo } from "./templates";
import type { Period } from "./periodic";
import Editor from "./components/Editor";
import FileTree, { type SelectMods } from "./components/FileTree";
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
import { DialogHost, dialogs } from "./components/Dialogs";
import CommandPalette, { type PaletteAction } from "./components/CommandPalette";
import ShortcutsPopup from "./components/ShortcutsPopup";
import PageProperties from "./components/PageProperties";
import Titlebar from "./components/Titlebar";

type RightTab = "editor" | "tasks" | "query" | "tags" | "trash";

/** The three kinds of document an open tab can hold. */
type DocKind = "page" | "asset" | "db";

// Pasted/dropped images live in a single vault-root `.attachments` folder (a dotfolder, so it
// stays out of the file tree like `.obsidian`). The markdown stores a vault-relative path into it
// and the editor's image node resolves that back through the API.
const ATTACHMENTS_DIR = ".attachments";

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

export default function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [vaultName, setVaultName] = useState<string>("");
  // True while the boot effect tries to auto-open the most recent vault, so we don't
  // flash the Start screen before we know whether there's a vault to restore.
  const [booting, setBooting] = useState(true);
  const [activePath, setActivePath] = useState<string | null>(null);
  // Multi-selected tree rows (rel_paths). Driven by ctrl/shift-click; a plain click collapses
  // this back to just the opened row. Used for bulk actions from the context menu.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // A non-markdown file (PDF/image/…) currently shown in the viewer pane, or null for the editor.
  const [activeAsset, setActiveAsset] = useState<TreeNode | null>(null);
  // The database folder currently shown in the table view, or null. Mutually exclusive with the
  // editor/asset panes (a database is a third kind of "doc").
  const [activeDb, setActiveDb] = useState<TreeNode | null>(null);
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

  // ---- Resizable side panels ----
  // Widths (px) of the left and right sidebars, persisted in localStorage (app-global UI state,
  // not vault content). Clamped to a sane range; the editor column flexes to fill the rest.
  const LEFT_MIN = 200, LEFT_MAX = 560;
  const RIGHT_MIN = 200, RIGHT_MAX = 560;
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("pp.leftWidth"));
    return v >= LEFT_MIN && v <= LEFT_MAX ? v : 286;
  });
  const [rightWidth, setRightWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("pp.rightWidth"));
    return v >= RIGHT_MIN && v <= RIGHT_MAX ? v : 280;
  });

  // Whether each sidebar is shown. Persisted in localStorage (app-global UI state). When a sidebar
  // is hidden its grid column AND its resizer collapse to 0, so the editor reclaims the space; a
  // toggle button in the tabs bar brings it back.
  const [leftOpen, setLeftOpen] = useState<boolean>(
    () => localStorage.getItem("pp.leftOpen") !== "0"
  );
  const [rightOpen, setRightOpen] = useState<boolean>(
    () => localStorage.getItem("pp.rightOpen") !== "0"
  );
  const toggleLeft = useCallback(
    () => setLeftOpen((v) => (localStorage.setItem("pp.leftOpen", v ? "0" : "1"), !v)),
    []
  );
  const toggleRight = useCallback(
    () => setRightOpen((v) => (localStorage.setItem("pp.rightOpen", v ? "0" : "1"), !v)),
    []
  );

  // Begin dragging a sidebar divider. `side` picks which edge; the handler tracks the pointer
  // until release, clamps the new width, and persists it.
  const startResize = useCallback(
    (side: "left" | "right") => (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = side === "left" ? leftWidth : rightWidth;
      const min = side === "left" ? LEFT_MIN : RIGHT_MIN;
      const max = side === "left" ? LEFT_MAX : RIGHT_MAX;
      // Left edge grows with rightward drag; right edge grows with leftward drag.
      const dir = side === "left" ? 1 : -1;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      // Suspend the grid-track easing so the panel tracks the pointer 1:1 while dragging.
      document.querySelector(".app")?.classList.add("resizing");
      const onMove = (ev: PointerEvent) => {
        const next = Math.min(max, Math.max(min, startW + dir * (ev.clientX - startX)));
        side === "left" ? setLeftWidth(next) : setRightWidth(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.querySelector(".app")?.classList.remove("resizing");
        // Read the committed width off the element via the setter's latest value.
        side === "left"
          ? setLeftWidth((w) => (localStorage.setItem("pp.leftWidth", String(w)), w))
          : setRightWidth((w) => (localStorage.setItem("pp.rightWidth", String(w)), w));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [leftWidth, rightWidth]
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
      // 2) Fonts: a theme may override them; otherwise the Typography settings stand.
      root.style.setProperty("--font-ui", activeTheme?.fonts?.ui || settings.font_family);
      root.style.setProperty("--font-editor", activeTheme?.fonts?.editor || settings.editor_font_family);
      root.style.setProperty("--font-size", `${settings.font_size}px`);
      root.style.setProperty("--line-height", String(settings.line_height));
      root.style.setProperty("--page-width", `${settings.page_width || 820}px`);
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

  // ---- File watcher: the Tauri backend emits "vault-changed". The browser build has no
  //      native watcher, so we simply skip it there (the user re-indexes with ⟳). ----
  useEffect(() => {
    let dispose: (() => void) | undefined;
    listen("vault-changed", () => {
      refreshTree();
      setTaskRefresh((k) => k + 1);
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
  // and load its tree + settings into the UI.
  const loadVault = useCallback(async (path: string) => {
    const t = await api.openVault(path);
    setTree(t);
    setVaultName(t.name);
    setSettings(await api.getSettings());
    // Seed curated starter themes the first time a vault is opened (no-op if `.themes/` exists).
    seedStarterThemes();
  }, []);

  // Pick a brand-new vault folder, then open it.
  const openVault = useCallback(async () => {
    let path: string | null;
    try {
      path = await pickVaultFolder();
    } catch (e) {
      // User dismissed the picker (AbortError) — or the browser is unsupported.
      if (e instanceof DOMException && e.name === "AbortError") return;
      console.error(e);
      return;
    }
    if (!path) return;
    await loadVault(path);
  }, [loadVault]);

  // Re-open a vault from the Start screen's recent list (re-grants web permission first).
  const openRecent = useCallback(
    async (id: string) => {
      try {
        const path = await resolveRecentVault(id);
        if (!path) return; // handle gone / couldn't resolve
        await loadVault(path);
      } catch (e) {
        console.error(e);
      }
    },
    [loadVault]
  );

  // Return to the Start screen to pick a different vault. The open document state is
  // cleared so nothing from the old vault leaks into the next one.
  const switchVault = useCallback(() => {
    setTree(null);
    setVaultName("");
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
        await loadVault(path);
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

  const openPage = useCallback(
    async (relPath: string) => {
      const doc = await api.readPage(relPath);
      setActiveAsset(null);
      setActiveDb(null);
      setActivePath(relPath);
      setBody(doc.body);
      setFrontmatter(doc.frontmatter as Record<string, unknown>);
      setReloadKey(relPath + ":" + Date.now());
      setTab("editor");
      setDirty(false);
      addTab(relPath, "page");
      pushHistory(relPath);
    },
    [addTab, pushHistory]
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
      setActivePath(node.rel_path);
      setTab("editor");
      addTab(node.rel_path, "asset");
      pushHistory(node.rel_path);
    },
    [addTab, pushHistory]
  );

  // Open a database folder in the table view (a third "doc" kind alongside pages and assets).
  const openDatabase = useCallback(
    (node: TreeNode) => {
      setActiveAsset(null);
      setActiveDb(node);
      setActivePath(node.rel_path);
      setReloadKey(node.rel_path + ":" + Date.now());
      setTab("editor");
      setDirty(false);
      addTab(node.rel_path, "db");
      pushHistory(node.rel_path);
    },
    [addTab, pushHistory]
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

  // Activate an already-known doc (tab click / history replay) by path, picking page/asset/db.
  const activateDoc = useCallback(
    (path: string, kind: DocKind) => {
      if (kind === "asset") {
        const node = findNode(path);
        if (node) openAsset(node);
      } else if (kind === "db") {
        const node = findNode(path);
        if (node) openDatabase(node);
      } else {
        openPage(path);
      }
    },
    [findNode, openPage, openAsset, openDatabase]
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

  const duplicateNode = useCallback(
    async (node: TreeNode) => {
      // Only pages duplicate cleanly via the page API; assets/folders are excluded in the menu.
      const doc = await api.readPage(node.rel_path);
      const base = node.rel_path.replace(/\.md$/i, "");
      const copyRel = `${base} copy.md`;
      await api.writePage(copyRel, doc.frontmatter as Record<string, unknown>, doc.body);
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

  // Delete a single node. By default it's a soft delete (move to `.trash`, restorable from the
  // Trash tab); `permanent` (shift-delete) skips the trash and removes it irreversibly.
  const deleteNode = useCallback(
    async (node: TreeNode, permanent = false) => {
      const what = node.is_dir ? "folder (and everything in it)" : "file";
      const ok = await dialogs.confirm({
        title: permanent ? `Permanently delete this ${what}?` : `Move this ${what} to Trash?`,
        message: permanent ? `${node.rel_path}\n\nThis can't be undone.` : node.rel_path,
        confirmLabel: permanent ? "Delete forever" : "Move to Trash",
        danger: true,
      });
      if (!ok) return;
      try {
        if (permanent) await api.deletePage(node.rel_path);
        else await api.trashPage(node.rel_path);
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
    },
    [refreshTree, forgetTabs]
  );

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
      const ok = await dialogs.confirm({
        title: permanent
          ? `Permanently delete ${roots.length} item${roots.length === 1 ? "" : "s"}?`
          : `Move ${roots.length} item${roots.length === 1 ? "" : "s"} to Trash?`,
        message: permanent ? `${roots.join("\n")}\n\nThis can't be undone.` : roots.join("\n"),
        confirmLabel: permanent ? "Delete forever" : "Move to Trash",
        danger: true,
      });
      if (!ok) return;
      const failed: string[] = [];
      for (const p of roots) {
        try {
          if (permanent) await api.deletePage(p);
          else await api.trashPage(p);
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
    [selected, deleteMany, affixMany, settings.node_icons, openPage, openAsset, renameNode, duplicateNode, deleteNode, newPageIn, convertToDatabase, templates, menu]
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
  }, [tree, newPage, changeZoom, selected, activePath, deleteMany, navHistory, closeTab, setShortcutsOpen]);

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
        run: () => api.reindex().then(() => setTaskRefresh((k) => k + 1)),
      },
      { id: "settings", label: "Open settings", hint: "Appearance & more", icon: GearSix, run: () => setShowSettings(true) },
      { id: "switch-vault", label: "Switch vault", hint: "Back to start", icon: FolderOpen, run: switchVault },
      { id: "tab-tasks", label: "Go to Tasks", icon: CheckCircle, run: () => setTab("tasks") },
      { id: "tab-query", label: "Go to Query", icon: FileText, run: () => setTab("query") },
      { id: "tab-trash", label: "Open Trash", hint: "Restore deleted items", icon: Trash, run: () => setTab("trash") },
    ],
    [newPage, switchVault]
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
        {booting ? <div className="start" /> : <StartScreen onOpenNew={openVault} onOpenRecent={openRecent} />}
      </>
    );
  }

  return (
    <>
    <Titlebar title={vaultName} autoHide={settings.auto_hide_titlebar} />
    <div
      className="app"
      style={{
        gridTemplateColumns: `${leftOpen ? `${leftWidth}px 6px` : "0px 0px"} 1fr ${
          rightOpen ? `6px ${rightWidth}px` : "0px 0px"
        }`,
      }}
    >
      <AnimatePresence initial={false}>
      {leftOpen && (
      <motion.aside
        className="sidebar"
        {...slideFade({ axis: "x", distance: -24, speed: "slow" })}
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
            <button
              className={addMenu ? "is-active" : undefined}
              title="Create…"
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
            <button onClick={() => api.reindex().then(() => setTaskRefresh((k) => k + 1))} title="Re-index">
              <ArrowsClockwise size={16} weight="bold" />
            </button>
            <button onClick={() => setShowSettings(true)} title="Settings"><GearSix size={16} weight="bold" /></button>
            <button onClick={toggleLeft} title="Hide sidebar"><SidebarSimple size={16} weight="bold" /></button>
          </div>
        </div>
        <div className="tree">
          <FileTree
            node={tree}
            activePath={activePath}
            selected={selected}
            onSelect={onSelect}
            nodeIcons={settings.node_icons}
            onOpen={openPage}
            onOpenAsset={openAsset}
            onOpenDatabase={openDatabase}
            onContextMenu={(node, x, y) => {
              // Right-clicking outside the current multi-selection resets it to that row,
              // so the bulk menu only shows when you right-click within the selection.
              if (!selected.has(node.rel_path)) setSelected(new Set([node.rel_path]));
              setMenu({ node, x, y });
            }}
            onPickIcon={(node) => setIconTarget(node.rel_path)}
            renamingPath={renamingPath}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRenamingPath(null)}
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

      {leftOpen && (
        <div className="resizer" onPointerDown={startResize("left")} title="Drag to resize" />
      )}

      {/* Pin main to the 3rd grid column. The sidebars/resizers are conditionally
          rendered, so without an explicit placement `main` would auto-flow into the
          first (0px) column when the left panel is hidden, blanking the screen. */}
      <main className="main" style={{ gridColumn: 3 }}>
        <div className="tabs">
          <div className="nav-arrows">
            {!leftOpen && (
              <button
                className="nav-arrow"
                onClick={toggleLeft}
                title="Show sidebar"
                aria-label="Show sidebar"
              >
                <SidebarSimple size={15} weight="bold" />
              </button>
            )}
            <button
              className="nav-arrow"
              disabled={!canBack}
              onClick={() => navHistory(-1)}
              title="Back (Alt+←)"
              aria-label="Back"
            >
              <CaretLeft size={15} weight="bold" />
            </button>
            <button
              className="nav-arrow"
              disabled={!canForward}
              onClick={() => navHistory(1)}
              title="Forward (Alt+→)"
              aria-label="Forward"
            >
              <CaretRight size={15} weight="bold" />
            </button>
          </div>

          <div className="doc-tabs" role="tablist">
            {openDocs.map((d) => {
              const isActive = d.path === activePath && tab === "editor";
              const label = (d.path.split("/").pop() ?? d.path).replace(/\.md$/i, "");
              return (
                <div
                  key={d.path}
                  className={`doc-tab${isActive ? " active" : ""}`}
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
                      fallback={d.kind === "asset" ? FileIcon : d.kind === "db" ? Database : FileText}
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
            <button className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}>
              Tasks
            </button>
            <button className={tab === "query" ? "active" : ""} onClick={() => setTab("query")}>
              Query
            </button>
            <button className={tab === "tags" ? "active" : ""} onClick={() => setTab("tags")}>
              Tags
            </button>
            <button
              className={`right-toggle${rightOpen ? " active" : ""}`}
              onClick={toggleRight}
              title={rightOpen ? "Hide right panel" : "Show right panel"}
              aria-label={rightOpen ? "Hide right panel" : "Show right panel"}
            >
              <SidebarSimple size={15} weight="bold" style={{ transform: "scaleX(-1)" }} />
            </button>
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
                ? `editor:${activeDb?.rel_path ?? activeAsset?.rel_path ?? activePath ?? "empty"}`
                : tab
            }
            className="content-view"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={transition("fast")}
          >
          {tab === "editor" &&
            (activeDb ? (
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
                onOpenTag={(t) => {
                  setTagFocus((s) => ({ tag: t, n: (s?.n ?? 0) + 1 }));
                  setTab("tags");
                }}
                onAddAttachment={addAttachment}
                onAttachmentRemoved={onAttachmentRemoved}
                onTaskToggled={onTaskToggled}
                pageWidth={settings.page_width || 820}
                onPageWidthChange={setPageWidth}
                dateFormat={settings.date_format}
                timeFormat={settings.time_format}
                taskDateFormat={settings.task_date_format}
                insertText={tokenInsert}
                smartReplacements={settings.smart_replacements}
                snippets={settings.snippets}
                snippetDelimiter={settings.snippet_delimiter}
                headerSlot={
                  activePageDb ? (
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
                  ) : undefined
                }
              />
            ) : (
              <div className="empty">
                Select a page from the sidebar, or create one with <Plus size={14} weight="bold" />.
              </div>
            ))}
          {tab === "tasks" && (
            <TasksView onOpen={openPage} refreshKey={taskRefresh} dateFormat={settings.task_date_format} />
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

      {rightOpen && (
        <div className="resizer" onPointerDown={startResize("right")} title="Drag to resize" />
      )}

      <AnimatePresence initial={false}>
      {rightOpen && (
      <motion.div
        key="right-sidebar"
        {...slideFade({ axis: "x", distance: 24, speed: "slow" })}
        style={{ gridColumn: 5, display: "flex", minHeight: 0 }}
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
          taskRefresh={taskRefresh}
        />
      </motion.div>
      )}
      </AnimatePresence>

      {showSettings && (
        <SettingsPanel settings={settings} onChange={saveSettings} onClose={() => setShowSettings(false)} templates={templates} />
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

      <DialogHost />
    </div>
    </>
  );
}
