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

export interface Settings {
  theme: "light" | "dark" | "system";
  font_family: string;
  editor_font_family: string;
  /** Editor/content text size in px. */
  font_size: number;
  /** Whole-UI scale factor applied via CSS zoom on the app root (1.0 = 100%). */
  ui_zoom: number;
  accent_color: string;
  background_color: string;
  text_color: string;
  line_height: number;
  periodic_folder: string;
  show_line_numbers: boolean;
  /** Pattern (see dateformat.ts tokens) for inserting plain dates in the editor. */
  date_format: string;
  /** Pattern for inserting the current time / "now" timestamps. */
  time_format: string;
  /** Pattern for rendering task due-dates in the Tasks view. */
  task_date_format: string;
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
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  font_family: "Inter, system-ui, sans-serif",
  editor_font_family: "Inter, system-ui, sans-serif",
  font_size: 16,
  ui_zoom: 1,
  accent_color: "#7c5cff",
  background_color: "",
  text_color: "",
  line_height: 1.6,
  periodic_folder: "Periodic",
  show_line_numbers: false,
  date_format: "YYYY-MM-DD",
  time_format: "HH:mm",
  task_date_format: "ddd, D MMM",
  periodic_label_format: "dddd, MMMM D",
  node_icons: {},
  auto_hide_titlebar: false,
};
