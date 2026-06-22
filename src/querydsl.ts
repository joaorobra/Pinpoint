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
