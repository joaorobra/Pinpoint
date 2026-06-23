// Right-click action menu for a task row in the Tasks view: set its priority, or "send" it (move the
// task line + its subtasks) into another periodic note — picking a grain (day / week / month) and
// then a quick preset or an exact date. Self-contained popover (the generic ContextMenu is flat and
// can't host the nested send-to flow); clamps to the viewport and closes on outside-click / Escape.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Flag, CalendarBlank, CaretRight, ArrowBendUpRight, FileText } from "@phosphor-icons/react";
import DatePicker from "./DatePicker";
import type { Period } from "../periodic";
import { PRIORITY_META, type TaskItem } from "./TaskList";

/** The grains we let a task be sent to (a subset of Period — the ones a person schedules into). */
type Grain = "daily" | "weekly" | "monthly";
const GRAINS: { grain: Grain; label: string }[] = [
  { grain: "daily", label: "Day" },
  { grain: "weekly", label: "Week" },
  { grain: "monthly", label: "Month" },
];

/** Quick targets within a grain, as offsets from today (in that grain's unit). */
const PRESETS: Record<Grain, { label: string; offset: number }[]> = {
  daily: [
    { label: "Tomorrow", offset: 1 },
    { label: "In 2 days", offset: 2 },
    { label: "Next week", offset: 7 },
  ],
  weekly: [
    { label: "Next week", offset: 1 },
    { label: "In 2 weeks", offset: 2 },
  ],
  monthly: [
    { label: "Next month", offset: 1 },
    { label: "In 2 months", offset: 2 },
  ],
};

export interface SendTarget {
  /** The grain of periodic note to move the task into. */
  period: Period;
  /** A date inside the destination period (the caller derives the exact note path). */
  date: Date;
}

interface Props {
  /** Where to open (the right-click pointer position). */
  x: number;
  y: number;
  task: TaskItem;
  /** Set/clear the task's priority. `level: null` clears it. */
  onSetPriority: (level: string | null) => void;
  /** Move the task (and its subtasks) into the chosen periodic note. */
  onSend: (target: SendTarget) => void;
  onClose: () => void;
}

/** Local midnight today. */
function today0(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Step a date by `offset` units of `grain` (days / weeks / months) from `base`. */
function stepDate(base: Date, grain: Grain, offset: number): Date {
  const d = new Date(base);
  if (grain === "daily") d.setDate(d.getDate() + offset);
  else if (grain === "weekly") d.setDate(d.getDate() + offset * 7);
  else d.setMonth(d.getMonth() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
}

const GRAIN_TO_PERIOD: Record<Grain, Period> = { daily: "daily", weekly: "weekly", monthly: "monthly" };

export default function TaskActionMenu({ x, y, task, onSetPriority, onSend, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Which nested panel is open: the send-to grain list, or a specific grain's presets.
  const [view, setView] = useState<"root" | "send" | Grain>("root");
  // When set, the exact-date picker is open for this grain.
  const [pickFor, setPickFor] = useState<Grain | null>(null);

  // Clamp into the viewport once measured.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - width - 8);
    const top = Math.min(y, window.innerHeight - height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y, view]);

  // Close on Escape / outside click / scroll. The date picker handles its own dismissal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pickFor) setPickFor(null);
      else if (view !== "root") setView(view === "send" ? "root" : "send");
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, view, pickFor]);

  const send = (grain: Grain, date: Date) => {
    onSend({ period: GRAIN_TO_PERIOD[grain], date });
    onClose();
  };

  return (
    <div className="ctx-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        ref={ref}
        className="ctx-menu task-action-menu"
        style={{ left: pos.left, top: pos.top }}
        onClick={(e) => e.stopPropagation()}
      >
        {view === "root" && (
          <>
            <div className="ctx-section-label">Priority</div>
            {(["high", "medium", "low"] as const).map((lvl) => (
              <button
                key={lvl}
                className={`ctx-item${task.priority === lvl ? " on" : ""} prio-${lvl}`}
                onClick={() => { onSetPriority(lvl); onClose(); }}
              >
                <span className="ctx-icon"><Flag size={15} weight="fill" /></span>
                <span className="ctx-label">{PRIORITY_META[lvl].label}</span>
              </button>
            ))}
            <button
              className={`ctx-item${!task.priority ? " on" : ""}`}
              onClick={() => { onSetPriority(null); onClose(); }}
            >
              <span className="ctx-icon"><Flag size={15} /></span>
              <span className="ctx-label">None</span>
            </button>

            <div className="ctx-sep" />
            <button className="ctx-item" onClick={() => setView("send")}>
              <span className="ctx-icon"><ArrowBendUpRight size={15} /></span>
              <span className="ctx-label">Send to…</span>
              <CaretRight size={13} className="ctx-submenu-caret" />
            </button>
          </>
        )}

        {view === "send" && (
          <>
            <button className="ctx-item ctx-back" onClick={() => setView("root")}>
              <CaretRight size={13} className="ctx-back-caret" />
              <span className="ctx-label">Send to…</span>
            </button>
            <div className="ctx-section-label">Choose a period</div>
            {GRAINS.map((g) => (
              <button key={g.grain} className="ctx-item" onClick={() => setView(g.grain)}>
                <span className="ctx-icon"><CalendarBlank size={15} /></span>
                <span className="ctx-label">{g.label}</span>
                <CaretRight size={13} className="ctx-submenu-caret" />
              </button>
            ))}
          </>
        )}

        {view !== "root" && view !== "send" && (
          <>
            <button className="ctx-item ctx-back" onClick={() => setView("send")}>
              <CaretRight size={13} className="ctx-back-caret" />
              <span className="ctx-label">{GRAINS.find((g) => g.grain === view)?.label}</span>
            </button>
            {PRESETS[view].map((p) => (
              <button
                key={p.label}
                className="ctx-item"
                onClick={() => send(view, stepDate(today0(), view, p.offset))}
              >
                <span className="ctx-icon"><CalendarBlank size={15} /></span>
                <span className="ctx-label">{p.label}</span>
              </button>
            ))}
            <div className="ctx-sep" />
            <button className="ctx-item" onClick={() => setPickFor(view)}>
              <span className="ctx-icon"><FileText size={15} /></span>
              <span className="ctx-label">Pick a date…</span>
            </button>
          </>
        )}
      </div>

      {pickFor && (
        <DatePicker
          left={pos.left}
          top={pos.top}
          onPick={(iso) => {
            // Parse YYYY-MM-DD as a local date, then route through the active grain.
            const [yy, mm, dd] = iso.split("-").map(Number);
            send(pickFor, new Date(yy, mm - 1, dd));
          }}
          onClose={() => setPickFor(null)}
        />
      )}
    </div>
  );
}
