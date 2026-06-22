import { useEffect, useMemo, useRef, useState } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";

interface Props {
  /** Viewport coords to anchor the popup at (the editor caret). */
  left: number;
  top: number;
  /** Called with the chosen ISO date (YYYY-MM-DD). */
  onPick: (iso: string) => void;
  /** Dismiss without picking. */
  onClose: () => void;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Local-time ISO date key (YYYY-MM-DD), matching how the task index stores `due`. */
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * An inline date picker popup styled like the editor's slash menu: a few quick-pick shortcuts
 * (Today / Tomorrow / Next week) above a clickable mini month calendar. Used by the `/due` command
 * to insert a `📅 YYYY-MM-DD` marker at the caret.
 */
export default function DatePicker({ left, top, onPick, onClose }: Props) {
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const [view, setView] = useState<Date>(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss on Escape or a click outside the popup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    // Attach the outside-click listener on the NEXT tick. The picker is usually opened by a
    // mousedown (e.g. the task `+` menu's "Due date" item); attaching synchronously would let that
    // very same still-propagating mousedown reach this handler and close the picker immediately.
    const id = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const quick = (deltaDays: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + deltaDays);
    onPick(iso(d));
  };

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  // Build the month grid: leading blanks (Mon-start), the days, trailing blanks.
  const cells = useMemo<(Date | null)[]>(() => {
    const year = view.getFullYear();
    const month = view.getMonth();
    const lead = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(new Date(year, month, d));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [view]);

  return (
    <div
      ref={ref}
      className="date-picker"
      style={{ left, top }}
      // Keep focus in the editor; clicks here shouldn't steal it before onPick fires.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="dp-quick">
        <button className="dp-quick-btn" onClick={() => quick(0)}>Today</button>
        <button className="dp-quick-btn" onClick={() => quick(1)}>Tomorrow</button>
        <button className="dp-quick-btn" onClick={() => quick(7)}>Next week</button>
      </div>

      <div className="dp-head">
        <button
          className="dp-nav"
          onClick={() => setView((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
          title="Previous month"
        >
          <CaretLeft size={13} weight="bold" />
        </button>
        <span className="dp-title">{MONTHS[view.getMonth()]} {view.getFullYear()}</span>
        <button
          className="dp-nav"
          onClick={() => setView((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
          title="Next month"
        >
          <CaretRight size={13} weight="bold" />
        </button>
      </div>

      <div className="dp-grid">
        {WEEKDAYS.map((w) => (
          <div key={w} className="dp-weekday">{w}</div>
        ))}
        {cells.map((day, i) =>
          day === null ? (
            <div key={`b${i}`} className="dp-day empty" />
          ) : (
            <button
              key={day.getTime()}
              className={"dp-day" + (isSameDay(day, today) ? " today" : "")}
              onClick={() => onPick(iso(day))}
            >
              {day.getDate()}
            </button>
          )
        )}
      </div>
    </div>
  );
}
