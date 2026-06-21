import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { TaskRow } from "../types";
import { upcoming } from "../recurrence";

interface DisplayTask {
  text: string;
  due: string | null;
  done: boolean;
  rel_path: string;
  tags: string[];
  recurring: boolean;
  virtual?: boolean; // a computed future occurrence
}

interface Props {
  onOpen: (relPath: string) => void;
  refreshKey: number;
}

/** Group tasks by leading `#tag` subgroup, falling back to "Untagged". */
function subgroup(t: DisplayTask): string {
  return t.tags[0] ? `#${t.tags[0]}` : "Untagged";
}

export default function TasksView({ onOpen, refreshKey }: Props) {
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [showAhead, setShowAhead] = useState(true);

  useEffect(() => {
    api.listTasks().then(setRows).catch(console.error);
  }, [refreshKey]);

  const tasks = useMemo<DisplayTask[]>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const out: DisplayTask[] = [];
    for (const r of rows) {
      const tags = r.tags ? r.tags.split(",").filter(Boolean) : [];
      const base: DisplayTask = {
        text: r.text.replace(/[📅🔁]\s*\S+/g, "").replace(/#[\w/-]+/g, "").trim(),
        due: r.due,
        done: r.done,
        rel_path: r.rel_path,
        tags,
        recurring: !!r.rrule,
      };
      out.push(base);
      // "show all ahead": expand recurring tasks into upcoming virtual occurrences.
      if (showAhead && r.rrule && !r.done) {
        const start = r.due ? new Date(r.due) : today;
        for (const occ of upcoming(r.rrule, start, today, 8)) {
          if (occ.iso === r.due) continue;
          out.push({ ...base, due: occ.iso, virtual: true });
        }
      }
    }
    return out.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  }, [rows, showAhead]);

  const groups = useMemo(() => {
    const m = new Map<string, DisplayTask[]>();
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
          {items.map((t, i) => (
            <div key={i} className={`task-row${t.done ? " done" : ""}${t.virtual ? " virtual" : ""}`}>
              <input type="checkbox" checked={t.done} readOnly />
              <span className="task-text" onClick={() => onOpen(t.rel_path)}>
                {t.text || "(untitled task)"}
              </span>
              {t.recurring && <span className="badge">🔁</span>}
              {t.virtual && <span className="badge ahead">ahead</span>}
              {t.due && <span className="task-due">{t.due}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
