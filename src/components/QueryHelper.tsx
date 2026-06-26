import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { api } from "../api";
import type { QueryResult } from "../types";
import {
  OPS,
  KINDS,
  compile,
  parse,
  parseSort,
  serializeSort,
  resolveCurrentPage,
  CURRENT_PAGE_TOKEN,
  CURRENT_PAGE_NAME_TOKEN,
  EMPTY_BUILDER,
  type BuilderState,
  type Filter,
  type SortKey,
} from "../querydsl";
import Select, { type SelectOption, type SelectGroup } from "./Select";
import QueryResultView from "./QueryResultView";
import { useQuerySources } from "./useQuerySources";

const OP_OPTIONS: SelectOption[] = OPS.map((o) => ({ value: o, label: o }));
const KIND_OPTIONS: SelectOption[] = KINDS.map((k) => ({ value: k, label: k }));

// Fields a TASK query can filter on (the engine's task columns), with `ref` — "links to page" —
// surfaced as a first-class option so users don't have to hand-type `text contains [[Page]]`.
const TASK_FIELDS = ["text", "done", "due", "priority", "recurring", "tag", "ref", "path"];

type Mode = "easy" | "builder" | "dsl";

interface Props {
  /** Editor-wrap-relative vertical anchor; the popup is pinned to the right edge horizontally. */
  top: number;
  /** DSL to pre-populate (when editing an existing block); empty for a fresh insert. */
  initialDsl?: string;
  /** Vault-relative path of the host page, so the live Preview can resolve the `{{current}}` token. */
  currentPath?: string | null;
  /** Commit the composed DSL into the document. */
  onInsert: (dsl: string) => void;
  onClose: () => void;
}

/**
 * Inline query-helper popup: a compact visual builder for composing a Dataview-like query and
 * dropping it into the editor as an inline query block. Three modes share one builder state +
 * compile path (querydsl.ts):
 *   - Easy: pick the source (folder or tag) and fields from menus of what's actually in the vault —
 *     no hand-typing of paths or field keys.
 *   - Builder: the same form with free-text inputs, for fields the menus don't list.
 *   - DSL: the raw query string (the safe round-trip for hand-written queries).
 */
