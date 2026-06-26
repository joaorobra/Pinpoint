// Shared query-DSL builder state + compiler.
//
// PINPOINT's query engine (src-tauri/src/query.rs) is a small Dataview-like DSL:
//   (TABLE field, field… | LIST | TASK) [FROM "folder" | #tag] [WHERE expr] [SORT field [ASC|DESC]]
// It is translated to SQL internally — there is no raw user-SQL path, so nothing here needs to
// escape SQL; we only assemble valid DSL.
//
// Both the standalone Query panel (QueryView.tsx) and the inline query-helper popup
// (QueryHelper.tsx) drive their visual builders through this one module, so the GUI and the
// hand-written DSL share a single compile path.

export interface Filter {
  field: string;
  op: string;
  value: string;
}

export interface BuilderState {
  kind: string;
  cols: string;
  from: string;
  filters: Filter[];
  sort: string;
}

export const OPS = ["=", "!=", ">", "<", ">=", "<=", "contains"];
export const KINDS = ["TABLE", "LIST", "TASK"];

/** One ordered sort key: a field plus its direction. */
export interface SortKey {
  field: string;
  dir: "ASC" | "DESC";
}

/**
 * Parse a SORT clause string (`"priority DESC, due"`) into ordered keys. Empty/blank → no keys.
 * The inverse of `serializeSort`; together they let a UI edit a multi-key sort as discrete rows
 * while `BuilderState.sort` stays a plain DSL fragment (so `compile`/`parse` are unaffected).
 */
export function parseSort(sort: string): SortKey[] {
  return sort
    .split(",")
    .map((part) => part.trim().split(/\s+/))
    .filter((toks) => toks[0])
    .map((toks) => ({ field: toks[0], dir: /^DESC$/i.test(toks[1] ?? "") ? "DESC" : "ASC" }));
}

/** Serialize ordered sort keys back to a DSL SORT fragment (ASC is implicit, so it's omitted). */
export function serializeSort(keys: SortKey[]): string {
  return keys
    .filter((k) => k.field)
    .map((k) => (k.dir === "DESC" ? `${k.field} DESC` : k.field))
    .join(", ");
}

/**
 * Sentinel stored in a saved query's DSL for "the page this query block lives in". It is resolved to
 * the host page's vault-relative path at run time (see `resolveCurrentPage`), so a query like
 * `TASK WHERE path = "{{current}}"` follows the block when it's copied/moved to another page rather
 * than freezing to the path it was authored on.
 */
export const CURRENT_PAGE_TOKEN = "{{current}}";

/**
 * Sentinel for "the leaf name of the page this query block lives in" (e.g. `Note` for `Folder/Note.md`).
 * Distinct from `{{current}}` (the full rel_path): the TASK `ref` filter matches a `[[wikilink]]` by its
 * link target, which is the page name, not its path — so `ref = "{{currentName}}"` gives a backlinks
 * query ("tasks that link to this page") that follows the block when copied to another page.
 */
export const CURRENT_PAGE_NAME_TOKEN = "{{currentName}}";

/** Leaf name of a vault-relative path, minus the `.md` extension — the wikilink target form. */
function pageName(relPath: string): string {
  const leaf = relPath.split("/").pop() ?? relPath;
  return leaf.replace(/\.md$/i, "");
}

/**
 * Substitute the current-page sentinels in a DSL string just before the query runs: `{{current}}` →
 * the host page's rel_path, `{{currentName}}` → its leaf name. No-op when neither token is present or
 * the path is unknown. The query engine never sees a sentinel — both backends run the resolved DSL.
 */
export function resolveCurrentPage(dsl: string, currentPath: string | null | undefined): string {
  if (!currentPath) return dsl;
  let out = dsl;
  if (out.includes(CURRENT_PAGE_NAME_TOKEN)) out = out.split(CURRENT_PAGE_NAME_TOKEN).join(pageName(currentPath));
  if (out.includes(CURRENT_PAGE_TOKEN)) out = out.split(CURRENT_PAGE_TOKEN).join(currentPath);
  return out;
}

