export interface TreeNode {
  name: string;
  rel_path: string;
  is_dir: boolean;
  is_database: boolean;
  /** Lowercase extension WITHOUT the dot for non-markdown files (e.g. "pdf", "png"); "" otherwise. */
  ext: string;
  children: TreeNode[];
}

/** Asset kinds we can preview in the main pane. Markdown is handled by the editor, not here. */
export type AssetKind = "image" | "pdf" | "text" | "other";

/** A non-markdown file resolved to something the viewer can render. */
export interface AssetData {
  kind: AssetKind;
  /** Object URL (image/pdf) or decoded text (text). Empty for "other". */
  url: string;
  mime: string;
}

/** Map a file extension to how the viewer should render it. */
export function assetKindFor(ext: string): AssetKind {
  const e = ext.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(e)) return "image";
  if (e === "pdf") return "pdf";
  if (["txt", "csv", "json", "log", "yaml", "yml", "toml"].includes(e)) return "text";
  return "other";
}

/**
 * File extension (no dot) for an image MIME type, used to name pasted/dropped attachments.
 * Returns "" for unrecognised types so callers can fall back to the source file's own extension.
 */
export function extForMime(mime: string): string {
  switch (mime.toLowerCase().split(";")[0].trim()) {
    case "image/png": return "png";
    case "image/jpeg":
    case "image/jpg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/svg+xml": return "svg";
    case "image/bmp": return "bmp";
    case "image/avif": return "avif";
    default: return "";
  }
}

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * A recently-opened vault, shown on the Start screen's switcher.
 * `id` is what `openRecentVault` takes: the absolute folder path on the desktop
 * build, or an opaque IndexedDB key on the browser build (no real path exists there).
 */
export interface RecentVault {
  id: string;
  name: string;
  /** Unix-millis of the last open, for ordering. */
  last_opened: number;
}

/** A soft-deleted item living in the vault's `.trash` folder, restorable from the manifest. */
export interface TrashEntry {
  /** Opaque id; also the name of the per-item folder under `.trash`. */
  id: string;
  /** Original vault-relative path the item was deleted from. */
  orig_path: string;
  /** Leaf name (file or folder name) as it appeared in the vault. */
  name: string;
  /** True if the trashed item is a directory. */
  is_dir: boolean;
  /** Unix-millis when it was trashed. */
  deleted_at: number;
}

export interface QueryResult {
  kind: "table" | "list" | "task";
  columns: string[];
  rows: Record<string, unknown>[];
}

/**
 * A full-text search hit: a page whose title or body contains the query. Powers the command
 * palette's "found inside pages" results so Ctrl+K reaches into every `.md` file's contents,
 * not just its name. `line` is the 0-based body line the snippet came from (null for a title-only
 * hit); `snippet` is a short window of body text around the first match.
 */
export interface SearchHit {
  rel_path: string;
  title: string;
  snippet: string;
  line: number | null;
}

export interface TaskRow {
  rel_path: string;
  line: number;
  text: string;
  done: boolean;
  due: string | null;
  rrule: string | null;
  tags: string | null;
  /** Comma-joined ISO dates of completed occurrences (the `✅ …` list). Null when none. */
  done_dates: string | null;
  /** Normalized priority (`high`/`medium`/`low`) from a `priority:: …` field, or null. */
  priority: string | null;
  /** Nesting level by indentation: 0 = top-level, 1 = subtask, … */
  depth: number;
  /** `line` of the enclosing task, or null for a top-level task. */
  parent_line: number | null;
}

// ---- Tags ------------------------------------------------------------------------------------
// Tags work like Obsidian's: `#inline` tags anywhere in a page body plus a frontmatter `tags:`
// list, both indexed together. The Tags view queries pages by tag and surfaces how pages connect
// to each other through shared tags.

/** A tag with the number of distinct pages that carry it. */
export interface TagInfo {
  tag: string;
  count: number;
}

/** A page that carries a tag (shown in the Tags view's page list). */
export interface TagPage {
  rel_path: string;
  title: string;
}

/** A tag that co-occurs with the selected tag on shared pages — one edge of the connection graph. */
export interface TagConnection {
  tag: string;
  /** Number of pages carrying both the selected tag and this one. */
  shared: number;
}

// ---- Databases -------------------------------------------------------------------------------
// A "database" is a folder holding a `.pinpoint-db.json` schema; each row is a `.md` file whose
// frontmatter carries the structured field values (keyed by column id). The `title` column is the
// file name, not a frontmatter field.

