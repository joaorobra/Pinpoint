import { useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { api } from "../api";
import type { QueryResult } from "../types";
import { OPS, KINDS, compile, EMPTY_BUILDER, type BuilderState, type Filter } from "../querydsl";
import Select, { type SelectOption } from "./Select";
import QueryResultView from "./QueryResultView";

const OP_OPTIONS: SelectOption[] = OPS.map((o) => ({ value: o, label: o }));
const KIND_OPTIONS: SelectOption[] = KINDS.map((k) => ({ value: k, label: k }));

interface Props {
  /** Editor-wrap-relative vertical anchor; the popup is pinned to the right edge horizontally. */
  top: number;
  /** DSL to pre-populate (when editing an existing block); empty for a fresh insert. */
  initialDsl?: string;
  /** Commit the composed DSL into the document. */
  onInsert: (dsl: string) => void;
  onClose: () => void;
}

/**
 * Inline query-helper popup: a compact visual builder (with a raw-DSL escape hatch and a live
 * preview) for composing a Dataview-like query and dropping it into the editor as an inline query
 * block. Shares its builder state + compile path with the standalone Query panel via querydsl.ts.
 */
export default function QueryHelper({ top, initialDsl, onInsert, onClose }: Props) {
  const [mode, setMode] = useState<"builder" | "dsl">("builder");
  const [b, setB] = useState<BuilderState>(EMPTY_BUILDER);
  const [dsl, setDsl] = useState(initialDsl?.trim() || compile(EMPTY_BUILDER));
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // When opened on an existing block, start in raw-DSL mode showing that query (the GUI builder
  // can't always represent a hand-written query, so DSL is the safe round-trip).
  useEffect(() => {
    if (initialDsl?.trim()) setMode("dsl");
  }, [initialDsl]);

  const effectiveDsl = mode === "builder" ? compile(b) : dsl;

  const set = (patch: Partial<BuilderState>) => setB((prev) => ({ ...prev, ...patch }));
  const setFilter = (i: number, patch: Partial<Filter>) =>
    set({ filters: b.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  const runPreview = async () => {
    setError(null);
    try {
      setPreview(await api.runQuery(effectiveDsl));
    } catch (e) {
      setError(String(e));
      setPreview(null);
    }
  };

  // Close on outside click / Escape, mirroring the editor's other popups.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div className="query-helper" ref={rootRef} style={{ top }}>
      <div className="query-helper-head">
        <span className="query-helper-title">Insert query</span>
        <div className="seg">
          <button className={mode === "builder" ? "active" : ""} onClick={() => setMode("builder")}>
            Builder
          </button>
          <button className={mode === "dsl" ? "active" : ""} onClick={() => setMode("dsl")}>
            DSL
          </button>
        </div>
      </div>

      {mode === "builder" ? (
        <div className="builder">
          <div className="row">
            <label>Show</label>
            <Select value={b.kind} options={KIND_OPTIONS} onChange={(kind) => set({ kind })} ariaLabel="Query kind" />
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
            <input value={b.from} onChange={(e) => set({ from: e.target.value })} placeholder="folder or #tag (optional)" />
          </div>
          <div className="filters">
            <label>Where</label>
            {b.filters.map((f, i) => (
              <div key={i} className="row filter-row">
                <input placeholder="field" value={f.field} onChange={(e) => setFilter(i, { field: e.target.value })} />
                <Select
                  value={f.op}
                  options={OP_OPTIONS}
                  onChange={(op) => setFilter(i, { op })}
                  ariaLabel="Operator"
                  className="select-op"
                />
                <input placeholder="value" value={f.value} onChange={(e) => setFilter(i, { value: e.target.value })} />
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
          <div className="row">
            <label>Sort</label>
            <input value={b.sort} onChange={(e) => set({ sort: e.target.value })} placeholder="field [ASC|DESC]" />
          </div>
        </div>
      ) : (
        <textarea className="dsl-input" value={dsl} onChange={(e) => setDsl(e.target.value)} rows={4} />
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
