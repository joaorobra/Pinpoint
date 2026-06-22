// Board (Kanban) view: rows grouped into lanes by a select column. Drag a card to another lane to
// set that row's value to the lane's option. A trailing "No <field>" lane holds rows with no value.

import { useState } from "react";
import { Plus, DotsSixVertical } from "@phosphor-icons/react";
import type { DbColumn, DbOption, DbView } from "../types";
import type { DbRow } from "../dblogic";
import { cellValue } from "../dblogic";
import { CellValueView, Chip, chipBg } from "./DbShared";

interface Props {
  columns: DbColumn[];   // visible columns (for card body)
  allColumns: DbColumn[];
  rows: DbRow[];
  view: DbView;
  dateFormat: string;
  onSetCell: (rowPath: string, colId: string, value: unknown) => void;
  onOpenRow: (relPath: string) => void;
  onAddRow: (preset?: Record<string, unknown>) => void;
}

const NONE = "__none__";

export default function DbBoardView({ columns, allColumns, rows, view, dateFormat, onSetCell, onOpenRow, onAddRow }: Props) {
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overLane, setOverLane] = useState<string | null>(null);

  const groupCol = allColumns.find((c) => c.id === view.groupBy && (c.type === "select" || c.type === "multiselect"));
  if (!groupCol) {
    return <div className="db-empty-state">Pick a <b>Select</b> property to group by in the view options (⚙) to use the board.</div>;
  }
  // Card body shows visible non-title, non-group columns.
  const bodyCols = columns.filter((c) => c.type !== "title" && c.id !== groupCol.id);

  const options = groupCol.options ?? [];
  // Lane key for a row: its option id (select), first option (multiselect), or NONE.
  const laneOf = (row: DbRow): string => {
    const v = cellValue(row, groupCol);
    if (groupCol.type === "multiselect") return Array.isArray(v) && v.length ? (v[0] as string) : NONE;
    return typeof v === "string" && v ? v : NONE;
  };

  const lanes: { id: string; opt?: DbOption }[] = [...options.map((o) => ({ id: o.id, opt: o })), { id: NONE }];

  const drop = (laneId: string) => {
    if (!dragRow) return;
    const value = laneId === NONE ? "" : groupCol.type === "multiselect" ? [laneId] : laneId;
    onSetCell(dragRow, groupCol.id, value);
    setDragRow(null);
    setOverLane(null);
  };

  const addToLane = (laneId: string) =>
    onAddRow(laneId === NONE ? undefined : { [groupCol.id]: groupCol.type === "multiselect" ? [laneId] : laneId });

  return (
    <div className="db-board">
      {lanes.map((lane) => {
        const laneRows = rows.filter((r) => laneOf(r) === lane.id);
        const accent = lane.opt ? lane.opt.color || "var(--accent)" : "var(--text-faint)";
        const isOver = overLane === lane.id;
        return (
          <div
            key={lane.id}
            className={`db-lane${isOver ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); if (!isOver) setOverLane(lane.id); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverLane((l) => (l === lane.id ? null : l)); }}
            onDrop={() => drop(lane.id)}
          >
            <div className="db-lane-head">
              <span className="db-lane-dot" style={{ background: accent }} />
              {lane.opt ? <Chip opt={lane.opt} /> : <span className="db-lane-none">No {groupCol.name}</span>}
              <span className="db-lane-count">{laneRows.length}</span>
              <button className="db-lane-head-add" title={`Add to ${lane.opt?.label ?? "this lane"}`} onClick={() => addToLane(lane.id)}>
                <Plus size={14} />
              </button>
            </div>
            <div className="db-lane-body">
              {laneRows.map((row) => {
                const dragging = dragRow === row.rel_path;
                return (
                  <div
                    key={row.rel_path}
                    className={`db-card${dragging ? " dragging" : ""}`}
                    role="button"
                    tabIndex={0}
                    draggable
                    onDragStart={() => setDragRow(row.rel_path)}
                    onDragEnd={() => { setDragRow(null); setOverLane(null); }}
                    onClick={() => onOpenRow(row.rel_path)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenRow(row.rel_path); } }}
                    style={lane.opt ? { borderLeftColor: chipBg(lane.opt.color) } : undefined}
                  >
                    <span className="db-card-grip" aria-hidden><DotsSixVertical size={14} weight="bold" /></span>
                    <div className="db-card-title">{row.title || "Untitled"}</div>
                    {bodyCols.map((c) => (
                      <div key={c.id} className="db-card-field">
                        <span className="db-card-field-label">{c.name}</span>
                        <CellValueView col={c} row={row} dateFormat={dateFormat} />
                      </div>
                    ))}
                  </div>
                );
              })}
              {laneRows.length === 0 && !isOver && (
                <div className="db-lane-empty">Drop cards here</div>
              )}
              {isOver && <div className="db-lane-dropline" />}
              <button className="db-lane-add" onClick={() => addToLane(lane.id)}>
                <Plus size={13} /> New
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
