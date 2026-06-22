import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { TaskRow } from "../types";
import { upcoming } from "../recurrence";
import TaskList, { type TaskItem } from "./TaskList";

interface Props {
  onOpen: (relPath: string) => void;
  refreshKey: number;
  /** Pattern for rendering due dates (see dateformat.ts). */
  dateFormat: string;
}

/** Group tasks by leading `#tag` subgroup, falling back to "Untagged". */
function subgroup(t: TaskItem): string {
  return t.tags[0] ? `#${t.tags[0]}` : "Untagged";
}

export default function TasksView({ onOpen, refreshKey, dateFormat }: Props) {
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [showAhead, setShowAhead] = useState(true);
  const [localRefresh, setLocalRefresh] = useState(0);

  const reload = () => api.listTasks().then(setRows).catch(console.error);

  useEffect(() => {
    reload();
  }, [refreshKey, localRefresh]);

  // Flip a task's done state on disk, then re-fetch. For a recurring task each row carries its own
  // occurrence date, so only that occurrence toggles; a plain task flips its checkbox.
  const onToggle = (t: TaskItem) => {
    api
      .toggleTask(t.rel_path, t.line, t.occurrence ?? null)
      .then(() => setLocalRefresh((k) => k + 1))
      .catch(console.error);
  };

  const tasks = useMemo<TaskItem[]>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const out: TaskItem[] = [];
    for (const r of rows) {
      const tags = r.tags ? r.tags.split(",").filter(Boolean) : [];
      const doneDates = r.done_dates ? r.done_dates.split(",").filter(Boolean) : [];
      const recurring = !!r.rrule;
      // A recurring task is done per-occurrence (its current occurrence = its due date); a plain
      // task uses its checkbox mark.
      const baseDone = recurring ? !!r.due && doneDates.includes(r.due) : r.done;
      const base: TaskItem = {
        text: r.text.replace(/[📅🔁✅]\s*[^📅🔁⏳✅]*/g, "").replace(/#[\w/-]+/g, "").trim(),
        due: r.due,
        done: baseDone,
        rel_path: r.rel_path,
        line: r.line,
        tags,
        recurring,
        occurrence: recurring ? r.due : null,
      };
      out.push(base);
      // "show all ahead": expand recurring tasks into upcoming virtual occurrences, each with its
      // own per-occurrence done state.
      if (showAhead && r.rrule) {
        const start = r.due ? new Date(r.due) : today;
        for (const occ of upcoming(r.rrule, start, today, 8)) {
          if (occ.iso === r.due) continue;
          out.push({
            ...base,
            due: occ.iso,
            virtual: true,
            occurrence: occ.iso,
            done: doneDates.includes(occ.iso),
          });
        }
      }
    }
    return out.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  }, [rows, showAhead]);

  const groups = useMemo(() => {
    const m = new Map<string, TaskItem[]>();
    for (const t of tasks) {
      const k = subgroup(t);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    }
    return [...m.entries()].sort();
  }, [tasks]);

  return (
    <div className="panel tasks-view">
      <div className="panel-header">
        <h2>Tasks</h2>
        <label className="toggle">
          <input type="checkbox" checked={showAhead} onChange={(e) => setShowAhead(e.target.checked)} />
          Show all recurring ahead
        </label>
      </div>
      {groups.length === 0 && <p className="muted">No tasks found. Add `- [ ] something` to any page.</p>}
      {groups.map(([name, items]) => (
        <div key={name} className="task-group">
          <h3 className="task-group-title">{name}</h3>
          <TaskList tasks={items} dateFormat={dateFormat} onOpen={onOpen} onToggle={onToggle} />
        </div>
      ))}
    </div>
  );
}
