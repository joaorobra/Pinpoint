import type { QueryResult } from "../types";
import { upcoming } from "../recurrence";
import TaskList, { type TaskItem } from "./TaskList";

interface Props {
  result: QueryResult;
  /** Pattern for rendering task due dates (TASK queries). */
  dateFormat?: string;
  /** Open a task's source page when its text is clicked (TASK queries). `line` scrolls+flashes it. */
  onOpen?: (relPath: string, line?: number) => void;
  /** Toggle a task's done state when its checkbox is clicked (TASK queries). */
  onToggle?: (task: TaskItem) => void;
  /**
   * For TASK queries: also expand recurring tasks into their upcoming occurrences (matching the
   * Tasks panel's "show all ahead"). Bounded so a daily rule can't flood the block.
   */
  expandRecurring?: boolean;
  /**
   * For TASK queries: restrict recurring tasks to the single occurrence due *today*. Each recurring
   * task contributes at most one row (its today occurrence, real or virtual); a task with no
   * occurrence today is dropped. Non-recurring tasks are unaffected. Takes precedence over
   * `expandRecurring`. Drives the `SCOPE today` DSL clause (see querydsl.ts).
   */
  todayOnly?: boolean;
}

/** Map a TASK query row to a display TaskItem. */
function toTaskItem(r: Record<string, unknown>): TaskItem {
  const tags = typeof r.tags === "string" && r.tags ? r.tags.split(",").filter(Boolean) : [];
  const doneDates =
    typeof r.done_dates === "string" && r.done_dates ? r.done_dates.split(",").filter(Boolean) : [];
  const recurring = !!r.recurring;
  const due = (r.due as string | null) ?? null;
  // A recurring task tracks done-ness per occurrence: this row (the base/current one) is done iff
  // its due date is in the completed list. A plain task uses its checkbox mark.
  const done = recurring ? !!due && doneDates.includes(due) : !!r.done;
  return {
    text: String(r.text ?? ""),
    due,
    done,
    rel_path: String(r["file.path"] ?? ""),
    line: Number(r.line ?? 0),
    tags,
    priority: typeof r.priority === "string" ? r.priority : null,
    recurring,
    occurrence: recurring ? due : null,
  };
}

/** Expand recurring task rows into upcoming virtual occurrences (within a bounded horizon). */
function expandTasks(rows: Record<string, unknown>[]): TaskItem[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out: TaskItem[] = [];
  for (const r of rows) {
    const base = toTaskItem(r);
    const doneDates =
      typeof r.done_dates === "string" && r.done_dates ? r.done_dates.split(",").filter(Boolean) : [];
    out.push(base);
    const rrule = r.rrule as string | null | undefined;
    // Expand a recurring task's upcoming occurrences. Each virtual row carries its own occurrence
    // date, so it can be checked off independently (done iff that date is in the completed list).
    // We insert them (date-ordered) directly after their base row rather than re-sorting the whole
    // list, so the backend's SORT clause (e.g. SORT done, SORT text) is preserved.
    if (rrule) {
      const start = base.due ? new Date(base.due) : today;
      for (const occ of upcoming(rrule, start, today, 8)) {
        if (occ.iso === base.due) continue;
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
  return out;
}

/** Local-time ISO date (YYYY-MM-DD) for `d`, matching how occurrence ISO strings are derived. */
function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Reduce TASK rows to only the occurrence due *today*. A recurring task contributes its today
 * occurrence (real or virtual) if its rule lands on today; otherwise it's dropped. Non-recurring
 * tasks are kept only when their own `due` is today. One row per task at most.
 */
function todayOccurrences(rows: Record<string, unknown>[]): TaskItem[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = isoDay(today);
  const out: TaskItem[] = [];
  for (const r of rows) {
    const base = toTaskItem(r);
    const rrule = r.rrule as string | null | undefined;
    if (!rrule) {
      // Plain task: include only if it's actually due today.
      if (base.due === todayIso) out.push(base);
      continue;
    }
    const doneDates =
      typeof r.done_dates === "string" && r.done_dates ? r.done_dates.split(",").filter(Boolean) : [];
    const start = base.due ? new Date(base.due) : today;
    // Does this rule have an occurrence exactly on today? `upcoming` from today returns today first
    // when it lands on the rule; we only need a single match.
    const hit = upcoming(rrule, start, today, 1).find((o) => o.iso === todayIso);
    if (!hit) continue;
    out.push(
      hit.iso === base.due
        ? base // today is the base/current occurrence
        : { ...base, due: hit.iso, virtual: true, occurrence: hit.iso, done: doneDates.includes(hit.iso) }
    );
  }
  return out;
}

/**
 * Renders a query result. TASK results render as proper task rows (shared with the Tasks panel);
 * LIST as a bullet list; TABLE as a table. Used by the standalone Query panel and inline query
 * blocks so results look the same everywhere.
 */
export default function QueryResultView({ result, dateFormat = "YYYY-MM-DD", onOpen, onToggle, expandRecurring, todayOnly }: Props) {
  if (result.kind === "task") {
    const tasks = todayOnly
      ? todayOccurrences(result.rows)
      : expandRecurring
        ? expandTasks(result.rows)
        : result.rows.map(toTaskItem);
    return (
      <>
        <TaskList tasks={tasks} dateFormat={dateFormat} onOpen={onOpen} onToggle={onToggle} emptyMessage="No matching tasks." />
        {tasks.length > 0 && <p className="muted">{tasks.length} task(s)</p>}
      </>
    );
  }

  if (result.rows.length === 0) return <p className="muted">No results.</p>;

  return (
    <>
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
    </>
  );
}