export default function QueryHelper({ top, initialDsl, currentPath, onInsert, onClose }: Props) {
  // When editing an existing block, try to recover the builder state from its DSL so we re-open the
  // visual builder pre-filled with the same selections. A query the builder can't represent
  // (parse → null) falls back to raw-DSL mode, the safe round-trip for hand-written queries.
  const parsed = initialDsl?.trim() ? parse(initialDsl) : null;

  const [mode, setMode] = useState<Mode>(initialDsl?.trim() ? (parsed ? "easy" : "dsl") : "easy");
  const [b, setB] = useState<BuilderState>(parsed ?? EMPTY_BUILDER);
  const [dsl, setDsl] = useState(initialDsl?.trim() || compile(EMPTY_BUILDER));
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sources = useQuerySources();

  const effectiveDsl = mode === "dsl" ? dsl : compile(b);

  const set = (patch: Partial<BuilderState>) => setB((prev) => ({ ...prev, ...patch }));
  const setFilter = (i: number, patch: Partial<Filter>) =>
    set({ filters: b.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  const isTask = b.kind === "TASK";

  // Changing the query kind: TASK filters/sorts on a different set of columns than TABLE/LIST, so
  // clear any fields that don't apply to the new kind (otherwise a leftover `file.name` filter from
  // a TABLE query produces an invalid TASK query — and hides the `ref` page filter the user wants).
  const setKind = (kind: string) => {
    const toTask = kind === "TASK";
    setB((prev) => {
      const validField = (f: string) => !f || (toTask ? TASK_FIELDS.includes(f) : true);
      const filters = prev.filters.map((f) => (validField(f.field) ? f : { ...f, field: "" }));
      // Reconcile each sort key against the new kind's columns; drop the ones that don't apply.
      const keptKeys = parseSort(prev.sort).filter((k) => validField(k.field) && k.field);
      // If nothing survives, fall back to the kind's natural default sort.
      const sort = keptKeys.length ? serializeSort(keptKeys) : toTask ? "due" : "file.name";
      return { ...prev, kind, filters, sort };
    });
  };

  // Field menu for Easy mode: the task columns for a TASK query, otherwise vault page fields — plus
  // whatever the user has already typed, so a custom field set in Builder mode survives a switch.
  const fieldGroups = useMemo<SelectGroup[]>(() => {
    const base = isTask ? TASK_FIELDS : sources.fields;
    const extra = b.filters.map((f) => f.field).filter((f) => f && !base.includes(f));
    const groups: SelectGroup[] = [
      { label: "Fields", options: base.map((f) => ({ value: f, label: f })) },
    ];
    if (extra.length)
      groups.push({ label: "Custom", options: [...new Set(extra)].map((f) => ({ value: f, label: f })) });
    return groups;
  }, [isTask, sources.fields, b.filters]);

  // Page menu for the TASK `ref` filter: "Current page" (the {{currentName}} sentinel, resolved to the
  // host page's leaf name at run time → a backlinks query) plus every vault page as a wikilink target.
  // The leaf name is the value (what the engine matches inside `[[ ]]`); when two pages share a name we
  // append the folder so the options stay distinguishable.
  const pageOptions = useMemo<SelectGroup[]>(() => {
    const counts = new Map<string, number>();
    for (const p of sources.pages) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    const groups: SelectGroup[] = [
      { label: "Special", options: [{ value: CURRENT_PAGE_NAME_TOKEN, label: "Current page" }] },
    ];
    if (sources.pages.length)
      groups.push({
        label: "Pages",
        options: sources.pages.map((p) => ({
          value: p.name,
          label: (counts.get(p.name) ?? 0) > 1 ? `${p.name} — ${p.path}` : p.name,
        })),
      });
    return groups;
  }, [sources.pages]);

  // Value menu for a `path` filter: "Current page" (the {{current}} sentinel, resolved at run time)
  // plus every page path, so a query can scope to the page it lives in without hand-typing a path.
  const pathOptions = useMemo<SelectGroup[]>(() => {
    const groups: SelectGroup[] = [
      { label: "Special", options: [{ value: CURRENT_PAGE_TOKEN, label: "Current page" }] },
    ];
    if (sources.pages.length)
      groups.push({
        label: "Pages",
        options: sources.pages.map((p) => ({ value: p.path, label: p.path })),
      });
    return groups;
  }, [sources.pages]);

  // Source menu for Easy mode: "Whole vault" (empty FROM), every folder, then every tag as `#tag`.
  const sourceGroups = useMemo<SelectGroup[]>(() => {
    const groups: SelectGroup[] = [
      { label: "Scope", options: [{ value: "", label: "Whole vault" }] },
    ];
    if (sources.folders.length)
      groups.push({ label: "Folders", options: sources.folders.map((f) => ({ value: f, label: f })) });
    if (sources.tags.length)
      groups.push({ label: "Tags", options: sources.tags.map((t) => ({ value: `#${t}`, label: `#${t}` })) });
    return groups;
  }, [sources.folders, sources.tags]);

  // Easy-mode sort is edited as discrete keys (one row each), held in local state so that blank rows
  // survive in the UI: `b.sort` is the serialized DSL fragment and `serializeSort` drops empty-field
  // rows, so a derived-from-`b.sort` list could never show more than one blank row (and "+ add sort"
  // would appear to do nothing). `b.sort` stays the source of truth for `compile`/`parse`; we mirror
  // each edit into it, and reconcile back the other way when `b.sort` changes underneath us (e.g. the
  // kind switch in `setKind`, which rewrites the sort).
  const [sortRows, setSortRows] = useState<SortKey[]>(() => {
    const keys = parseSort(b.sort);
    return keys.length ? keys : [{ field: "", dir: "ASC" }];
  });
  // Re-sync when `b.sort` is changed by something other than the row editors below (the serialized
  // form of the current rows won't match). Comparing serialized forms ignores the blank trailing rows.
  useEffect(() => {
    if (serializeSort(sortRows) === b.sort) return;
    const keys = parseSort(b.sort);
    setSortRows(keys.length ? keys : [{ field: "", dir: "ASC" }]);
  }, [b.sort]);

  const commitSortRows = (rows: SortKey[]) => {
    setSortRows(rows);
    set({ sort: serializeSort(rows) });
  };
  const updateSortKey = (i: number, patch: Partial<SortKey>) =>
    commitSortRows(sortRows.map((k, j) => (j === i ? { ...k, ...patch } : k)));
  const removeSortKey = (i: number) =>
    commitSortRows(sortRows.length > 1 ? sortRows.filter((_, j) => j !== i) : [{ field: "", dir: "ASC" }]);
  const addSortKey = () => commitSortRows([...sortRows, { field: "", dir: "ASC" }]);

  const runPreview = async () => {
    setError(null);
    try {
      // Resolve `{{current}}` so the preview reflects what the saved block will run on this page.
      setPreview(await api.runQuery(resolveCurrentPage(effectiveDsl, currentPath)));
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/i, ""));
      setPreview(null);
    }
  };

  // Close on outside click / Escape, mirroring the editor's other popups. We close only when BOTH
  // the press (mousedown) and release (click) land outside the helper. That:
  //   - lets a Select option commit (it fires on mousedown, inside the helper) without the trailing
  //     click closing the whole popup, and
  //   - ignores the very click that opened this popup (e.g. the block's pencil button), whose
  //     mousedown happened before this listener was attached — so it never self-closes on open.
  useEffect(() => {
    let downOutside = false;
    const onDown = (e: MouseEvent) => {
      downOutside = !rootRef.current?.contains(e.target as Node);
    };
    const onClick = (e: MouseEvent) => {
      if (downOutside && !rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div className="query-helper" ref={rootRef} style={{ top }}>
      <div className="query-helper-head">
        <span className="query-helper-title">Insert query</span>
        <div className="seg">
          <button className={mode === "easy" ? "active" : ""} onClick={() => setMode("easy")}>
            Easy
          </button>
          <button className={mode === "builder" ? "active" : ""} onClick={() => setMode("builder")}>
            Builder
          </button>
          <button className={mode === "dsl" ? "active" : ""} onClick={() => setMode("dsl")}>
            DSL
          </button>
        </div>
      </div>

      {mode === "dsl" ? (
        <textarea className="dsl-input" value={dsl} onChange={(e) => setDsl(e.target.value)} rows={4} />
      ) : (
        <div className="builder">
          <div className="row">
            <label>Show</label>
            <Select value={b.kind} options={KIND_OPTIONS} onChange={setKind} ariaLabel="Query kind" />
            {b.kind === "TABLE" && (
              <input
                value={b.cols}
                onChange={(e) => set({ cols: e.target.value })}
                placeholder="columns, comma-separated"
              />
            )}
          </div>

          <div className="row">
            <label>From</label>
            {mode === "easy" ? (
              <Select
                value={b.from}
                groups={sourceGroups}
                onChange={(from) => set({ from })}
                placeholder={sources.loading ? "Loading…" : "Whole vault"}
                ariaLabel="Query source"
              />
            ) : (
              <input value={b.from} onChange={(e) => set({ from: e.target.value })} placeholder="folder or #tag (optional)" />
            )}
          </div>

          <div className="filters">
            <label>Where</label>
            {b.filters.map((f, i) => (
              <div key={i} className="row filter-row">
                {mode === "easy" ? (
                  <Select
                    value={f.field}
                    groups={fieldGroups}
                    onChange={(field) => setFilter(i, { field })}
                    placeholder="field"
                    ariaLabel="Filter field"
                  />
                ) : (
                  <input placeholder="field" value={f.field} onChange={(e) => setFilter(i, { field: e.target.value })} />
                )}
                <Select
                  value={f.op}
                  options={OP_OPTIONS}
                  onChange={(op) => setFilter(i, { op })}
                  ariaLabel="Operator"
                  className="select-op"
                />
                {mode === "easy" && f.field === "ref" ? (
                  <Select
                    value={f.value}
                    groups={pageOptions}
                    onChange={(value) => setFilter(i, { value })}
                    placeholder={sources.loading ? "Loading…" : "page…"}
                    ariaLabel="Linked page"
                  />
                ) : mode === "easy" && (f.field === "path" || f.field === "file.path") ? (
                  <Select
                    value={f.value}
                    groups={pathOptions}
                    onChange={(value) => setFilter(i, { value })}
                    placeholder={sources.loading ? "Loading…" : "path…"}
                    ariaLabel="Page path"
                  />
                ) : (
                  <input placeholder="value" value={f.value} onChange={(e) => setFilter(i, { value: e.target.value })} />
                )}
                <button title="Remove filter" onClick={() => set({ filters: b.filters.filter((_, j) => j !== i) })}>
                  <X size={14} weight="bold" />
                </button>
              </div>
            ))}
            <button
              className="add-filter"
              onClick={() => set({ filters: [...b.filters, { field: "", op: "=", value: "" }] })}
            >
              + add filter
            </button>
          </div>

          {mode === "easy" ? (
            // One row per sort key, applied in order (the first is primary, the rest break ties).
            <div className="filters">
              <label>Sort</label>
              {sortRows.map((k, i) => (
                <div key={i} className="row filter-row">
                  <Select
                    value={k.field}
                    groups={fieldGroups}
                    onChange={(field) => updateSortKey(i, { field })}
                    placeholder={i === 0 ? "none" : "then by…"}
                    ariaLabel={i === 0 ? "Sort field" : "Then sort field"}
                  />
                  <Select
                    value={k.dir}
                    options={[
                      { value: "ASC", label: "Asc" },
                      { value: "DESC", label: "Desc" },
                    ]}
                    onChange={(dir) => updateSortKey(i, { dir: dir as "ASC" | "DESC" })}
                    ariaLabel="Sort direction"
                    className="select-op"
                  />
                  <button
                    title="Remove sort"
                    // removeSortKey keeps at least one (blank) row so the control is always present.
                    onClick={() => removeSortKey(i)}
                  >
                    <X size={14} weight="bold" />
                  </button>
                </div>
              ))}
              <button
                className="add-filter"
                // Only allow a tie-breaker once the prior key has a field chosen.
                disabled={!sortRows[sortRows.length - 1]?.field}
                onClick={addSortKey}
              >
                + add sort
              </button>
            </div>
          ) : (
            <div className="row">
              <label>Sort</label>
              <input value={b.sort} onChange={(e) => set({ sort: e.target.value })} placeholder="field [ASC|DESC], …" />
            </div>
          )}
        </div>
      )}

      <div className="row">
        <code className="dsl-preview">{effectiveDsl.replace(/\n/g, " ")}</code>
      </div>

      {error && <pre className="error">{error}</pre>}
      {preview && (
        <div className="result query-helper-preview">
          <QueryResultView result={preview} />
        </div>
      )}

      <div className="query-helper-actions">
        <button onClick={runPreview}>Preview</button>
        <button className="primary" onClick={() => onInsert(effectiveDsl.replace(/\n/g, " ").trim())}>
          Insert
        </button>
      </div>
    </div>
  );
}
