// Pure helpers shared by every database view (table, board, calendar, gallery):
//   - coercing a raw frontmatter value to something comparable for a column type,
//   - evaluating a single filter and a whole filter set against a row,
//   - sorting rows by a view's sort directives,
//   - which filter operators apply to which column type.
//
// Kept free of React so each view can filter/sort/group without duplicating logic.

import type {
  DbAggregation,
  DbColumn,
  DbColumnType,
  DbDateRange,
  DbFilter,
  DbFilterOp,
  DbSort,
} from "./types";

/** A row as the views consume it: the file path, its title, and its frontmatter field map. */
export interface DbRow {
  rel_path: string;
  title: string;
  fields: Record<string, unknown>;
}

/** Read a column's value from a row. The title column lives on `row.title`, not in `fields`. */
export function cellValue(row: DbRow, col: DbColumn): unknown {
  if (col.type === "title") return row.title;
  // Timestamp columns mirror the page's auto-maintained `created` / `updated` frontmatter
  // (the same fixed keys api.ts stamps), not a per-column id.
  if (col.type === "created_time") return row.fields.created;
  if (col.type === "last_edited_time") return row.fields.updated;
  return row.fields[col.id];
}

/** True when a value counts as empty for filtering/grouping. */
export function isEmpty(v: unknown): boolean {
  if (v == null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    const r = v as DbDateRange;
    return !r.start && !r.end;
  }
  return false;
}

/** The first ISO date a value represents (date/datetime/daterange), for calendar + date sorts. */
export function primaryDate(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 10);
  if (v && typeof v === "object") {
    const r = v as DbDateRange;
    return (r.start || r.end || "").slice(0, 10);
  }
  return "";
}

/** A comparable scalar for sorting: numbers stay numbers, dates/strings become sortable strings. */
function sortKey(v: unknown, type: DbColumnType): number | string {
  if (isEmpty(v)) return type === "number" || type === "currency" ? -Infinity : "";
  switch (type) {
    case "number":
    case "currency":
      return typeof v === "number" ? v : Number(v) || 0;
    case "checkbox":
      return v === true ? 1 : 0;
    case "date":
    case "datetime":
    case "daterange":
    case "created_time":
    case "last_edited_time":
      // Sort timestamps by their full ISO string so same-day edits still order by time.
      return type === "datetime" || type === "created_time" || type === "last_edited_time"
        ? typeof v === "string"
          ? v
          : primaryDate(v)
        : primaryDate(v);
    case "multiselect":
      return Array.isArray(v) ? v.join(",") : String(v);
    default:
      return String(v).toLowerCase();
  }
}

/** Lowercased string form of a value, for `contains`/text comparisons. */
function asText(v: unknown): string {
  if (isEmpty(v)) return "";
  if (Array.isArray(v)) return v.join(" ").toLowerCase();
  if (typeof v === "object") {
    const r = v as DbDateRange;
    return `${r.start} ${r.end}`.toLowerCase();
  }
  return String(v).toLowerCase();
}

