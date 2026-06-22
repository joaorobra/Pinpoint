import { ArrowsClockwise, Warning } from "@phosphor-icons/react";
import { formatDate, parseISODate } from "../dateformat";

/** A normalized task for display. Both the Tasks panel and inline TASK queries map onto this. */
export interface TaskItem {
  text: string;
  due: string | null;
  done: boolean;
  rel_path: string;
  /** 0-based line index of the source task in its page body (for write-back). */
  line: number;
  /** Leading `#tags` on the task line (without the `#`). */
  tags: string[];
  /** Carries a recurrence rule. */
  recurring: boolean;
  /** A computed future occurrence of a recurring task (rendered faintly, with an "ahead" badge). */
  virtual?: boolean;
  /**
   * For a recurring task, the occurrence date this row represents — passed back on toggle so only
   * that occurrence's done state flips. Null/undefined for a plain task (toggles the whole line).
   */
  occurrence?: string | null;
}

interface Props {
  tasks: TaskItem[];
  /** Pattern for rendering due dates (see dateformat.ts). */
  dateFormat: string;
  /** Open the task's source page (click on the text). Omit to render non-interactive. */
  onOpen?: (relPath: string) => void;
  /**
   * Toggle a task's done state (click the checkbox). Receives the row so the caller can pass its
   * line + occurrence to the backend. Omit to render checkboxes read-only.
   */
  onToggle?: (task: TaskItem) => void;
  /** Today, for overdue styling. Defaults to the current day. */
  today?: Date;
  /** Empty-state copy. */
  emptyMessage?: string;
}

/** True when a real (non-virtual), open task's due date is before today. */
function isOverdue(t: TaskItem, today: Date): boolean {
  if (t.done || t.virtual || !t.due) return false;
  return parseISODate(t.due).getTime() < today.getTime();
}

/**
 * A consistent task-row list, shared by the standalone Tasks panel and inline TASK query blocks so
 * tasks look the same everywhere: a checkbox, the task text, a recurring/overdue badge, an "ahead"
 * tag for virtual occurrences, and a right-aligned due date.
 */
export default function TaskList({ tasks, dateFormat, onOpen, onToggle, today, emptyMessage }: Props) {
  const ref = today ?? (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  })();

  if (tasks.length === 0) {
    return <p className="muted">{emptyMessage ?? "No tasks."}</p>;
  }

  return (
    <div className="task-list">
      {tasks.map((t, i) => {
        const overdue = isOverdue(t, ref);
        return (
          <div
            key={i}
            className={`task-row${t.done ? " done" : ""}${t.virtual ? " virtual" : ""}${
              overdue ? " overdue" : ""
            }`}
          >
            <input
              type="checkbox"
              checked={t.done}
              onChange={onToggle ? () => onToggle(t) : undefined}
              readOnly={!onToggle}
              tabIndex={onToggle ? 0 : -1}
              title={onToggle ? "Toggle done" : undefined}
            />
            <span
              className={`task-text${onOpen ? " linkable" : ""}`}
              onClick={onOpen ? () => onOpen(t.rel_path) : undefined}
              title={onOpen ? t.rel_path : undefined}
            >
              {t.text || "(untitled task)"}
            </span>
            {t.tags.map((tag) => (
              <span key={tag} className="task-tag">
                #{tag}
              </span>
            ))}
            {t.recurring && (
              <span className="badge" title="Recurring">
                <ArrowsClockwise size={12} weight="bold" />
              </span>
            )}
            {t.virtual && <span className="badge ahead">ahead</span>}
            {overdue && (
              <span className="badge overdue-badge" title="Overdue">
                <Warning size={12} weight="bold" /> overdue
              </span>
            )}
            {t.due && (
              <span className="task-due" title={t.due}>
                {formatDate(parseISODate(t.due), dateFormat)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