/** The property types a database column can hold. */
export type DbColumnType =
  | "title"
  | "text"
  | "number"
  | "currency"
  | "checkbox"
  | "select"
  | "multiselect"
  | "date"
  | "datetime"
  | "daterange"
  // Auto-maintained, read-only timestamps mirrored from the page's `created` / `updated`
  // frontmatter (see api.ts). They surface the always-present page metadata as columns.
  | "created_time"
  | "last_edited_time";

/** A selectable option for `select`/`multiselect` columns. `color` is a CSS color or "". */
export interface DbOption {
  id: string;
  label: string;
  color: string;
}

/** One column (property) in a database schema. */
export interface DbColumn {
  /** Stable key used in row frontmatter; never shown to the user. */
  id: string;
  /** Display name in the header. */
  name: string;
  type: DbColumnType;
  /** Options for select/multiselect columns. */
  options?: DbOption[];
  /** ISO-4217-ish currency code for `currency` columns (e.g. "USD", "BRL", "EUR"). */
  currency?: string;
  /** Persisted column width in px (the user can drag to resize). */
  width?: number;
  /** Optional custom Phosphor icon shown in the header (reuses the page/folder icon system). */
  icon?: NodeIcon;
}

// ---- Views (table / board / calendar / gallery) ---------------------------------------------
// A database can hold several saved views, each with its own layout, filters, sorts, grouping and
// per-property visibility. Views are persisted alongside the columns in `.pinpoint-db.json`.

export type DbViewType = "table" | "board" | "calendar" | "gallery";

/** Comparison operators a filter can use. Which ones apply depends on the column type. */
export type DbFilterOp =
  | "is"
  | "is_not"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "is_not_empty"
  | "checked"
  | "unchecked"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "before"
  | "after"
  | "on_or_before"
  | "on_or_after";

/** One filter condition against a column. `value` meaning depends on the operator/column type. */
export interface DbFilter {
  id: string;
  columnId: string;
  op: DbFilterOp;
  value?: unknown;
}

/** A sort directive: order rows by a column, ascending or descending. */
export interface DbSort {
  columnId: string;
  dir: "asc" | "desc";
}

/** Per-view property settings (visibility + ordering overrides). */
export interface DbViewProperty {
  columnId: string;
  hidden?: boolean;
}

/** A saved view of the database. */
export interface DbView {
  id: string;
  name: string;
  type: DbViewType;
  /** Optional custom icon for the view tab. */
  icon?: NodeIcon;
  filters: DbFilter[];
  /** AND (all must match) or OR (any). */
  filterMatch?: "all" | "any";
  sorts: DbSort[];
  /** Per-property visibility/order; columns not listed default to visible. */
  properties?: DbViewProperty[];
  /** Show each row's page icon next to its title (table/gallery). Absent = shown. */
  showPageIcon?: boolean;
  /** Board view: the select/multiselect column id rows are grouped into lanes by. */
  groupBy?: string;
  /** Calendar view: the date/datetime/daterange column id that places rows on the calendar. */
  dateField?: string;
  /** Calendar view: month or week layout. */
  calendarMode?: "month" | "week";
  /** Gallery/board card: which column to show as the card "cover"/accent, if any. */
  cardCover?: string;
  /** Table view: per-column footer aggregation, keyed by column id. Absent = "none". */
  aggregations?: Record<string, DbAggregation>;
}

/** Footer summary functions a table column can show. Which apply depends on the column type. */
export type DbAggregation =
  | "none"
  | "count"      // total rows
  | "filled"     // rows with a non-empty value
  | "empty"      // rows with an empty value
  | "unique"     // distinct non-empty values
  | "sum"        // numeric/currency
  | "avg"        // numeric/currency
  | "min"        // numeric/currency
  | "max"        // numeric/currency
  | "checked"    // checkbox: count true
  | "unchecked"  // checkbox: count false
  | "percent_checked"; // checkbox: % true

/** The full schema persisted to `.pinpoint-db.json`. */
export interface DbSchema {
  name: string;
  columns: DbColumn[];
  /** Saved views. Absent/empty means a single implicit table view (back-compat). */
  views?: DbView[];
}

/** A value stored in a `daterange` cell. Either bound may be "" while the user fills the other. */
export interface DbDateRange {
  start: string;
  end: string;
}

