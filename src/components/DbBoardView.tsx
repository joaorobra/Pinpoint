// Board (Kanban) view: rows grouped into lanes by a select column. Drag a card to another lane to
// set that row's value to the lane's option. A trailing "No <field>" lane holds rows with no value.

import { useRef, useState } from "react";
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

// Long-press delay before a card lifts when dragging from its body (not the grip). Below this and a
// quick move scrolls the lane instead. The grip handle lifts immediately.
const LIFT_DELAY = 220;
// Pointer travel (px) that cancels a pending lift (treated as a scroll) or, post-lift, distinguishes
// a drag from a tap on pointerup.
const MOVE_TOLERANCE = 8;

export default function DbBoardView({ columns, allColumns, rows, view, dateFormat, onSetCell, onOpenRow, onAddRow }: Props) {
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overLane, setOverLane] = useState<string | null>(null);

  // Drag gesture bookkeeping for the unified Pointer Events path (covers mouse + touch). `lifted`
  // gates the actual reorder; before it we're just a candidate that a scroll can cancel.
  const drag = useRef<{
    rowPath: string;
    pointerId: number;
    startX: number;
    startY: number;
    lifted: boolean;
    liftTimer: number;
  } | null>(null);

  const clearDrag = () => {
    if (drag.current) window.clearTimeout(drag.current.liftTimer);
    drag.current = null;
    setDragRow(null);
    setOverLane(null);
  };

  // Find the lane under a viewport point and mark it as the drop target.
  const updateOverLane = (clientX: number, clientY: number) => {
    const el = document.elementFromPoint(clientX, clientY);
    const lane = el?.closest<HTMLElement>(".db-lane");
    setOverLane(lane?.dataset.lane ?? null);
  };

  const onCardPointerDown = (e: React.PointerEvent, rowPath: string, fromGrip: boolean) => {
    // Only the primary button / a touch contact starts a drag candidate.
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = () => {
      setDragRow(rowPath);
      if (drag.current) drag.current.lifted = true;
    };
    drag.current = {
      rowPath,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lifted: fromGrip,
      // The grip lifts now; the body waits for a long-press so vertical scrolling still works.
      liftTimer: fromGrip ? 0 : window.setTimeout(start, LIFT_DELAY),
    };
    if (fromGrip) start();
  };

  const onCardPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
    if (!d.lifted) {
      // Moved before the long-press fired → it's a scroll, not a drag. Abandon the candidate.
      if (moved > MOVE_TOLERANCE) clearDrag();
      return;
    }
    e.preventDefault();
    updateOverLane(e.clientX, e.clientY);
  };

  const onCardPointerUp = (e: React.PointerEvent, rowPath: string) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) { clearDrag(); return; }
    const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
    if (d.lifted) {
      // Dropped over a lane → reorder; barely moved → treat as a tap and open the row.
      const lane = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".db-lane");
      if (lane?.dataset.lane) drop(lane.dataset.lane);
      else if (moved <= MOVE_TOLERANCE) onOpenRow(rowPath);
    } else if (moved <= MOVE_TOLERANCE) {
      onOpenRow(rowPath);
    }
    clearDrag();
  };

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
            data-lane={lane.id}
            className={`db-lane${isOver ? " over" : ""}`}
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
                    onPointerDown={(e) => onCardPointerDown(e, row.rel_path, false)}
                    onPointerMove={onCardPointerMove}
                    onPointerUp={(e) => onCardPointerUp(e, row.rel_path)}
                    onPointerCancel={clearDrag}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenRow(row.rel_path); } }}
                    style={lane.opt ? { borderLeftColor: chipBg(lane.opt.color) } : undefined}
                  >
                    <span
                      className="db-card-grip"
                      aria-hidden
                      // Pressing the grip lifts immediately (no long-press), and stops the press from
                      // bubbling to the card so we don't start two gestures.
                      onPointerDown={(e) => { e.stopPropagation(); onCardPointerDown(e, row.rel_path, true); }}
                      onPointerMove={onCardPointerMove}
                      onPointerUp={(e) => { e.stopPropagation(); onCardPointerUp(e, row.rel_path); }}
                      onPointerCancel={clearDrag}
                    >
                      <DotsSixVertical size={14} weight="bold" />
                    </span>
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
