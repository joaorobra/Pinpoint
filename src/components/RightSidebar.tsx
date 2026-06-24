import { useEffect, useMemo, useState } from "react";
import {
  ListBullets,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  NotePencil,
  CheckCircle,
  Circle,
  Flag,
} from "@phosphor-icons/react";
import { pathFor, template, labelFor, step, type Period } from "../periodic";
import { api } from "../api";
import { formatDate } from "../dateformat";
import { stripTaskMeta, inlineMd } from "../markdown";
import type { TaskRow } from "../types";

type RightTab = "hierarchy" | "calendar";

/** The non-daily periods shown in the Periods tab (daily lives in the Calendar tab). */
const PERIOD_TABS: { period: Period; label: string }[] = [
  { period: "weekly", label: "Week" },
  { period: "monthly", label: "Month" },
  { period: "quarterly", label: "Quarter" },
  { period: "semestral", label: "Semester" },
  { period: "yearly", label: "Year" },
];

interface Props {
  /** Markdown body of the currently open page, for the heading outline. */
  body: string;
  /** Whether a markdown page is currently open (vs. an asset / nothing). */
  hasPage: boolean;
  /** Scroll the editor to the given heading (matched by its text + level). */
  onJumpToHeading: (heading: Heading) => void;
  /** Periodic-notes config, mirrored from settings, used by the calendar. */
  periodicFolder: string;
  dailyFormat: string;
  /** rel_path of the day's daily note that is currently open, for highlighting. */
  activePath: string | null;
  /** Set of existing markdown page rel_paths, so the calendar can mark days that already have a note. */
  existingPaths: Set<string>;
  /** Open (creating if missing) the daily note for a clicked calendar day. `period`/`date` let the
   *  host apply that period's bound template (with {{period}} tokens) when creating the note. */
  onOpenPeriodic: (relPath: string, fallbackBody: string, period?: Period, date?: Date) => void;
  /** Open an existing page (used by the agenda to jump to a task's source). */
  onOpenPath: (relPath: string) => void;
  /** Open a page by its `[[wikilink]]` name (clicking a wikilink inside an agenda task). */
  onOpenName: (name: string) => void;
  /** Bumped when tasks/pages change, so the calendar agenda re-fetches. */
  taskRefresh: number;
}

export interface Heading {
  /** 1–6, from the number of leading `#`. */
  level: number;
  /** Heading text with the `#` markers stripped. */
  text: string;
  /** Line index (0-based) of the heading in the body, used as a stable key. */
  line: number;
  /** 0-based position of this heading among ALL headings — its index in the rendered <h*> set. */
  ordinal: number;
}