/** Curated option colors for select/multiselect chips (kept distinct from PRESET_COLORS' ordering). */
export const DB_OPTION_COLORS: string[] = [
  "#7c5cff", "#ef4444", "#f97316", "#f59e0b",
  "#22c55e", "#14b8a6", "#3b82f6", "#ec4899",
  "#8b5cf6", "#a1a1aa",
];

/** Phosphor icon weights, in the order the picker shows them. */
export type IconWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";

export const ICON_WEIGHTS: IconWeight[] = ["thin", "light", "regular", "bold", "fill", "duotone"];

/**
 * A user-chosen icon for a page or folder. `name` is a Phosphor icon name in PascalCase
 * (e.g. "Notebook", "FolderStar"). `color` is a CSS color or "" to inherit the theme text color.
 */
export interface NodeIcon {
  name: string;
  weight: IconWeight;
  color: string;
}

/** Curated preset colors offered in the icon picker. */
export const PRESET_COLORS: string[] = [
  "#7c5cff", // accent violet
  "#ef4444", // red
  "#f97316", // orange
  "#f59e0b", // amber
  "#22c55e", // green
  "#14b8a6", // teal
  "#3b82f6", // blue
  "#ec4899", // pink
  "#a1a1aa", // gray
];

// ---- Themes -----------------------------------------------------------------------------------
// A "theme" is a named palette stored as `.themes/<Name>.json` inside the vault, so it travels with
// the notes like settings.json. One theme carries BOTH a dark and a light variant under the same
// name: the app's Appearance setting (dark/light/system) chooses which variant renders, so a single
// theme spans both modes. Selecting a theme pushes its variant's six core tokens (+ fonts) onto the
// document root; every accent/surface derivative (hovers, rings, tints) recomputes via the existing
// color-mix tokens, so a theme recolors the whole UI without touching any CSS consumer.

/** The six core, user-editable color tokens of a theme variant. Each is a CSS hex string. */
export interface ThemeColors {
  /** Highlights, links, active states — drives all `--accent-*` derivatives. */
  accent: string;
  /** Page background (`--bg`). */
  bg: string;
  /** Raised panels: sidebar, cards, popovers (`--surface`). */
  surface: string;
  /** Primary text (`--text`). */
  text: string;
  /** Secondary / muted text (`--text-dim`). */
  dim: string;
  /** Hairline borders and dividers (`--border`). */
  border: string;
}

/** One appearance variant (dark or light) of a theme. */
export interface ThemeVariant {
  colors: ThemeColors;
}

/**
 * Optional, theme-owned typography overrides applied while the theme is active. Every field is
 * optional ("Inherit"): an unset field falls back to the global default in Settings, so a
 * palette-only theme doesn't disturb the reader's font/size choices. A set field wins.
 */
export interface ThemeType {
  /** UI (interface) font-family. */
  ui?: string;
  /** Editor (content) font-family. */
  editor?: string;
  /** Editor/content text size in px. */
  size?: number;
  /** Editor line height (unitless multiplier). */
  lineHeight?: number;
  /** Editor page-column width in px. */
  pageWidth?: number;
}

/**
 * A named, vault-stored theme with paired dark + light variants and optional typography overrides.
 * `name` is also the file stem (`.themes/<name>.json`). Typography is optional: when unset the theme
 * leaves the global type settings untouched, so a palette-only theme doesn't fight font choices.
 */
export interface Theme {
  name: string;
  dark: ThemeVariant;
  light: ThemeVariant;
  /**
   * Optional typography overrides (font families, size, line height, page width). Replaces the
   * older `fonts` field; `fonts` is still read for backward-compatibility with existing theme files.
   */
  type?: ThemeType;
  /** @deprecated Legacy font-only overrides; migrated into `type` on read. */
  fonts?: { ui?: string; editor?: string };
}

/** A theme as listed for the gallery: its name plus a small preview swatch set per variant. */
export interface ThemeInfo {
  name: string;
  dark: ThemeColors;
  light: ThemeColors;
  /** True when the theme carries any typography overrides (fonts/size/line-height/page-width). */
  hasType: boolean;
}

