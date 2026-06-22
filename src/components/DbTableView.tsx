// Table view: the spreadsheet-style grid. Adds resizable columns (drag the right edge), custom
// per-column icons, per-view column visibility, and the in-header type/option/icon config menu.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, CaretDown, Trash, PencilSimple, Smiley, Check } from "@phosphor-icons/react";
import type { DbAggregation, DbColumn, DbColumnType, DbOption, DbView } from "../types";
import { DB_OPTION_COLORS } from "../types";
import type { DbRow } from "../dblogic";
import { AGG_LABELS, aggsForType, computeAggregation } from "../dblogic";
import { NodeIconView } from "./Icon";
import { TYPE_META, typeIcon, makeId, DbCell, formatCurrency } from "./DbShared";

interface Props {
  columns: DbColumn[];      // already filtered to visible + ordered for this view
  rows: DbRow[];            // already filtered + sorted
  view: DbView;             // active view (for per-column footer aggregations)
  dateFormat: string;
  onUpdateView: (patch: Partial<DbView>) => void;
  onSetCell: (rowPath: string, colId: string, value: unknown) => void;
  onRenameRow: (row: DbRow, title: string) => void;
  onOpenRow: (relPath: string) => void;
  onDeleteRow: (row: DbRow) => void;
  onAddRow: () => void;
  onUpdateColumn: (id: string, patch: Partial<DbColumn>) => void;
  onChangeColumnType: (id: string, type: DbColumnType) => void;
  onDeleteColumn: (id: string) => void;
  onMoveColumn: (id: string, delta: number) => void;
  onAddColumn: (type: DbColumnType) => void;
  onPickColumnIcon: (col: DbColumn) => void;
}

const DEFAULT_W = 180;

export default function DbTableView({
  columns, rows, view, dateFormat, onUpdateView,
  onSetCell, onRenameRow, onOpenRow, onDeleteRow, onAddRow,
  onUpdateColumn, onChangeColumnType, onDeleteColumn, onMoveColumn, onAddColumn, onPickColumnIcon,
}: Props) {
  const [menu, setMenu] = useState<string | null>(null);
  // While a column is being dragged we disable the width transition so it tracks the cursor 1:1;
  // on release the transition re-enables and the committed width animates smoothly into place.
  const [resizing, setResizing] = useState(false);

  const aggregations = view.aggregations ?? {};
  const setAgg = (colId: string, agg: DbAggregation) => {
    const next = { ...aggregations };
    if (agg === "none") delete next[colId];
    else next[colId] = agg;
    onUpdateView({ aggregations: next });
  };
  const hasFooter = columns.some((c) => (aggregations[c.id] ?? "none") !== "none");

  return (
    <div className="db-table-wrap">
      <table className={`db-table${resizing ? " resizing" : ""}`}>
        <colgroup>
          {columns.map((c) => (
            <col key={c.id} style={{ width: (c.width ?? DEFAULT_W) + "px" }} />
          ))}
          <col style={{ width: "44px" }} />
        </colgroup>
        <thead>
          <tr>
            {columns.map((col) => (
              <HeaderCell
                key={col.id}
                col={col}
                isTitle={col.type === "title"}
                menuOpen={menu === col.id}
                onToggleMenu={() => setMenu((m) => (m === col.id ? null : col.id))}
                onCloseMenu={() => setMenu(null)}
                onResize={(w) => onUpdateColumn(col.id, { width: w })}
                onResizeStart={() => setResizing(true)}
                onResizeEnd={() => setResizing(false)}
                onRename={(name) => onUpdateColumn(col.id, { name })}
                onChangeType={(t) => onChangeColumnType(col.id, t)}
                onDelete={() => onDeleteColumn(col.id)}
                onMove={(d) => onMoveColumn(col.id, d)}
                onEditOptions={(options) => onUpdateColumn(col.id, { options })}
                onSetCurrency={(currency) => onUpdateColumn(col.id, { currency })}
                onPickIcon={() => onPickColumnIcon(col)}
                onClearIcon={() => onUpdateColumn(col.id, { icon: undefined })}
              />
            ))}
            <th className="db-add-col">
              <AddColumnButton onAdd={onAddColumn} />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.rel_path} className="db-row">
              {columns.map((col) => (
                <td key={col.id} className={`db-cell db-cell-${col.type}`}>
                  {col.type === "title" ? (
                    <div className="db-title-cell">
                      <DbCell col={col} row={row} dateFormat={dateFormat}
                        onChange={(v) => onSetCell(row.rel_path, col.id, v)}
                        onRenameTitle={(v) => onRenameRow(row, v)} />
                      <div className="db-row-actions">
                        <button title="Open page" onClick={() => onOpenRow(row.rel_path)}><PencilSimple size={13} /></button>
                        <button title="Delete row" className="danger" onClick={() => onDeleteRow(row)}><Trash size={13} /></button>
                      </div>
                    </div>
                  ) : (
                    <DbCell col={col} row={row} dateFormat={dateFormat}
                      onChange={(v) => onSetCell(row.rel_path, col.id, v)}
                      onRenameTitle={(v) => onRenameRow(row, v)} />
                  )}
                </td>
              ))}
              <td className="db-cell db-cell-spacer" />
            </tr>
          ))}
          <tr className="db-add-row" onClick={onAddRow}>
            <td colSpan={columns.length + 1}><Plus size={14} weight="bold" /> New row</td>
          </tr>
        </tbody>
        <tfoot className={`db-tfoot${hasFooter ? " has-agg" : ""}`}>
          <tr>
            {columns.map((col) => (
              <FooterCell
                key={col.id}
                col={col}
                rows={rows}
                agg={aggregations[col.id] ?? "none"}
                onSetAgg={(a) => setAgg(col.id, a)}
              />
            ))}
            <td className="db-foot-cell db-foot-spacer" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/* ---- Footer aggregation cell --------------------------------------------------------------- */
