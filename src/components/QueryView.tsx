import { useState } from "react";
import { api } from "../api";
import type { QueryResult } from "../types";

// Visual builder state compiles to the same DSL the engine runs, so power users and the GUI share
// one execution path.
interface Filter {
  field: string;
  op: string;
  value: string;
}

const OPS = ["=", "!=", ">", "<", ">=", "<=", "contains"];

function compile(kind: string, cols: string, from: string, filters: Filter[], sort: string): string {
  let dsl = kind === "TABLE" ? `TABLE ${cols || "file.name"}` : kind;
  if (from.trim()) dsl += ` FROM ${from.trim().startsWith("#") ? from.trim() : `"${from.trim()}"`}`;
  const valid = filters.filter((f) => f.field && f.value);
  if (valid.length)
    dsl +=
      " WHERE " +
      valid
        .map((f) => `${f.field} ${f.op} ${/^\d+$|^(true|false)$/.test(f.value) ? f.value : `"${f.value}"`}`)
        .join(" AND ");
  if (sort.trim()) dsl += ` SORT ${sort.trim()}`;
  return dsl;
}

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

  const effectiveDsl = mode === "builder" ? compile(kind, cols, from, filters, sort) : dsl;

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
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option>TABLE</option>
              <option>LIST</option>
              <option>TASK</option>
            </select>
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
                <select
                  value={f.op}
                  onChange={(e) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}
                >
                  {OPS.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
                <input
                  placeholder="value"
                  value={f.value}
                  onChange={(e) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
                <button onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}>✕</button>
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
          {result.kind === "list" ? (
            <ul>
              {result.rows.map((r, i) => (
                <li key={i}>{String(r["file.name"])}</li>
              ))}
            </ul>
          ) : (
            <table>
              <thead>
                <tr>
                  {result.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr key={i}>
                    {result.columns.map((c) => (
                      <td key={c}>{String(r[c] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted">{result.rows.length} result(s)</p>
        </div>
      )}
    </div>
  );
}