export interface Settings {
  theme: "light" | "dark" | "system";
  font_family: string;
  editor_font_family: string;
  /** Editor/content text size in px. */
  font_size: number;
  /** Width of the editor page column in px (the draggable ruler). Applies to all pages. */
  page_width: number;
  /** Whole-UI scale factor applied via CSS zoom on the app root (1.0 = 100%). */
  ui_zoom: number;
  accent_color: string;
  background_color: string;
  text_color: string;
  line_height: number;
  periodic_folder: string;
  /** Folder (vault-relative) where reusable {{variable}} templates live. See templates.ts. */
  templates_folder: string;
  /**
   * Per-period template binding: maps a Period ("daily"/"weekly"/…) to a template's vault-relative
   * path. When set, opening/creating that periodic note uses the template instead of the built-in
   * starter. Absent/empty entries fall back to the built-in template.
   */
  periodic_templates: Record<string, string>;
  show_line_numbers: boolean;
  /** Show the floating formatting toolbar (H1–H3, B/I/S, lists…) at the top of the editor. */
  show_format_toolbar: boolean;
  /** Strike through the text of completed (checked) to-do items in the editor. */
  strike_done_tasks: boolean;
  /**
   * What to do with completed (checked) to-dos in the editor body:
   *  - `show` — leave them in place (default);
   *  - `dim`  — keep them but fade them back so open tasks stand out;
   *  - `hide` — collapse them out of view entirely (the markdown still keeps them).
   */
  completed_task_display: "show" | "dim" | "hide";
  /**
   * How an inline `priority:: <level>` field renders in the editor:
   *  - `both` — coloured flag + level word (default);
   *  - `flag` — flag glyph only (compact);
   *  - `text` — level word only, no flag.
   */
  priority_display: "both" | "flag" | "text";
  /**
   * Tint a task's inline due-date marker (`📅`/`due::`) by urgency in the editor — overdue, due
   * today, or due soon. Off renders due dates in the normal text colour.
   */
  highlight_due_dates: boolean;
  /** Pattern (see dateformat.ts tokens) for inserting plain dates in the editor. */
  date_format: string;
  /** Pattern for inserting the current time / "now" timestamps. */
  time_format: string;
  /** Pattern for rendering task due-dates in the Tasks view. */
  task_date_format: string;
  /**
   * Stamp a `done:: <timestamp>` field onto a to-do when its checkbox is ticked (removed when
   * unticked). Off leaves checkboxes untouched.
   */
  stamp_done_date: boolean;
  /**
   * Pattern (see dateformat.ts tokens) for the completion timestamp written by the checkbox stamp.
   * A date-only pattern (e.g. `YYYY-MM-DD`) records just the day; include time tokens (`HH:mm`) for
   * date + time.
   */
  done_date_format: string;
  /**
   * Optional text placed before the completion timestamp in the stamp, e.g. `✅` or `Done` →
   * `done:: ✅ 2026-06-23`. Empty for just the timestamp. Purely cosmetic; the `done::` field key is
   * unchanged so parsing/round-trip is unaffected.
   */
  done_date_prefix: string;
  /** Pattern for the human label of a daily periodic note. */
  periodic_label_format: string;
  /** Per-node icon overrides, keyed by the node's vault-relative path. */
  node_icons: Record<string, NodeIcon>;
  /**
   * "Semi-fullscreen": collapse the custom titlebar so it's hidden, and reveal it only when the
   * pointer hits the top edge of the window. Gives a near-fullscreen, chrome-free workspace while
   * keeping the window controls one hover away. Desktop (Tauri) only.
   */
  auto_hide_titlebar: boolean;
  /**
   * As-you-type symbol replacements (Notion-style): trigger → output, e.g. `"->": "→"`. Editable in
   * Settings. Empty map disables symbol replacement. A single Backspace right after a swap reverts it.
   */
  smart_replacements: Record<string, string>;
  /**
   * Text-expansion snippets: name → inserted text, e.g. `"mycnpj": "12.345.678/0001-90"`. Triggered
   * by wrapping the name in `snippet_delimiter` (default `_`), so `_mycnpj_` expands. Editable in Settings.
   */
  snippets: Record<string, string>;
  /** The delimiter that wraps a snippet name to fire it (default `_` → `_name_`). */
  snippet_delimiter: string;
  /**
   * What to open when this vault is (re)opened:
   *  - `last` — restore the page that was active when the vault was last closed (default);
   *  - `today` — open today's daily periodic note, creating it from the daily template if missing;
   *  - `page` — always open the page named in `startup_page`.
   * The "last page" itself isn't stored here (it changes on every navigation); it lives in
   * app-global localStorage keyed by vault, so this preference stays stable in settings.json.
   */
  startup_behavior: "last" | "today" | "page";
  /** Vault-relative path of the page opened on launch when `startup_behavior` is `page`. */
  startup_page: string;
  /**
   * Name of the active theme (a `.themes/<name>.json` file). Empty = the built-in default palette,
   * i.e. the stock CSS tokens with only `accent_color`/`background_color`/`text_color` applied as
   * before. When set, the theme's dark/light variant supplies the core tokens; the `theme` field
   * still chooses which variant renders.
   */
  active_theme: string;
}

