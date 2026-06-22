// The toolbar above a database view: Filter, Sort, Group/Date/Cover (view-type specific), and a
// Properties popover for per-view column visibility. Each control edits the active view's config,
// which the shell persists to the schema.

import { useState } from "react";
import { Funnel, SortAscending, SlidersHorizontal, Plus, Trash, Eye, EyeSlash } from "@phosphor-icons/react";
import type { DbColumn, DbFilter, DbSort, DbView, DbViewProperty } from "../types";
import { OP_LABELS, opNeedsValue, opsForType } from "../dblogic";
import { useDismiss, makeId, MiniCalendar } from "./DbShared";
import Select from "./Select";

interface Props {
  view: DbView;
  columns: DbColumn[];
  onUpdateView: (patch: Partial<DbView>) => void;
}

export default function DbToolbar({ view, columns, onUpdateView }: Props) {
  const [open, setOpen] = useState<null | "filter" | "sort" | "props" | "layout">(null);
  const close = () => setOpen(null);

  const filterCount = view.filters.length;
  const sortCount = view.sorts.length;

  return (
    <div className="db-toolbar">
      <ToolbarButton active={!!filterCount} onClick={() => setOpen(open === "filter" ? null : "filter")}>
        <Funnel size={14} /> Filter{filterCount ? ` · ${filterCount}` : ""}
      </ToolbarButton>
      <ToolbarButton active={!!sortCount} onClick={() => setOpen(open === "sort" ? null : "sort")}>
        <SortAscending size={14} /> Sort{sortCount ? ` · ${sortCount}` : ""}
      </ToolbarButton>
      {view.type !== "table" && (
        <ToolbarButton onClick={() => setOpen(open === "layout" ? null : "layout")}>
          <SlidersHorizontal size={14} /> Layout
        </ToolbarButton>
      )}
      <ToolbarButton onClick={() => setOpen(open === "props" ? null : "props")}>
        <Eye size={14} /> Properties
      </ToolbarButton>

      {open === "filter" && <FilterPopover view={view} columns={columns} onUpdateView={onUpdateView} onClose={close} />}
      {open === "sort" && <SortPopover view={view} columns={columns} onUpdateView={onUpdateView} onClose={close} />}
      {open === "props" && <PropsPopover view={view} columns={columns} onUpdateView={onUpdateView} onClose={close} />}
      {open === "layout" && <LayoutPopover view={view} columns={columns} onUpdateView={onUpdateView} onClose={close} />}
    </div>
  );
}

function ToolbarButton({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`db-tool-btn${active ? " active" : ""}`} onClick={onClick}>{children}</button>;
}

/* ---- Filters ------------------------------------------------------------------------------- */
function FilterPopover({ view, columns, onUpdateView, onClose }: Props & { onClose: () => void }) {
  const ref = useDismiss(true, onClose, ".db-toolbar");
  const set = (filters: DbFilter[]) => onUpdateView({ filters });
  const filterable = columns; // any column can be filtered

  const add = () => {
    const col = filterable[0];
    if (!col) return;
    set([...view.filters, { id: makeId("flt"), columnId: col.id, op: opsForType(col.type)[0] }]);
  };

  return (
    <div className="db-popover db-filter-pop" ref={ref}>
      <div className="db-popover-head">
        <span>Filters</span>
        {view.filters.length > 1 && (
          <Select
            className="db-match-select"
            value={view.filterMatch ?? "all"}
            options={[{ value: "all", label: "Match all" }, { value: "any", label: "Match any" }]}
            onChange={(v) => onUpdateView({ filterMatch: v as "all" | "any" })}
          />
        )}
      </div>
      {view.filters.length === 0 && <div className="db-popover-empty">No filters yet.</div>}
      {view.filters.map((f) => {
        const col = columns.find((c) => c.id === f.columnId);
        const ops = col ? opsForType(col.type) : [];
        return (
          <div key={f.id} className="db-filter-row">
            <Select
              className="db-filter-col"
              value={f.columnId}
              options={filterable.map((c) => ({ value: c.id, label: c.name }))}
              onChange={(v) => {
                const nc = columns.find((c) => c.id === v);
                set(view.filters.map((x) => (x.id === f.id ? { ...x, columnId: v, op: nc ? opsForType(nc.type)[0] : x.op, value: undefined } : x)));
              }}
            />
            <Select
              className="db-filter-op"
              value={f.op}
              options={ops.map((o) => ({ value: o, label: OP_LABELS[o] }))}
              onChange={(v) => set(view.filters.map((x) => (x.id === f.id ? { ...x, op: v as DbFilter["op"] } : x)))}
            />
            {col && opNeedsValue(f.op) && (
              <FilterValueInput
                col={col}
                value={f.value}
                onChange={(val) => set(view.filters.map((x) => (x.id === f.id ? { ...x, value: val } : x)))}
              />
            )}
            <button className="db-filter-del" onClick={() => set(view.filters.filter((x) => x.id !== f.id))}><Trash size={13} /></button>
          </div>
        );
      })}
      <button className="db-popover-add" onClick={add}><Plus size={13} /> Add filter</button>
    </div>
  );
}

