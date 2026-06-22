import { useState } from "react";
import { X } from "@phosphor-icons/react";
import { api } from "../api";
import type { QueryResult } from "../types";
import { OPS, KINDS, compile, type Filter } from "../querydsl";
import Select, { type SelectOption } from "./Select";
import QueryResultView from "./QueryResultView";

const OP_OPTIONS: SelectOption[] = OPS.map((o) => ({ value: o, label: o }));
const KIND_OPTIONS: SelectOption[] = KINDS.map((k) => ({ value: k, label: k }));

export default function QueryView() {
  const [mode, setMode] = useState<"builder" | "dsl">("builder");
  const [kind, setKind] = useState("TABLE");
  const [cols, setCols] = useState("file.name, status");
  const [from, setFrom] = useState("");
  const [sort, setSort] = useState("file.name");
  const [filters, setFilters] = useState<Filter[]>([{ field: "", op: "=", value: "" }]);
  const [dsl, setDsl] = useState('TABLE file.name, status\nWHERE status = "active"');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveDsl = mode === "builder" ? compile({ kind, cols, from, filters, sort }) : dsl;

  const run = async () => {
    setError(null);
    try {
      setResult(await api.runQuery(effectiveDsl));
    } catch (e) {
      setError(String(e));
      setResult(null);
    }
  };

  return (
    <div className="panel query-view">
      <div className="panel-header">
        <h2>Query</h2>
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
            <Select value={kind} options={KIND_OPTIONS} onChange={setKind} ariaLabel="Query kind" />

            {kind === "TABLE" && (
              <input value={cols} onChange={(e) => setCols(e.target.value)} placeholder="columns, comma-separated" />
            )}
          </div>
          <div className="row">
            <label>From</label>
            <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder='folder or #tag (optional)' />
          </div>
          <div className="filters">
            <label>Where</label>
            {filters.map((f, i) => (
              <div key={i} className="row filter-row">
                <input
                  placeholder="field"
                  value={f.field}
                  onChange={(e) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}
                />
                <Select
                  value={f.op}
                  options={OP_OPTIONS}
                  onChange={(v) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, op: v } : x)))}
                  ariaLabel="Operator"
                  className="select-op"
                />
                <input
                  placeholder="value"
                  value={f.value}
                  onChange={(e) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
                <button title="Remove filter" onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}>
                  <X size={14} weight="bold" />
                </button>
              </div>
            ))}
            <button className="add-filter" onClick={() => setFilters((fs) => [...fs, { field: "", op: "=", value: "" }])}>
              + add filter
            </button>
          </div>
          <div className="row">
            <label>Sort</label>
            <input value={sort} onChange={(e) => setSort(e.target.value)} placeholder="field [ASC|DESC]" />
          </div>
        </div>
      ) : (
        <textarea className="dsl-input" value={dsl} onChange={(e) => setDsl(e.target.value)} rows={5} />
      )}

      <div className="row">
        <code className="dsl-preview">{effectiveDsl.replace(/\n/g, " ")}</code>
        <button className="primary" onClick={run}>
          Run
        </button>
      </div>

      {error && <pre className="error">{error}</pre>}

      {result && (
        <div className="result">
          <QueryResultView
            result={result}
            // Toggle a task's done state on disk, then re-run so the result reflects it.
            onToggle={(t) =>
              api
                .toggleTask(t.rel_path, t.line, t.occurrence ?? null)
                .then(run)
                .catch((e) => setError(String(e)))
            }
          />
        </div>
      )}
    </div>
  );
}