/**
 * The built-in "Default" theme — the stock PINPOINT palette, materialised as a Theme so the editor
 * can show it in the gallery and "duplicate" it as a starting point. It is virtual (never written to
 * disk) and its values mirror the dark/light blocks at the top of styles.css.
 */
export const BUILTIN_THEME: Theme = {
  name: "Default",
  dark: {
    colors: {
      accent: "#7c5cff",
      bg: "#131318",
      surface: "#1a1a21",
      text: "#ececef",
      dim: "#9494a1",
      border: "#2a2a34",
    },
  },
  light: {
    colors: {
      accent: "#7c5cff",
      bg: "#ffffff",
      surface: "#ffffff",
      text: "#1b1b22",
      dim: "#62626d",
      border: "#e6e6ec",
    },
  },
};

/**
 * Curated starter themes seeded into a fresh vault's `.themes/` folder, so the gallery isn't empty
 * and users have ready palettes to pick or remix. Each pairs a tuned dark + light variant.
 */
export const STARTER_THEMES: Theme[] = [
  {
    name: "Midnight",
    dark: {
      colors: { accent: "#6ea8fe", bg: "#0e1116", surface: "#161b22", text: "#e6edf3", dim: "#8b949e", border: "#21262d" },
    },
    light: {
      colors: { accent: "#2f6feb", bg: "#ffffff", surface: "#f6f8fa", text: "#1f2328", dim: "#656d76", border: "#d0d7de" },
    },
  },
  {
    name: "Forest",
    dark: {
      colors: { accent: "#4ade80", bg: "#0f1511", surface: "#161e18", text: "#e7f0ea", dim: "#8aa394", border: "#21302a" },
    },
    light: {
      colors: { accent: "#16a34a", bg: "#fbfdfb", surface: "#f1f7f3", text: "#16241c", dim: "#4f6657", border: "#d7e6dd" },
    },
  },
  {
    name: "Rosé",
    dark: {
      colors: { accent: "#f472b6", bg: "#161114", surface: "#1e161b", text: "#f3e8ef", dim: "#a8909e", border: "#332430" },
    },
    light: {
      colors: { accent: "#db2777", bg: "#fffafc", surface: "#fdf2f8", text: "#27141d", dim: "#6b4f5c", border: "#f3d9e6" },
    },
  },
  {
    name: "Amber",
    dark: {
      colors: { accent: "#fbbf24", bg: "#16130c", surface: "#1f1b12", text: "#f2ecdd", dim: "#a89c80", border: "#332c1c" },
    },
    light: {
      colors: { accent: "#d97706", bg: "#fffdf7", surface: "#fef9ec", text: "#241c0e", dim: "#6b5d44", border: "#f0e4c8" },
    },
  },
  {
    name: "Nord",
    dark: {
      colors: { accent: "#88c0d0", bg: "#2e3440", surface: "#3b4252", text: "#eceff4", dim: "#9aa3b2", border: "#434c5e" },
    },
    light: {
      colors: { accent: "#5e81ac", bg: "#eceff4", surface: "#f7f9fb", text: "#2e3440", dim: "#5b6678", border: "#d8dee9" },
    },
  },
  {
    name: "Dracula",
    dark: {
      colors: { accent: "#bd93f9", bg: "#282a36", surface: "#343746", text: "#f8f8f2", dim: "#9ca0b0", border: "#414458" },
    },
    light: {
      colors: { accent: "#7b4fd1", bg: "#fbfbfd", surface: "#f3f1fb", text: "#282a36", dim: "#5d6072", border: "#e3def2" },
    },
  },
  {
    name: "Solarized",
    dark: {
      colors: { accent: "#268bd2", bg: "#002b36", surface: "#073642", text: "#e6e1cf", dim: "#93a1a1", border: "#0d4a54" },
    },
    light: {
      colors: { accent: "#268bd2", bg: "#fdf6e3", surface: "#f4ecd5", text: "#2c3e44", dim: "#657b83", border: "#e6dcc0" },
    },
  },
  {
    name: "Gruvbox",
    dark: {
      colors: { accent: "#fabd2f", bg: "#282828", surface: "#32302f", text: "#ebdbb2", dim: "#a89984", border: "#3c3836" },
    },
    light: {
      colors: { accent: "#b57614", bg: "#fbf1c7", surface: "#f4e8be", text: "#3c3836", dim: "#7c6f64", border: "#ebdcb2" },
    },
  },
  {
    name: "Ocean",
    dark: {
      colors: { accent: "#22d3ee", bg: "#0b1620", surface: "#11212e", text: "#e2f0f5", dim: "#8aa3ad", border: "#1b3340" },
    },
    light: {
      colors: { accent: "#0891b2", bg: "#f8fdff", surface: "#ecf7fb", text: "#0d2230", dim: "#4d6b78", border: "#cfe6ee" },
    },
  },
  {
    name: "Sunset",
    dark: {
      colors: { accent: "#fb7185", bg: "#1a1117", surface: "#241820", text: "#f4e7ec", dim: "#ad909c", border: "#3a2530" },
    },
    light: {
      colors: { accent: "#e11d48", bg: "#fff8f6", surface: "#fff0ed", text: "#2a1116", dim: "#7a4f57", border: "#f6dcd8" },
    },
  },
  {
    name: "Mono",
    dark: {
      colors: { accent: "#a1a1aa", bg: "#101012", surface: "#18181b", text: "#e8e8ea", dim: "#8a8a93", border: "#27272a" },
    },
    light: {
      colors: { accent: "#52525b", bg: "#fafafa", surface: "#f4f4f5", text: "#18181b", dim: "#71717a", border: "#e4e4e7" },
    },
  },
  {
    // Claude's brand identity: the warm terracotta accent on Anthropic's cream (light) / warm-charcoal
    // (dark) surfaces, muted warm-gray text, and Claude-flavored type — Hanken Grotesk (a Styrene-like
    // grotesk) for the UI and Fraunces (a Tiempos-like serif) for reading.
    name: "Cláudio",
    dark: {
      colors: { accent: "#d97757", bg: "#1f1e1d", surface: "#262624", text: "#f0eee6", dim: "#a6a097", border: "#34322e" },
    },
    light: {
      colors: { accent: "#c25f3c", bg: "#faf9f5", surface: "#f0eee6", text: "#1f1e1d", dim: "#73706b", border: "#e3e0d6" },
    },
    type: { ui: "'Hanken Grotesk', system-ui, sans-serif", editor: "Fraunces, serif" },
  },
];