function FilterValueInput({ col, value, onChange }: { col: DbColumn; value: unknown; onChange: (v: unknown) => void }) {
  if (col.type === "select" || col.type === "multiselect") {
    return (
      <Select
        className="db-filter-val"
        value={typeof value === "string" ? value : ""}
        placeholder="Value"
        options={(col.options ?? []).map((o) => ({ value: o.id, label: o.label }))}
        onChange={onChange}
      />
    );
  }
  if (col.type === "date" || col.type === "datetime" || col.type === "daterange") {
    return <DatePickerInline value={typeof value === "string" ? value : ""} onChange={onChange} />;
  }
  return (
    <input
      className="db-filter-val-input"
      defaultValue={value == null ? "" : String(value)}
      inputMode={col.type === "number" || col.type === "currency" ? "decimal" : "text"}
      placeholder="Value"
      onBlur={(e) => onChange(col.type === "number" || col.type === "currency" ? Number(e.target.value) || 0 : e.target.value)}
    />
  );
}

function DatePickerInline({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="db-date-cell db-filter-val" ref={ref}>
      <button className="db-filter-val-input" onClick={() => setOpen((o) => !o)}>{value || "Pick date"}</button>
      {open && (
        <div className="db-date-pop">
          <MiniCalendar value={value} onPick={(iso) => { onChange(iso); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

/* ---- Sorts --------------------------------------------------------------------------------- */
function SortPopover({ view, columns, onUpdateView, onClose }: Props & { onClose: () => void }) {
  const ref = useDismiss(true, onClose, ".db-toolbar");
  const set = (sorts: DbSort[]) => onUpdateView({ sorts });
  const used = new Set(view.sorts.map((s) => s.columnId));
  const available = columns.filter((c) => !used.has(c.id));

  return (
    <div className="db-popover db-sort-pop" ref={ref}>
      <div className="db-popover-head"><span>Sort</span></div>
      {view.sorts.length === 0 && <div className="db-popover-empty">No sorts yet.</div>}
      {view.sorts.map((s, i) => (
        <div key={s.columnId + i} className="db-sort-row">
          <Select
            className="db-sort-col"
            value={s.columnId}
            options={columns.map((c) => ({ value: c.id, label: c.name }))}
            onChange={(v) => set(view.sorts.map((x, j) => (j === i ? { ...x, columnId: v } : x)))}
          />
          <Select
            className="db-sort-dir"
            value={s.dir}
            options={[{ value: "asc", label: "Ascending" }, { value: "desc", label: "Descending" }]}
            onChange={(v) => set(view.sorts.map((x, j) => (j === i ? { ...x, dir: v as "asc" | "desc" } : x)))}
          />
          <button className="db-filter-del" onClick={() => set(view.sorts.filter((_, j) => j !== i))}><Trash size={13} /></button>
        </div>
      ))}
      {available.length > 0 && (
        <button className="db-popover-add" onClick={() => set([...view.sorts, { columnId: available[0].id, dir: "asc" }])}>
          <Plus size={13} /> Add sort
        </button>
      )}
    </div>
  );
}

/* ---- Properties (per-view visibility) ------------------------------------------------------ */
function PropsPopover({ view, columns, onUpdateView, onClose }: Props & { onClose: () => void }) {
  const ref = useDismiss(true, onClose, ".db-toolbar");
  const propMap = new Map((view.properties ?? []).map((p) => [p.columnId, p]));
  const isHidden = (id: string) => propMap.get(id)?.hidden === true;

  const toggle = (id: string) => {
    const next: DbViewProperty[] = columns.map((c) => {
      const existing = propMap.get(c.id);
      const hidden = c.id === id ? !isHidden(c.id) : existing?.hidden ?? false;
      return { columnId: c.id, hidden };
    });
    onUpdateView({ properties: next });
  };

  const showPageIcon = view.showPageIcon !== false;

  return (
    <div className="db-popover db-props-pop" ref={ref}>
      <div className="db-popover-head"><span>Properties</span></div>
      {(view.type === "table" || view.type === "gallery") && (
        <button
          className="db-prop-row db-prop-toggle"
          onClick={() => onUpdateView({ showPageIcon: !showPageIcon })}
        >
          <span>Show page icon</span>
          {showPageIcon ? <Eye size={14} /> : <EyeSlash size={14} />}
        </button>
      )}
      {columns.map((c) => (
        <button key={c.id} className="db-prop-row" disabled={c.type === "title"} onClick={() => toggle(c.id)}>
          <span>{c.name}</span>
          {c.type === "title" ? <Eye size={14} className="db-prop-locked" /> : isHidden(c.id) ? <EyeSlash size={14} /> : <Eye size={14} />}
        </button>
      ))}
    </div>
  );
}

/* ---- Layout (board group-by / calendar date / gallery cover) ------------------------------- */
function LayoutPopover({ view, columns, onUpdateView, onClose }: Props & { onClose: () => void }) {
  const ref = useDismiss(true, onClose, ".db-toolbar");
  const selects = columns.filter((c) => c.type === "select" || c.type === "multiselect");
  const dates = columns.filter((c) => c.type === "date" || c.type === "datetime" || c.type === "daterange");
  const onlySelect = columns.filter((c) => c.type === "select");

  return (
    <div className="db-popover db-layout-pop" ref={ref}>
      <div className="db-popover-head"><span>Layout</span></div>

      {view.type === "board" && (
        <label className="db-layout-row">
          <span>Group by</span>
          <Select
            className="db-layout-select"
            value={view.groupBy ?? ""}
            placeholder="Select…"
            options={selects.map((c) => ({ value: c.id, label: c.name }))}
            onChange={(v) => onUpdateView({ groupBy: v })}
          />
        </label>
      )}

      {view.type === "calendar" && (
        <>
          <label className="db-layout-row">
            <span>Date by</span>
            <Select
              className="db-layout-select"
              value={view.dateField ?? ""}
              placeholder="Date property…"
              options={dates.map((c) => ({ value: c.id, label: c.name }))}
              onChange={(v) => onUpdateView({ dateField: v })}
            />
          </label>
          <label className="db-layout-row">
            <span>Range</span>
            <Select
              className="db-layout-select"
              value={view.calendarMode ?? "month"}
              options={[{ value: "month", label: "Month" }, { value: "week", label: "Week" }]}
              onChange={(v) => onUpdateView({ calendarMode: v as "month" | "week" })}
            />
          </label>
        </>
      )}

      {view.type === "gallery" && (
        <label className="db-layout-row">
          <span>Cover color</span>
          <Select
            className="db-layout-select"
            value={view.cardCover ?? ""}
            placeholder="None"
            options={[{ value: "", label: "None" }, ...onlySelect.map((c) => ({ value: c.id, label: c.name }))]}
            onChange={(v) => onUpdateView({ cardCover: v })}
          />
        </label>
      )}
    </div>
  );
}