export const EMPTY_BUILDER: BuilderState = {
  kind: "TABLE",
  cols: "file.name, status",
  from: "",
  filters: [{ field: "", op: "=", value: "" }],
  sort: "file.name",
};

/** A value is emitted bare when it's a number or boolean, otherwise quoted as a string. */
function literal(value: string): string {
  return /^\d+$|^(true|false)$/.test(value) ? value : `"${value}"`;
}

/** Compile builder state to the DSL string the engine runs. */
export function compile({ kind, cols, from, filters, sort }: BuilderState): string {
  let dsl = kind === "TABLE" ? `TABLE ${cols.trim() || "file.name"}` : kind;
  if (from.trim()) dsl += ` FROM ${from.trim().startsWith("#") ? from.trim() : `"${from.trim()}"`}`;
  const valid = filters.filter((f) => f.field && f.value);
  if (valid.length)
    dsl += " WHERE " + valid.map((f) => `${f.field} ${f.op} ${literal(f.value)}`).join(" AND ");
  if (sort.trim()) dsl += ` SORT ${sort.trim()}`;
  return dsl;
}

const UNPARSEABLE = ["\bOR\b", "\bLIMIT\b"];

/** Strip surrounding double-quotes from a parsed value. */
function unquote(s: string): string {
  return s.replace(/^"(.*)"$/s, "$1");
}

/**
 * Parse a DSL string back into builder state — the inverse of `compile`, so editing an existing
 * query block can re-open the visual builder pre-filled with its selections.
 *
 * Returns `null` for any query the builder can't faithfully round-trip (OR groups, LIMIT, or a shape
 * that doesn't re-compile to the same DSL). The caller then falls back to raw-DSL mode, so a
 * hand-written query is never silently mangled.
 */
export function parse(dsl: string): BuilderState | null {
  const flat = dsl.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  // Bail on clauses the builder has no UI for — better to edit those as raw DSL.
  if (new RegExp(UNPARSEABLE.join("|"), "i").test(flat)) return null;

  const kindMatch = flat.match(/^(TABLE|LIST|TASK)\b/i);
  if (!kindMatch) return null;
  const kind = kindMatch[1].toUpperCase();

  // Columns: TABLE only, between the kind and the first clause keyword.
  let cols = "";
  if (kind === "TABLE") {
    cols = flat
      .slice(kindMatch[0].length)
      .replace(/\b(FROM|WHERE|SORT|LIMIT)\b.*$/i, "")
      .trim();
  }

  const fromMatch = flat.match(/\bFROM\s+(#[\w/.!?-]+|"[^"]*"|'[^']*')/i);
  const from = fromMatch ? unquote(fromMatch[1].replace(/'/g, '"')) : "";

  const whereMatch = flat.match(/\bWHERE\s+(.+?)(?=\s+SORT\b|\s+LIMIT\b|$)/i);
  const filters: Filter[] = [];
  if (whereMatch) {
    for (const clause of whereMatch[1].split(/\s+AND\s+/i)) {
      const m = clause.trim().match(/^([\w.]+)\s*(>=|<=|!=|=|>|<|contains)\s*(.+)$/i);
      if (!m) return null; // an unparsable condition → not a builder-shaped query
      filters.push({ field: m[1], op: m[2].toLowerCase(), value: unquote(m[3].trim()) });
    }
  }
  if (!filters.length) filters.push({ field: "", op: "=", value: "" });

  // The whole SORT clause (up to LIMIT/end) so multi-key sorts like `priority DESC, due` round-trip.
  const sortMatch = flat.match(/\bSORT\s+(.+?)(?=\s+LIMIT\b|$)/i);
  const sort = sortMatch ? sortMatch[1].trim() : "";

  const state: BuilderState = {
    kind,
    cols: cols || "file.name",
    from,
    filters,
    sort,
  };
  // Round-trip guard: if re-compiling doesn't reproduce the original (modulo whitespace), the query
  // has a shape the builder can't represent faithfully — fall back to DSL editing.
  if (compile(state).replace(/\s+/g, " ").trim() !== flat) return null;
  return state;
}