function FooterCell({
  col, rows, agg, onSetAgg,
}: {
  col: DbColumn;
  rows: DbRow[];
  agg: DbAggregation;
  onSetAgg: (a: DbAggregation) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLTableCellElement>(null);
  const options = useMemo(() => aggsForType(col.type), [col.type]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const id = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(id); document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  const result = useMemo(() => computeAggregation(agg, rows, col), [agg, rows, col]);
  // Currency columns get their symbol on numeric results (sum/avg/min/max).
  const display = (() => {
    if (!result) return null;
    const isMoney = col.type === "currency" && ["sum", "avg", "min", "max"].includes(agg);
    const num = result.numeric;
    return isMoney && num != null ? formatCurrency(num, col.currency ?? "USD") : result.value;
  })();

  return (
    <td ref={ref} className={`db-foot-cell${agg !== "none" ? " active" : ""}${open ? " menu-open" : ""}`}>
      <button className="db-foot-btn" onClick={() => setOpen((o) => !o)} title="Summarize column">
        {agg === "none" ? (
          <span className="db-foot-placeholder">Calculate <CaretDown size={10} weight="bold" /></span>
        ) : (
          <span className="db-foot-result">
            <span className="db-foot-label">{AGG_LABELS[agg]}</span>
            <span className="db-foot-value">{display ?? "—"}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="db-foot-menu">
          {options.map((a) => (
            <button
              key={a}
              className={`db-foot-opt${a === agg ? " selected" : ""}`}
              onClick={() => { onSetAgg(a); setOpen(false); }}
            >
              <span>{AGG_LABELS[a]}</span>
              {a === agg && <Check size={13} weight="bold" />}
            </button>
          ))}
        </div>
      )}
    </td>
  );
}

function HeaderCell({
  col, isTitle, menuOpen, onToggleMenu, onCloseMenu, onResize, onResizeStart, onResizeEnd,
  onRename, onChangeType, onDelete, onMove, onEditOptions, onSetCurrency, onPickIcon, onClearIcon,
}: {
  col: DbColumn;
  isTitle: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onResize: (w: number) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
  onRename: (name: string) => void;
  onChangeType: (t: DbColumnType) => void;
  onDelete: () => void;
  onMove: (delta: number) => void;
  onEditOptions: (options: DbOption[]) => void;
  onSetCurrency: (currency: string) => void;
  onPickIcon: () => void;
  onClearIcon: () => void;
}) {
  const FallbackIco = typeIcon(col.type);
  const ref = useRef<HTMLTableCellElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onCloseMenu(); };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseMenu();
    const id = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(id); document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [menuOpen, onCloseMenu]);

  // Drag-to-resize the right edge. While dragging we set the width on the matching <col> through
  // the parent (resizing=true) so the transition is suppressed and the column tracks the cursor
  // 1:1; on release we commit and let the width animate to its final position via CSS transition.
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const th = ref.current;
    if (!th) return;
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    let lastW = startW;
    let raf = 0;
    const apply = (clientX: number) => {
      lastW = Math.max(80, Math.round(startW + (clientX - startX)));
      th.style.width = lastW + "px";
    };
    const onMove = (ev: MouseEvent) => {
      // Throttle layout writes to one per animation frame for a smoother drag.
      if (raf) return;
      raf = window.requestAnimationFrame(() => { raf = 0; apply(ev.clientX); });
    };
    const onUp = () => {
      if (raf) window.cancelAnimationFrame(raf);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("db-resizing");
      onResizeEnd();
      th.style.width = "";        // hand width control back to the <colgroup>
      onResize(lastW);
    };
    onResizeStart();
    document.body.classList.add("db-resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [onResize, onResizeStart, onResizeEnd]);

  return (
    <th ref={ref} className={`db-th${menuOpen ? " menu-open" : ""}`}>
      <button className="db-th-btn" onClick={onToggleMenu} title={col.name}>
        {col.icon ? (
          <NodeIconView icon={col.icon} fallback={FallbackIco} size={14} className="db-th-icon" />
        ) : (
          <FallbackIco size={14} className="db-th-icon" />
        )}
        <span className="db-th-name">{col.name}</span>
        {!isTitle && <CaretDown size={11} className="db-th-caret" />}
      </button>
      <span className="db-col-resize" onMouseDown={startResize} title="Drag to resize" />

      {menuOpen && (
        <div className="db-col-menu">
          <input
            className="db-col-name-input"
            defaultValue={col.name}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") { onRename((e.target as HTMLInputElement).value.trim() || col.name); onCloseMenu(); } }}
            onBlur={(e) => onRename(e.target.value.trim() || col.name)}
          />

          <div className="db-col-menu-actions">
            <button onClick={() => { onPickIcon(); onCloseMenu(); }}><Smiley size={13} /> Icon</button>
            {col.icon && <button onClick={onClearIcon}>Clear icon</button>}
          </div>

          {!isTitle && (
            <>
              <div className="db-col-menu-section">Type</div>
              <div className="db-type-grid">
                {TYPE_META.map((t) => {
                  const TIco = t.icon;
                  return (
                    <button key={t.type} className={`db-type-opt${col.type === t.type ? " active" : ""}`} onClick={() => onChangeType(t.type)}>
                      <TIco size={14} /> {t.label}
                    </button>
                  );
                })}
              </div>

              {col.type === "currency" && (
                <div className="db-col-menu-row">
                  <span>Currency</span>
                  <input className="db-currency-input" defaultValue={col.currency ?? "USD"} maxLength={3}
                    onBlur={(e) => onSetCurrency(e.target.value.toUpperCase().trim() || "USD")} />
                </div>
              )}

              {(col.type === "select" || col.type === "multiselect") && (
                <OptionEditor options={col.options ?? []} onChange={onEditOptions} />
              )}

              <div className="db-col-menu-actions">
                <button onClick={() => onMove(-1)}>Move left</button>
                <button onClick={() => onMove(1)}>Move right</button>
                <button className="danger" onClick={() => { onDelete(); onCloseMenu(); }}><Trash size={13} /> Delete</button>
              </div>
            </>
          )}
        </div>
      )}
    </th>
  );
}

function OptionEditor({ options, onChange }: { options: DbOption[]; onChange: (o: DbOption[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const label = draft.trim();
    if (!label) return;
    const color = DB_OPTION_COLORS[options.length % DB_OPTION_COLORS.length];
    onChange([...options, { id: makeId("opt"), label, color }]);
    setDraft("");
  };
  return (
    <div className="db-opt-editor">
      <div className="db-col-menu-section">Options</div>
      {options.map((o) => (
        <div key={o.id} className="db-opt-row">
          <input type="color" className="db-opt-color" value={o.color || "#7c5cff"}
            onChange={(e) => onChange(options.map((x) => (x.id === o.id ? { ...x, color: e.target.value } : x)))} />
          <input className="db-opt-label" defaultValue={o.label}
            onBlur={(e) => onChange(options.map((x) => (x.id === o.id ? { ...x, label: e.target.value.trim() || x.label } : x)))} />
          <button className="db-opt-del" title="Remove" onClick={() => onChange(options.filter((x) => x.id !== o.id))}>✕</button>
        </div>
      ))}
      <div className="db-opt-add">
        <input className="db-opt-label" placeholder="Add option…" value={draft}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="db-opt-add-btn" onClick={add}><Plus size={12} weight="bold" /></button>
      </div>
    </div>
  );
}

function AddColumnButton({ onAdd }: { onAdd: (t: DbColumnType) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const id = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => { window.clearTimeout(id); document.removeEventListener("mousedown", onDown); };
  }, [open]);
  return (
    <div className="db-add-col-wrap" ref={ref}>
      <button className="db-add-col-btn" title="Add property" onClick={() => setOpen((o) => !o)}><Plus size={14} weight="bold" /></button>
      {open && (
        <div className="db-col-menu db-add-col-menu">
          <div className="db-col-menu-section">New property</div>
          <div className="db-type-grid">
            {TYPE_META.map((t) => {
              const TIco = t.icon;
              return (
                <button key={t.type} className="db-type-opt" onClick={() => { onAdd(t.type); setOpen(false); }}>
                  <TIco size={14} /> {t.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
