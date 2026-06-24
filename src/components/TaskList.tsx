import { ArrowsClockwise, Warning, Flag } from "@phosphor-icons/react";
import { formatDate, parseISODate } from "../dateformat";
import { inlineMd } from "../markdown";

/** Display label + ordering weight for a priority level. Higher weight = more urgent (sorts first). */
export const PRIORITY_META: Record<string, { label: string; weight: number }> = {
  high: { label: "High", weight: 3 },
  medium: { label: "Medium", weight: 2 },
  low: { label: "Low", weight: 1 },
};

/** A normalized task for display. Both the Tasks panel and inline TASK queries map onto this. */
export interface TaskItem {
  text: string;
  due: string | null;
  done: boolean;
  rel_path: string;
  /** 0-based line index of the source task in its page body (for write-back). */
  line: number;
  /** Nesting level by indentation: 0 = top-level, 1 = subtask, … Used to indent the row. */
  depth?: number;
  /** `line` of the enclosing task, or null for a top-level task. */
  parent_line?: number | null;
  /** Rendered as a faint, non-interactive ancestor shown only to give a matched subtask context. */
  contextOnly?: boolean;
  /** Leading `#tags` on the task line (without the `#`). */
  tags: string[];
  /** Priority level (`high`/`medium`/`low`) from a `priority:: …` field, or null/undefined. */
  priority?: string | null;
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
  /** Open the task's source page (click on the text), scrolling to and flashing its row via the
   *  task's body `line`. Omit to render non-interactive. */
  onOpen?: (relPath: string, line?: number) => void;
  /** Open a page by its `[[wikilink]]` name (click on a wikilink in the task text). */
  onOpenName?: (name: string) => void;
  /**
   * Toggle a task's done state (click the checkbox). Receives the row so the caller can pass its
   * line + occurrence to the backend. Omit to render checkboxes read-only.
   */
  onToggle?: (task: TaskItem) => void;
  /** Today, for overdue styling. Defaults to the current day. */
  today?: Date;
  /** Empty-state copy. */
  emptyMessage?: string;
  /** Right-click a row (e.g. to set priority or reschedule). Receives the row and the pointer event. */
  onContextMenu?: (task: TaskItem, e: React.MouseEvent) => void;
}

/** True when a real (non-virtual), open task's due date is before today. */
function isOverdue(t: TaskItem, today: Date): boolean {
  if (t.done || t.virtual || !t.due) return false;
  return parseISODate(t.due).getTime() < today.getTime();
}

/**
 * Task text rendered with the same inline markdown as the editor (bold, code, links, images,
 * `[[wikilinks]]`) so the list never shows raw `**`/`[[ ]]`/`[ ]( )` markup. Clicks are delegated:
 * a wikilink (`[data-page-link]`) opens that page by name; a regular link is neutralized and falls
 * through to opening the task's own source page (we don't navigate the webview away).
 */
function TaskText({
  text,
  title,
  onOpenSource,
  onOpenName,
}: {
  text: string;
  title?: string;
  onOpenSource?: () => void;
  onOpenName?: (name: string) => void;
}) {
  const html = text.trim() ? inlineMd(text) : "<span class='task-untitled'>(untitled task)</span>";
  const onClick = (e: React.MouseEvent<HTMLSpanElement>) => {
    const link = (e.target as HTMLElement).closest(`[${PAGE_LINK_ATTR}]`);
    if (link) {
      e.stopPropagation();
      onOpenName?.(link.getAttribute(PAGE_LINK_ATTR) ?? "");
      return;
    }
    // Regular `<a>` markdown link: don't let the webview navigate; treat as opening the source page.
    const anchor = (e.target as HTMLElement).closest("a");
    if (anchor) e.preventDefault();
    onOpenSource?.();
  };
  return (
    <span
      className={`task-text${onOpenSource ? " linkable" : ""}`}
      onClick={onClick}
      title={title}
      // Inline markdown only (no block tags); produced by the editor's own serializer.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Class applied to a wikilink span by `inlineMd` output, so we can find it for the open handler. */
const PAGE_LINK_ATTR = "data-page-link";

/**
 * A consistent task-row list, shared by the standalone Tasks panel and inline TASK query blocks so
 * tasks look the same everywhere: a checkbox, the task text, a recurring/overdue badge, an "ahead"
 * tag for virtual occurrences, and a right-aligned due date.
 */
export default function TaskList({ tasks, dateFormat, onOpen, onOpenName, onToggle, today, emptyMessage, onContextMenu }: Props) {
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
        const depth = t.depth ?? 0;
        const interactive = !!onToggle && !t.contextOnly;
        return (
          <div
            key={`${t.rel_path}:${t.line}:${t.occurrence ?? ""}:${i}`}
            className={`task-row${t.done ? " done" : ""}${t.virtual ? " virtual" : ""}${
              overdue ? " overdue" : ""
            }${t.contextOnly ? " context" : ""}${depth ? " nested" : ""}`}
            style={depth ? { marginLeft: `calc(var(--sp-5) * ${depth})` } : undefined}
            onContextMenu={
              onContextMenu && !t.contextOnly ? (e) => onContextMenu(t, e) : undefined
            }
          >
            <input
              type="checkbox"
              checked={t.done}
              onChange={interactive ? () => onToggle!(t) : undefined}
              readOnly={!interactive}
              disabled={t.contextOnly}
              tabIndex={interactive ? 0 : -1}
              title={interactive ? "Toggle done" : undefined}
            />
            <TaskText
              text={t.text}
              title={onOpen ? t.rel_path : undefined}
              onOpenSource={onOpen ? () => onOpen(t.rel_path, t.line) : undefined}
              onOpenName={onOpenName}
            />
            {t.priority && PRIORITY_META[t.priority] && (
              <span
                className={`task-priority prio-${t.priority}`}
                title={`${PRIORITY_META[t.priority].label} priority`}
              >
                <Flag size={12} weight="fill" />
                {PRIORITY_META[t.priority].label}
              </span>
            )}
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