/** Parse ATX (`#`-prefixed) headings out of a markdown body, skipping fenced code blocks. */
function parseHeadings(body: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m) {
      out.push({ level: m[1].length, text: m[2].replace(/#+\s*$/, "").trim(), line: i, ordinal: out.length });
    }
  }
  return out;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export default function RightSidebar({
  body,
  hasPage,
  onJumpToHeading,
  periodicFolder,
  dailyFormat,
  activePath,
  existingPaths,
  onOpenPeriodic,
  onOpenPath,
  onOpenName,
  taskRefresh,
}: Props) {
  const [tab, setTab] = useState<RightTab>("hierarchy");

  const headings = useMemo(() => (hasPage ? parseHeadings(body) : []), [body, hasPage]);
  // Smallest heading level present, so the outline can indent relative to its top level.
  const minLevel = useMemo(
    () => headings.reduce((m, h) => Math.min(m, h.level), 6),
    [headings]
  );

  return (
    <aside className="right-sidebar">
      <div className="right-tabs">
        <button
          className={tab === "hierarchy" ? "active" : ""}
          onClick={() => setTab("hierarchy")}
          title="Hierarchy index"
        >
          <ListBullets size={15} weight="bold" /> Hierarchy
        </button>
        <button
          className={tab === "calendar" ? "active" : ""}
          onClick={() => setTab("calendar")}
          title="My calendar"
        >
          <CalendarBlank size={15} weight="bold" /> Calendar
        </button>
      </div>

      <div className="right-content">
        {tab === "hierarchy" &&
          (!hasPage ? (
            <div className="right-empty">Open a page to see its outline.</div>
          ) : headings.length === 0 ? (
            <div className="right-empty">No headings on this page.</div>
          ) : (
            <ul className="outline">
              {headings.map((h) => (
                <li
                  key={h.line}
                  className={`outline-item h${h.level}`}
                  style={{ paddingLeft: `${(h.level - minLevel) * 14 + 8}px` }}
                  title={h.text}
                  onClick={() => onJumpToHeading(h)}
                >
                  {h.text}
                </li>
              ))}
            </ul>
          ))}

        {tab === "calendar" && (
          <Calendar
            periodicFolder={periodicFolder}
            dailyFormat={dailyFormat}
            activePath={activePath}
            existingPaths={existingPaths}
            onOpenPeriodic={onOpenPeriodic}
            onOpenPath={onOpenPath}
            onOpenName={onOpenName}
            taskRefresh={taskRefresh}
          />
        )}
      </div>
    </aside>
  );
}

/**
 * The non-daily periodic notes (week → year). Each row is a period kind with prev/next navigation
 * around an anchor date and a button that opens (or creates) that period's note. A subtle dot marks
 * rows whose note already exists; the open note is outlined.
 */
function Periods({
  periodicFolder,
  dailyFormat,
  activePath,
  existingPaths,
  onOpenPeriodic,
}: Pick<Props, "periodicFolder" | "dailyFormat" | "activePath" | "existingPaths" | "onOpenPeriodic">) {
  // One shared anchor for all rows; prev/next steps it per the row's own period unit.
  const [anchors, setAnchors] = useState<Record<Period, Date>>(() => {
    const now = new Date();
    return {
      daily: now, weekly: now, monthly: now, quarterly: now, semestral: now, yearly: now,
    };
  });

  const stepAnchor = (period: Period, dir: 1 | -1) =>
    setAnchors((prev) => ({ ...prev, [period]: step(period, prev[period], dir) }));

  return (
    <div className="periods">
      <div className="periods-title">Periodic notes</div>
      {PERIOD_TABS.map(({ period, label }) => {
        const anchor = anchors[period];
        const path = pathFor(periodicFolder, period, anchor);
        const hasNote = existingPaths.has(path);
        const isOpen = activePath === path;
        return (
          <div key={period} className="period-row">
            <div className="period-kind">{label}</div>
            <div className="period-nav">
              <button
                className="cal-nav"
                onClick={() => stepAnchor(period, -1)}
                title={`Previous ${label.toLowerCase()}`}
              >
                <CaretLeft size={13} weight="bold" />
              </button>
              <button
                className={"period-label" + (hasNote ? " has-note" : "") + (isOpen ? " open" : "")}
                onClick={() => onOpenPeriodic(path, template(period, anchor, dailyFormat), period, anchor)}
                title={hasNote ? "Open note" : "Create note"}
              >
                {labelFor(period, anchor, dailyFormat)}
              </button>
              <button
                className="cal-nav"
                onClick={() => stepAnchor(period, 1)}
                title={`Next ${label.toLowerCase()}`}
              >
                <CaretRight size={13} weight="bold" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Local-time ISO date key (YYYY-MM-DD) for a Date, matching how task `due` strings are stored. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function Calendar({
  periodicFolder,
  dailyFormat,
  activePath,
  existingPaths,
  onOpenPeriodic,
  onOpenPath,
  onOpenName,
  taskRefresh,
}: Pick<
  Props,
  "periodicFolder" | "dailyFormat" | "activePath" | "existingPaths" | "onOpenPeriodic" | "onOpenPath" | "onOpenName" | "taskRefresh"
>) {
  // The month being viewed (anchored to its first day). Date.now() is fine in the webview runtime.
  const [view, setView] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  // The day whose agenda is shown below the grid. Defaults to today.
  const [selected, setSelected] = useState<Date>(() => new Date());

  // All tasks in the vault, re-fetched whenever pages/tasks change. Indexed by due-date below.
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  useEffect(() => {
    api.listTasks().then(setTasks).catch(() => setTasks([]));
  }, [taskRefresh]);

  // Map a day-key → tasks due that day, so cells can show a load indicator and the agenda can list them.
  const tasksByDay = useMemo(() => {
    const m = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      if (!t.due) continue;
      const key = t.due.slice(0, 10); // tolerate trailing time, keep YYYY-MM-DD
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(t);
    }
    return m;
  }, [tasks]);

  const today = new Date();
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  // Whether the viewed month is the real current month (drives the "Today" shortcut visibility).
  const viewingThisMonth =
    view.getFullYear() === today.getFullYear() && view.getMonth() === today.getMonth();
  const jumpToToday = () => {
    setView(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelected(new Date());
  };

  // Build the 6-row grid: leading blanks (Mon-start), the month's days, trailing blanks.
  const cells = useMemo<(Date | null)[]>(() => {
    const year = view.getFullYear();
    const month = view.getMonth();
    const first = new Date(year, month, 1);
    // Convert Sun-based getDay() to a Monday-based offset (Mon=0 … Sun=6).
    const lead = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(new Date(year, month, d));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [view]);

  const openDay = (day: Date) => {
    const path = pathFor(periodicFolder, "daily", day);
    onOpenPeriodic(path, template("daily", day, dailyFormat), "daily", day);
  };

  // Clicking a day selects it (updating the agenda) and jumps the month if needed; a click on an
  // already-selected day opens/creates its note.
  const clickDay = (day: Date) => {
    if (isSameDay(day, selected)) openDay(day);
    else setSelected(day);
  };

  // Arrow-key navigation across the grid: move the selection by ±1 day / ±1 week, paging the
  // viewed month when the selection crosses its edge. Enter/Space opens the selected day.
  const onGridKey = (e: React.KeyboardEvent) => {
    const deltas: Record<string, number> = {
      ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7,
    };
    if (e.key in deltas) {
      e.preventDefault();
      const next = new Date(selected);
      next.setDate(next.getDate() + deltas[e.key]);
      setSelected(next);
      if (next.getMonth() !== view.getMonth() || next.getFullYear() !== view.getFullYear()) {
        setView(new Date(next.getFullYear(), next.getMonth(), 1));
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDay(selected);
    }
  };

  // Agenda for the selected day, in two sections (done sorted last within each):
  //  • "Due today"   — tasks whose due date is this day, from anywhere in the vault.
  //  • "In this note"— every task that lives inside this day's daily note, regardless of due date,
  //                    minus those already listed above (a task both due-today and in the note shows once).
  const selectedKey = dayKey(selected);
  const selectedPath = pathFor(periodicFolder, "daily", selected);
  const selectedHasNote = existingPaths.has(selectedPath);
  const { dueTasks, pageTasks } = useMemo(() => {
    const byDone = (a: TaskRow, b: TaskRow) => Number(a.done) - Number(b.done);
    // "Due today" is pulled from across pages by due date — there's no coherent tree, so it stays a
    // flat list with done last and no indentation.
    const dueTasks = [...(tasksByDay.get(selectedKey) ?? [])]
      .sort(byDone)
      .map((t) => ({ task: t, depth: 0 }));
    const dueKeys = new Set(dueTasks.map((d) => `${d.task.rel_path}:${d.task.line}`));
    // "In this note" is one page's tasks — keep document order (by source line) so the parent→child
    // hierarchy reads top-to-bottom, and indent each row by its nesting depth re-based to the
    // shallowest visible task (so indentation always starts at the gutter even if no top-level task
    // is present). Done-sorting would scatter children away from parents, so we don't sort here.
    const inNote = tasks
      .filter((t) => t.rel_path === selectedPath && !dueKeys.has(`${t.rel_path}:${t.line}`))
      .sort((a, b) => a.line - b.line);
    const base = inNote.reduce((min, t) => Math.min(min, t.depth ?? 0), Infinity);
    const norm = Number.isFinite(base) ? base : 0;
    const pageTasks = inNote.map((t) => ({ task: t, depth: (t.depth ?? 0) - norm }));
    return { dueTasks, pageTasks };
  }, [tasks, tasksByDay, selectedKey, selectedPath]);
  const agendaCount = dueTasks.length + pageTasks.length;

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button
          className="cal-nav"
          onClick={() => setView((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
          title="Previous month"
        >
          <CaretLeft size={14} weight="bold" />
        </button>
        <button
          className="cal-title"
          onClick={jumpToToday}
          title="Jump to today"
        >
          {MONTHS[view.getMonth()]} {view.getFullYear()}
        </button>
        <button
          className="cal-nav"
          onClick={() => setView((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
          title="Next month"
        >
          <CaretRight size={14} weight="bold" />
        </button>
        {/* "Today" appears only when you've navigated away — a one-click way back, with no clutter
            while you're already on the current month. */}
        {!viewingThisMonth && (
          <button className="cal-today-btn" onClick={jumpToToday} title="Back to today">
            Today
          </button>
        )}
      </div>

      <div
        className="calendar-grid"
        role="grid"
        aria-label="Month calendar"
        tabIndex={0}
        onKeyDown={onGridKey}
      >
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-weekday">
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`b${i}`} className="cal-day empty" />;
          const path = pathFor(periodicFolder, "daily", day);
          const hasPage = existingPaths.has(path);
          const isOpen = activePath === path;
          const dayTasks = tasksByDay.get(dayKey(day)) ?? [];
          const openCount = dayTasks.filter((t) => !t.done).length;
          return (
            <button
              key={day.getTime()}
              className={
                "cal-day" +
                (isSameDay(day, today) ? " today" : "") +
                (isSameDay(day, selected) ? " selected" : "") +
                (hasPage ? " has-page" : "") +
                (isOpen ? " open" : "")
              }
              onClick={() => clickDay(day)}
              onDoubleClick={() => openDay(day)}
              title={hasPage ? "Open daily note" : "Create daily note"}
              role="gridcell"
              tabIndex={-1}
              aria-selected={isSameDay(day, selected)}
              aria-current={isSameDay(day, today) ? "date" : undefined}
              aria-label={
                `${day.getDate()} ${MONTHS[day.getMonth()]}` +
                (openCount > 0 ? `, ${openCount} open task${openCount > 1 ? "s" : ""}` : "") +
                (hasPage ? ", has note" : "")
              }
            >
              <span className="cal-day-num">{day.getDate()}</span>
              {/* Subtle load indicator: a count of open tasks due this day (if any). */}
              {openCount > 0 && <span className="cal-day-tasks">{openCount}</span>}
            </button>
          );
        })}
      </div>

      {/* Agenda for the selected day, filling the space below the grid. */}
      <div className="cal-agenda">
        <button
          className="cal-agenda-head"
          onClick={() => openDay(selected)}
          title={selectedHasNote ? "Open daily note" : "Create daily note"}
        >
          <span className="cal-agenda-date">
            {labelForDay(selected, dailyFormat)}
            {agendaCount > 0 && (
              <span className="cal-agenda-count">{agendaCount}</span>
            )}
          </span>
          <span className={"cal-agenda-open" + (selectedHasNote ? " exists" : "")}>
            <NotePencil size={14} weight="bold" />
            {selectedHasNote ? "Open" : "New note"}
          </span>
        </button>
        {agendaCount === 0 ? (
          <button className="cal-agenda-empty" onClick={() => openDay(selected)}>
            No tasks — open this day’s note
          </button>
        ) : (
          <div className="cal-agenda-sections">
            {dueTasks.length > 0 && (
              <AgendaSection
                // Only label the sections when both are present — otherwise the single list speaks
                // for itself and a lone header is just noise.
                label={pageTasks.length > 0 ? "Due today" : undefined}
                tasks={dueTasks}
                onOpenPath={onOpenPath}
                onOpenName={onOpenName}
              />
            )}
            {pageTasks.length > 0 && (
              <AgendaSection
                label={dueTasks.length > 0 ? "In this note" : undefined}
                tasks={pageTasks}
                onOpenPath={onOpenPath}
                onOpenName={onOpenName}
              />
            )}
          </div>
        )}
      </div>

      {/* Other periodic notes (week → year), below the month calendar. */}
      <Periods
        periodicFolder={periodicFolder}
        dailyFormat={dailyFormat}
        activePath={activePath}
        existingPaths={existingPaths}
        onOpenPeriodic={onOpenPeriodic}
      />
    </div>
  );
}

/** One labelled list of agenda tasks (a "Due today" or "In this note" section). The label is omitted
 *  when only one section is shown, so a single list renders headerless as before. */
function AgendaSection({
  label,
  tasks,
  onOpenPath,
  onOpenName,
}: {
  label?: string;
  /** Each row carries its (re-based) nesting depth so children indent under their parent. */
  tasks: { task: TaskRow; depth: number }[];
  onOpenPath: (relPath: string) => void;
  onOpenName: (name: string) => void;
}) {
  return (
    <div className="cal-agenda-section">
      {label && <div className="cal-agenda-section-label">{label}</div>}
      <ul className="cal-agenda-list">
        {tasks.map(({ task: t, depth }, i) => (
          <li
            key={t.rel_path + ":" + t.line + ":" + i}
            className={"cal-agenda-task" + (t.done ? " done" : "") + (depth ? " nested" : "")}
            style={depth ? { marginLeft: `calc(var(--sp-4) * ${depth})` } : undefined}
            title={t.rel_path}
            onClick={() => onOpenPath(t.rel_path)}
          >
            {t.done ? <CheckCircle size={14} weight="fill" /> : <Circle size={14} />}
            {/* Body: task text with #tags flowing inline right after it (wrapping with the text). The
                priority flag is a row-level element after the body, pushed to the far right edge. */}
            <span className="cal-agenda-body">
              <AgendaText
                text={t.text}
                onOpenSource={() => onOpenPath(t.rel_path)}
                onOpenName={onOpenName}
              />
              {(t.tags ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((tag) => (
                  <span key={tag} className="cal-agenda-tag">
                    #{tag}
                  </span>
                ))}
            </span>
            {t.priority && (
              <Flag size={12} weight="fill" className={`cal-agenda-flag prio-${t.priority}`} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Class `inlineMd` tags a `[[wikilink]]` span with, so a click can resolve it to a page name. */
const PAGE_LINK_ATTR = "data-page-link";

/**
 * Agenda task text rendered with the editor's inline markdown (bold, code, links, images,
 * `[[wikilinks]]`) so the agenda never shows raw `**`/`[[ ]]`/`[ ]( )` markup — mirrors TaskList's
 * `TaskText`. Clicks are delegated: a wikilink opens that page by name; any other click (incl. a
 * regular markdown link, which we neutralize) opens the task's own source page.
 */
function AgendaText({
  text,
  onOpenSource,
  onOpenName,
}: {
  text: string;
  onOpenSource: () => void;
  onOpenName: (name: string) => void;
}) {
  const stripped = stripTaskMeta(text);
  const html = stripped.trim()
    ? inlineMd(stripped)
    : "<span class='task-untitled'>(untitled task)</span>";
  const onClick = (e: React.MouseEvent<HTMLSpanElement>) => {
    const link = (e.target as HTMLElement).closest(`[${PAGE_LINK_ATTR}]`);
    if (link) {
      e.stopPropagation();
      onOpenName(link.getAttribute(PAGE_LINK_ATTR) ?? "");
      return;
    }
    const anchor = (e.target as HTMLElement).closest("a");
    if (anchor) e.preventDefault();
    onOpenSource();
  };
  return (
    <span
      className="cal-agenda-text"
      onClick={onClick}
      // Inline markdown only (no block tags); produced by the editor's own serializer.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** A human date for the agenda header, using the user's daily-note format when available. */
function labelForDay(d: Date, fmt?: string): string {
  return fmt ? formatDate(d, fmt) : d.toDateString();
}