/** The built-in symbol replacements seeded into a fresh vault. Users can edit/remove/add any. */
export const DEFAULT_SMART_REPLACEMENTS: Record<string, string> = {
  "->": "→",
  "<-": "←",
  "<->": "↔",
  "=>": "⇒",
  "<=": "⇐",
  "(tm)": "™",
  "(c)": "©",
  "(r)": "®",
  "!=": "≠",
  "+-": "±",
  ">=": "≥",
  "=<": "≤",
  "~=": "≈",
  "...": "…",
  "1/2": "½",
  "1/4": "¼",
  "3/4": "¾",
  "1/3": "⅓",
  "2/3": "⅔",
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  font_family: "Inter, system-ui, sans-serif",
  editor_font_family: "Inter, system-ui, sans-serif",
  font_size: 16,
  page_width: 820,
  ui_zoom: 1,
  accent_color: "#7c5cff",
  background_color: "",
  text_color: "",
  line_height: 1.6,
  periodic_folder: "Periodic",
  templates_folder: "Templates",
  periodic_templates: {},
  show_line_numbers: false,
  show_format_toolbar: true,
  strike_done_tasks: true,
  completed_task_display: "show",
  priority_display: "both",
  highlight_due_dates: true,
  date_format: "YYYY-MM-DD",
  time_format: "HH:mm",
  task_date_format: "ddd, D MMM",
  stamp_done_date: true,
  done_date_format: "YYYY-MM-DD HH:mm",
  done_date_prefix: "",
  periodic_label_format: "dddd, MMMM D",
  node_icons: {},
  auto_hide_titlebar: false,
  smart_replacements: { ...DEFAULT_SMART_REPLACEMENTS },
  snippets: {},
  snippet_delimiter: "_",
  startup_behavior: "last",
  startup_page: "",
  active_theme: "",
};
