// Calendar view: places rows on a month or week grid by a chosen date column. Click a day to add a
// row pre-dated to that day; click an event to open the row. Navigation: ‹ today › and Month/Week.

import { useMemo, useState } from "react";
import { CaretLeft, CaretRight, Plus } from "@phosphor-icons/react";
import type { DbColumn, DbView } from "../types";
import type { DbRow } from "../dblogic";
import { cellValue, primaryDate } from "../dblogic";

interface Props {
  allColumns: DbColumn[];
  rows: DbRow[];
  view: DbView;
  onOpenRow: (relPath: string) => void;
  onAddRow: (preset?: Record<string, unknown>) => void;
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WEEKDAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const lead = (x.getDay() + 6) % 7; // Monday-based
  x.setDate(x.getDate() - lead);
  x.setHours(0, 0, 0, 0);
  return x;
}

export default function DbCalendarView({ allColumns, rows, view, onOpenRow, onAddRow }: Props) {
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const [anchor, setAnchor] = useState<Date>(today);
  const mode = view.calendarMode ?? "month";

  const dateCol = allColumns.find(
    (c) => c.id === view.dateField && (c.type === "date" || c.type === "datetime" || c.type === "daterange")
  );
  if (!dateCol) {
    return <div className="db-empty-state">Pick a <b>Date</b> property in the view options (⚙) to use the calendar.</div>;
  }

  // Map ISO day → rows landing on it.
  const byDay = useMemo(() => {
    const m = new Map<string, DbRow[]>();
    for (const row of rows) {
      const iso = primaryDate(cellValue(row, dateCol));
      if (!iso) continue;
      const bucket = m.get(iso) ?? [];
      bucket.push(row);
      m.set(iso, bucket);
    }
    return m;
  }, [rows, dateCol]);

  // The grid of days for the current month or week.
  const days = useMemo<Date[]>(() => {
    if (mode === "week") {
      const s = startOfWeek(anchor);
      return Array.from({ length: 7 }, (_, i) => { const d = new Date(s); d.setDate(s.getDate() + i); return d; });
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const gridStart = startOfWeek(first);
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d; });
  }, [anchor, mode]);

  const title = mode === "week"
    ? (() => { const s = startOfWeek(anchor); const e = new Date(s); e.setDate(s.getDate() + 6);
        return `${MONTHS[s.getMonth()].slice(0, 3)} ${s.getDate()} – ${MONTHS[e.getMonth()].slice(0, 3)} ${e.getDate()}, ${e.getFullYear()}`; })()
    : `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;

  const step = (dir: number) => {
    setAnchor((a) => {
      const d = new Date(a);
      if (mode === "week") d.setDate(d.getDate() + dir * 7);
      else d.setMonth(d.getMonth() + dir);
      return d;
    });
  };

  const presetFor = (iso: string): Record<string, unknown> =>
    dateCol.type === "daterange" ? { [dateCol.id]: { start: iso, end: iso } }
      : dateCol.type === "datetime" ? { [dateCol.id]: `${iso} 09:00` }
      : { [dateCol.id]: iso };

  return (
    <div className="db-calendar">
      <div className="db-cal-toolbar">
        <button className="db-cal-nav" onClick={() => step(-1)}><CaretLeft size={14} /></button>
        <button className="db-cal-today" onClick={() => setAnchor(today)}>Today</button>
        <button className="db-cal-nav" onClick={() => step(1)}><CaretRight size={14} /></button>
        <span className="db-cal-title">{title}</span>
      </div>
      <div className="db-cal-weekrow">
        {WEEKDAYS.map((w) => <div key={w} className="db-cal-weekname">{w}</div>)}
      </div>
      <div className={`db-cal-month${mode === "week" ? " week" : ""}`}>
        {days.map((d) => {
          const iso = isoOf(d);
          const dayRows = byDay.get(iso) ?? [];
          const dim = mode === "month" && d.getMonth() !== anchor.getMonth();
          return (
            <div key={iso} className={`db-cal-cell${dim ? " dim" : ""}${iso === isoOf(today) ? " today" : ""}`}>
              <div className="db-cal-cell-head">
                <span className="db-cal-daynum">{d.getDate()}</span>
                <button className="db-cal-cell-add" title="New row on this day" onClick={() => onAddRow(presetFor(iso))}>
                  <Plus size={12} />
                </button>
              </div>
              <div className="db-cal-events">
                {dayRows.map((row) => (
                  <button key={row.rel_path} className="db-cal-event" onClick={() => onOpenRow(row.rel_path)} title={row.title}>
                    {row.title || "Untitled"}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