/** Evaluate one filter against a row. Unknown column → passes (don't hide rows on a stale filter). */
export function matchesFilter(row: DbRow, filter: DbFilter, columns: DbColumn[]): boolean {
  const col = columns.find((c) => c.id === filter.columnId);
  if (!col) return true;
  const v = cellValue(row, col);
  const fv = filter.value;

  switch (filter.op) {
    case "is_empty":
      return isEmpty(v);
    case "is_not_empty":
      return !isEmpty(v);
    case "checked":
      return v === true;
    case "unchecked":
      return v !== true;
    case "is":
      if (col.type === "multiselect") return Array.isArray(v) && v.includes(fv as string);
      return asText(v) === asText(fv);
    case "is_not":
      if (col.type === "multiselect") return !(Array.isArray(v) && v.includes(fv as string));
      return asText(v) !== asText(fv);
    case "contains":
      return asText(v).includes(asText(fv));
    case "not_contains":
      return !asText(v).includes(asText(fv));
    case "gt":
      return num(v) > num(fv);
    case "lt":
      return num(v) < num(fv);
    case "gte":
      return num(v) >= num(fv);
    case "lte":
      return num(v) <= num(fv);
    case "before":
      return primaryDate(v) !== "" && primaryDate(v) < String(fv);
    case "after":
      return primaryDate(v) !== "" && primaryDate(v) > String(fv);
    case "on_or_before":
      return primaryDate(v) !== "" && primaryDate(v) <= String(fv);
    case "on_or_after":
      return primaryDate(v) !== "" && primaryDate(v) >= String(fv);
    default:
      return true;
  }
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

/** Apply a view's filter set (AND/OR) to the rows. */
export function applyFilters(
  rows: DbRow[],
  filters: DbFilter[],
  columns: DbColumn[],
  match: "all" | "any" = "all"
): DbRow[] {
  if (!filters.length) return rows;
  return rows.filter((row) => {
    const results = filters.map((f) => matchesFilter(row, f, columns));
    return match === "any" ? results.some(Boolean) : results.every(Boolean);
  });
}

/** Stable multi-key sort by a view's sort directives. */
export function applySorts(rows: DbRow[], sorts: DbSort[], columns: DbColumn[]): DbRow[] {
  if (!sorts.length) return rows;
  const cols = new Map(columns.map((c) => [c.id, c]));
  const out = [...rows];
  out.sort((a, b) => {
    for (const s of sorts) {
      const col = cols.get(s.columnId);
      if (!col) continue;
      const ka = sortKey(cellValue(a, col), col.type);
      const kb = sortKey(cellValue(b, col), col.type);
      let cmp = 0;
      if (typeof ka === "number" && typeof kb === "number") cmp = ka - kb;
      else cmp = String(ka).localeCompare(String(kb));
      if (cmp !== 0) return s.dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
  return out;
}

/** Operators offered for a column type, in menu order. */
export function opsForType(type: DbColumnType): DbFilterOp[] {
  switch (type) {
    case "checkbox":
      return ["checked", "unchecked"];
    case "number":
    case "currency":
      return ["is", "is_not", "gt", "lt", "gte", "lte", "is_empty", "is_not_empty"];
    case "select":
      return ["is", "is_not", "is_empty", "is_not_empty"];
    case "multiselect":
      return ["is", "is_not", "is_empty", "is_not_empty"];
    case "date":
    case "datetime":
    case "daterange":
    case "created_time":
    case "last_edited_time":
      return ["is", "before", "after", "on_or_before", "on_or_after", "is_empty", "is_not_empty"];
    default:
      return ["is", "is_not", "contains", "not_contains", "is_empty", "is_not_empty"];
  }
}

/** Human label for an operator. */
export const OP_LABELS: Record<DbFilterOp, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "does not contain",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  checked: "is checked",
  unchecked: "is unchecked",
  gt: "greater than",
  lt: "less than",
  gte: "≥",
  lte: "≤",
  before: "before",
  after: "after",
  on_or_before: "on or before",
  on_or_after: "on or after",
};

/** Operators that need no value input (the operator itself is the whole condition). */
export function opNeedsValue(op: DbFilterOp): boolean {
  return !["is_empty", "is_not_empty", "checked", "unchecked"].includes(op);
}

// ---- Footer aggregations ---------------------------------------------------------------------

/** Short labels for the footer aggregation menu/result. */
export const AGG_LABELS: Record<DbAggregation, string> = {
  none: "None",
  count: "Count all",
  filled: "Filled",
  empty: "Empty",
  unique: "Unique",
  sum: "Sum",
  avg: "Average",
  min: "Min",
  max: "Max",
  checked: "Checked",
  unchecked: "Unchecked",
  percent_checked: "% checked",
};

/** Which aggregations make sense for a given column type. "none" is always first. */
export function aggsForType(type: DbColumnType): DbAggregation[] {
  const common: DbAggregation[] = ["none", "count", "filled", "empty"];
  switch (type) {
    case "number":
    case "currency":
      return [...common, "unique", "sum", "avg", "min", "max"];
    case "checkbox":
      return ["none", "count", "checked", "unchecked", "percent_checked"];
    case "select":
    case "multiselect":
    case "text":
    case "title":
      return [...common, "unique"];
    default:
      return common;
  }
}

/** Coerce a cell value to a number for numeric aggregations (multiselect counts its items, etc.). */
function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Compute one column's footer aggregation across the (already filtered) rows.
 * Returns `null` when the aggregation is "none" or has nothing to show, so the
 * footer cell can render empty. `format` numbers via the caller (for currency).
 */
export function computeAggregation(
  agg: DbAggregation,
  rows: DbRow[],
  col: DbColumn,
): { value: string; numeric: number | null } | null {
  if (agg === "none") return null;
  const values = rows.map((r) => cellValue(r, col));
  const total = values.length;

  const intRes = (n: number) => ({ value: String(n), numeric: n });

  switch (agg) {
    case "count":
      return intRes(total);
    case "filled":
      return intRes(values.filter((v) => !isEmpty(v)).length);
    case "empty":
      return intRes(values.filter((v) => isEmpty(v)).length);
    case "unique": {
      const seen = new Set<string>();
      for (const v of values) {
        if (isEmpty(v)) continue;
        if (Array.isArray(v)) v.forEach((x) => seen.add(String(x)));
        else seen.add(String(v));
      }
      return intRes(seen.size);
    }
    case "checked":
      return intRes(values.filter((v) => v === true).length);
    case "unchecked":
      return intRes(values.filter((v) => v !== true).length);
    case "percent_checked": {
      if (total === 0) return { value: "0%", numeric: 0 };
      const pct = Math.round((values.filter((v) => v === true).length / total) * 100);
      return { value: `${pct}%`, numeric: pct };
    }
    case "sum":
    case "avg":
    case "min":
    case "max": {
      const nums = values.map(asNumber).filter((n): n is number => n != null);
      if (nums.length === 0) return null;
      let n: number;
      if (agg === "sum") n = nums.reduce((a, b) => a + b, 0);
      else if (agg === "avg") n = nums.reduce((a, b) => a + b, 0) / nums.length;
      else if (agg === "min") n = Math.min(...nums);
      else n = Math.max(...nums);
      // Round avg to a sane precision; leave others exact.
      const rounded = agg === "avg" ? Math.round(n * 100) / 100 : n;
      return { value: String(rounded), numeric: rounded };
    }
    default:
      return null;
  }
}
