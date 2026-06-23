import { useEffect, useMemo, useRef, useState } from "react";
import {
  MagnifyingGlass,
  X,
  Funnel,
  ListBullets,
  SortAscending,
  Stack,
  CalendarBlank,
  CheckCircle,
  Circle,
  Warning,
} from "@phosphor-icons/react";
import { api } from "../api";
import type { TaskRow } from "../types";
import { upcoming } from "../recurrence";
import { parseISODate, formatDate } from "../dateformat";
import { labelFor, periodRange, pathFor, template, type Period } from "../periodic";
import { stripTaskMeta } from "../markdown";
import TaskList, { type TaskItem } from "./TaskList";
import TaskActionMenu, { type SendTarget } from "./TaskActionMenu";
import { toast } from "./Toast";
import Select from "./Select";

interface Props {
  onOpen: (relPath: string) => void;
  /** Open a page by `[[wikilink]]` name (clicking a wikilink in a task's text). */
  onOpenName?: (name: string) => void;
  refreshKey: number;
  /** Pattern for rendering due dates (see dateformat.ts). */
  dateFormat: string;
  /** Vault folder holding periodic notes (for "Send to another period"). */
  periodicFolder: string;
  /** dateformat pattern for daily-note labels (used when creating a destination daily note). */
  dailyFormat: string;
  /** Bumped after a task mutation so other task surfaces (editor, sidebar) refresh too. */
  onChanged?: () => void;
}

/** Open-task status filter. */
type StatusFilter = "all" | "open" | "done" | "overdue";
/** How rows are bucketed into groups. */
type GroupBy = "tag" | "due" | "status" | "page" | "none";
/** Row ordering within each group. */
type SortBy = "due-asc" | "due-desc" | "alpha";
/**
 * When a flat group contains parent tasks that have children, what the active task-sort applies to:
 * - "all": sort parents, and recursively sort each parent's children (hierarchy preserved).
 * - "parents": sort only the top-level rows; children keep their document order under each parent.
 * - "children": parents keep document order; only children are sorted under each parent.
 * Asked the first time you sort a view that actually has nested tasks (otherwise it's irrelevant).
 */
type SortScope = "all" | "parents" | "children";
/**
 * Ordering of the groups themselves. "default" keeps each grouping's natural order (the due/status
 * buckets stay in their semantic sequence; tag/page fall back to A→Z) — the behaviour before group
 * sorting existed.
 */
type GroupSort = "default" | "name-asc" | "name-desc" | "count-desc" | "count-asc" | "due-asc";
/**
 * When grouping by Due date, the granularity of each bucket. "smart" is the original coarse split
 * (Overdue / Today / This week / Later); the others bucket per calendar day / ISO week / month, like
 * the calendar view, ordered chronologically with overdue pulled to the top and "No date" last.
 */
type DuePeriod = "smart" | "day" | "week" | "month";

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "overdue", label: "Overdue" },
];
const GROUP_OPTIONS = [
  { value: "tag", label: "Tag" },
  { value: "due", label: "Due date" },
  { value: "status", label: "Status" },
  { value: "page", label: "Page" },
  { value: "none", label: "None" },
];
const SORT_OPTIONS = [
  { value: "due-asc", label: "Due ↑ (soonest)" },
  { value: "due-desc", label: "Due ↓ (latest)" },
  { value: "alpha", label: "A → Z" },
];
const SORT_SCOPE_OPTIONS = [
  { value: "all", label: "Sort ALL (keep hierarchy)" },
  { value: "parents", label: "Parents only" },
  { value: "children", label: "Children only" },
];
const GROUP_SORT_OPTIONS = [
  { value: "default", label: "Default order" },
  { value: "name-asc", label: "Name A → Z" },
  { value: "name-desc", label: "Name Z → A" },
  { value: "count-desc", label: "Most tasks" },
  { value: "count-asc", label: "Fewest tasks" },
  { value: "due-asc", label: "Soonest due" },
];
const DUE_PERIOD_OPTIONS = [
  { value: "smart", label: "Smart (Overdue / Today / …)" },
  { value: "day", label: "By day" },
  { value: "week", label: "By week" },
  { value: "month", label: "By month" },
];

/** Start-of-today, memo-friendly (recomputed only when rows change). */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function isOverdue(t: TaskItem, today: Date): boolean {
  if (t.done || t.virtual || !t.due) return false;
  return parseISODate(t.due).getTime() < today.getTime();
}

/** Human bucket for a due date relative to today: Overdue / Today / This week / Later / No date. */
function dueBucket(t: TaskItem, today: Date): string {
  if (!t.due) return "No date";
  const due = parseISODate(t.due).getTime();
  const day = 86400000;
  if (due < today.getTime()) return "Overdue";
  if (due < today.getTime() + day) return "Today";
  if (due < today.getTime() + day * 7) return "This week";
  return "Later";
}
/** Stable display order for the due buckets above. */
const DUE_ORDER = ["Overdue", "Today", "This week", "Later", "No date"];

/**
 * Bucket a task into a calendar period (day / week / month) by its due date, like the calendar view.
 * Returns a `{ key, label }`: `key` sorts the groups chronologically — overdue (any past-due,
 * still-open task) is forced to the very top and "No date" to the very bottom; dated periods sort by
 * their start ISO in between. `label` is the human heading (week/month reuse periodic.ts wording so
 * they read identically to periodic notes; days honour the user's date format).
 *
 * `period` is assumed non-"smart"; the smart split stays in `dueBucket`.
 */
function duePeriodBucket(
  t: TaskItem,
  today: Date,
  period: Exclude<DuePeriod, "smart">,
  dateFormat: string
): { key: string; label: string } {
  if (!t.due) return { key: "2", label: "No date" };
  // Past-due, still-open tasks collapse into one leading "Overdue" group regardless of granularity —
  // matches the requested "overdue first" ordering and mirrors the smart split's Overdue bucket.
  if (isOverdue(t, today)) return { key: "0", label: "Overdue" };
  const due = parseISODate(t.due);
  if (period === "day") {
    // Sort by the ISO date itself; show it in the user's configured day format.
    return { key: `1|${t.due}`, label: formatDate(due, dateFormat) };
  }
  // Week / month: bucket by the period's start date so every day in the period shares one key/label.
  const start = periodRange(period === "week" ? "weekly" : "monthly", due).start;
  return { key: `1|${start}`, label: labelFor(period === "week" ? "weekly" : "monthly", due) };
}

/** Display name for a page path: its leaf, without the `.md` extension. */
function pageName(relPath: string): string {
  return (relPath.split("/").pop() ?? relPath).replace(/\.md$/i, "");
}

/**
 * Persist the Tasks toolbar (search/filter/group/sort) in localStorage so leaving the page and
 * coming back restores the same view. Mirrors App.tsx's `pp.`-prefixed UI-state convention.
 */
const TASKS_STATE_KEY = "pp.tasksView";
interface TasksState {
  query: string;
  status: StatusFilter;
  activeTags: string[];
  groupBy: GroupBy;
  sortBy: SortBy;
  sortScope: SortScope;
  groupSort: GroupSort;
  duePeriod: DuePeriod;
  showAhead: boolean;
}
function loadTasksState(): Partial<TasksState> {
  try {
    const raw = localStorage.getItem(TASKS_STATE_KEY);
    return raw ? (JSON.parse(raw) as Partial<TasksState>) : {};
  } catch {
    return {};
  }
}

/** Identity of a real task within the vault: its page + source line. */
function taskKey(t: TaskItem): string {
  return `${t.rel_path}:${t.line}`;
}

/**
 * Rebuild the parent→child tree for one bucket of matched tasks (used when grouping by Page/None,
 * where a page's tasks stay in document order).
 *
 * For every matched row we walk its `parent_line` chain via `byKey`; any ancestor that wasn't itself
 * matched is re-introduced as a faint `contextOnly` row so a deep subtask never renders orphaned.
 * Rows are emitted depth-first in document order, and each row's `depth` is re-based to the shallowest
 * depth visible in the bucket so indentation always starts at the left edge.
 */
function nestRows(items: TaskItem[], matchedKeys: Set<string>, byKey: Map<string, TaskItem>): TaskItem[] {
  // Render every matched row as-is (a recurring task contributes several rows sharing one line, so we
  // must not dedup them by key). Track which task keys are already present so we don't double-add an
  // ancestor that also matched.
  const present = new Set(items.map(taskKey));
  // Injected ancestors, deduped by key — these are the faint context rows pulled in above matches.
  const ancestors = new Map<string, TaskItem>();
  for (const t of items) {
    let parentLine = t.parent_line;
    let guard = 0;
    while (parentLine != null && guard++ < 100) {
      const pk = `${t.rel_path}:${parentLine}`;
      const parent = byKey.get(pk);
      if (!parent) break;
      if (!present.has(pk) && !ancestors.has(pk))
        ancestors.set(pk, { ...parent, contextOnly: !matchedKeys.has(pk) });
      parentLine = parent.parent_line;
    }
  }

  // Group the rows by page, then within each page emit them in document order with depth re-based to
  // that page's shallowest visible task — so indentation always starts at the gutter even when only a
  // deep subtask matched. Pages are ordered by path for a stable layout.
  const byPage = new Map<string, TaskItem[]>();
  for (const r of [...items, ...ancestors.values()]) {
    if (!byPage.has(r.rel_path)) byPage.set(r.rel_path, []);
    byPage.get(r.rel_path)!.push(r);
  }
  const out: TaskItem[] = [];
  for (const [, pageRows] of [...byPage.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    pageRows.sort((a, b) => a.line - b.line);
    const base = pageRows.reduce((min, r) => Math.min(min, r.depth ?? 0), Infinity);
    const norm = Number.isFinite(base) ? base : 0;
    for (const r of pageRows) out.push({ ...r, depth: (r.depth ?? 0) - norm });
  }
  return out;
}

/** Compare two rows by the active task-sort (A→Z, or due ascending/descending). */
function sortCmp(a: TaskItem, b: TaskItem, sortBy: SortBy): number {
  if (sortBy === "alpha") return a.text.localeCompare(b.text);
  const cmp = (a.due ?? "9999").localeCompare(b.due ?? "9999");
  return sortBy === "due-desc" ? -cmp : cmp;
}

/**
 * True when a bucket of matched rows contains at least one parent that also has a child present in
 * the same bucket — i.e. sorting could scatter a child away from its parent, so the parent/child
 * scope choice is meaningful. (Within one flat group both rows share the group key, so a parent and
 * its matched child can co-occur even though the grouping itself isn't hierarchical.)
 */
function bucketHasNesting(items: TaskItem[]): boolean {
  const lines = new Set(items.map((t) => t.line));
  return items.some((t) => t.parent_line != null && lines.has(t.parent_line));
}

/**
 * Sort one flat bucket while keeping the parent→child tree intact, honoring `scope`:
 *  - "all":      sort top-level rows, and recursively sort each parent's children.
 *  - "parents":  sort top-level rows; children keep document order under their parent.
 *  - "children": top-level rows keep document order; only children are sorted under each parent.
 *
 * The bucket's rows are reassembled into a forest by `parent_line` (rows whose parent isn't in the
 * bucket become roots), each row's depth is re-based to the shallowest visible row so indentation
 * starts at the gutter, then the forest is flattened depth-first. A bucket with no nesting just sorts
 * flat at depth 0, exactly as before.
 */
function flatSorted(items: TaskItem[], sortBy: SortBy, scope: SortScope): TaskItem[] {
  // Children indexed by parent line; roots are rows whose parent isn't present in this bucket.
  const lines = new Set(items.map((t) => t.line));
  const childrenOf = new Map<number, TaskItem[]>();
  const roots: TaskItem[] = [];
  for (const t of items) {
    const p = t.parent_line;
    if (p != null && lines.has(p)) {
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p)!.push(t);
    } else {
      roots.push(t);
    }
  }

  const sortRoots = scope === "all" || scope === "parents";
  const sortKids = scope === "all" || scope === "children";
  if (sortRoots) roots.sort((a, b) => sortCmp(a, b, sortBy));

  // Re-base depth so the shallowest visible row sits at the gutter (matches nestRows' behaviour).
  const base = items.reduce((min, r) => Math.min(min, r.depth ?? 0), Infinity);
  const norm = Number.isFinite(base) ? base : 0;

  const out: TaskItem[] = [];
  const emit = (t: TaskItem) => {
    out.push({ ...t, depth: (t.depth ?? 0) - norm });
    const kids = childrenOf.get(t.line);
    if (!kids) return;
    const ordered = sortKids ? [...kids].sort((a, b) => sortCmp(a, b, sortBy)) : kids;
    for (const k of ordered) emit(k);
  };
  for (const r of roots) emit(r);
  return out;
}

export default function TasksView({ onOpen, onOpenName, refreshKey, dateFormat, periodicFolder, dailyFormat, onChanged }: Props) {
  // Restored toolbar state from the last visit (so navigating away and back keeps the same view).
  const saved = useRef(loadTasksState()).current;

  const [rows, setRows] = useState<TaskRow[]>([]);
  const [showAhead, setShowAhead] = useState(saved.showAhead ?? true);
  const [localRefresh, setLocalRefresh] = useState(0);

  // Toolbar state.
  const [query, setQuery] = useState(saved.query ?? "");
  const [status, setStatus] = useState<StatusFilter>(saved.status ?? "all");
  const [activeTags, setActiveTags] = useState<string[]>(saved.activeTags ?? []);
  const [groupBy, setGroupBy] = useState<GroupBy>(saved.groupBy ?? "tag");
  const [sortBy, setSortBy] = useState<SortBy>(saved.sortBy ?? "due-asc");
  const [sortScope, setSortScope] = useState<SortScope>(saved.sortScope ?? "all");
  const [groupSort, setGroupSort] = useState<GroupSort>(saved.groupSort ?? "default");
  const [duePeriod, setDuePeriod] = useState<DuePeriod>(saved.duePeriod ?? "smart");
  const [openPop, setOpenPop] = useState<null | "filter" | "group" | "sort" | "groupSort" | "duePeriod">(null);

  // Persist toolbar state whenever any part of it changes.
  useEffect(() => {
    const state: TasksState = { query, status, activeTags, groupBy, sortBy, sortScope, groupSort, duePeriod, showAhead };
    try {
      localStorage.setItem(TASKS_STATE_KEY, JSON.stringify(state));
    } catch {
      /* storage may be unavailable; restoring is best-effort */
    }
  }, [query, status, activeTags, groupBy, sortBy, sortScope, groupSort, duePeriod, showAhead]);

  const reload = () => api.listTasks().then(setRows).catch(console.error);

  useEffect(() => {
    reload();
  }, [refreshKey, localRefresh]);

  // The task row a right-click opened the action menu on, plus the pointer position.
  const [menu, setMenu] = useState<{ task: TaskItem; x: number; y: number } | null>(null);

  // Re-fetch this view and nudge the host so other task surfaces (editor, sidebar) refresh too.
  const afterMutation = () => {
    setLocalRefresh((k) => k + 1);
    onChanged?.();
  };

  // Flip a task's done state on disk, then re-fetch. For a recurring task each row carries its own
  // occurrence date, so only that occurrence toggles; a plain task flips its checkbox.
  const onToggle = (t: TaskItem) => {
    api
      .toggleTask(t.rel_path, t.line, t.occurrence ?? null)
      .then(afterMutation)
      .catch(console.error);
  };

  // Set/clear a task's priority, then refresh.
  const onSetPriority = (t: TaskItem, level: string | null) => {
    api
      .setTaskPriority(t.rel_path, t.line, level)
      .then(afterMutation)
      .catch((e) => {
        console.error(e);
        toast.show({ message: "Couldn't change priority." });
      });
  };

  // Move a task (+ its subtasks) into another periodic note. Creates the destination note from the
  // period template if it doesn't exist yet, then splices the task under its `## Tasks` heading.
  const onSend = async (t: TaskItem, target: SendTarget) => {
    const toRel = pathFor(periodicFolder, target.period, target.date);
    if (toRel === t.rel_path) {
      toast.show({ message: "That task is already in this note." });
      return;
    }
    const label = labelFor(target.period, target.date, dailyFormat);
    try {
      // Ensure the destination exists (idempotent: createPage throws if present, which we ignore).
      try {
        await api.createPage(toRel, template(target.period, target.date, dailyFormat));
      } catch {
        /* already exists — fine, we'll just append to it */
      }
      await api.moveTaskBlock(t.rel_path, t.line, toRel);
      afterMutation();
      toast.show({
        message: `Moved to ${label}`,
        action: { label: "Open", run: () => onOpen(toRel) },
      });
    } catch (e) {
      console.error(e);
      toast.show({ message: "Couldn't move the task." });
    }
  };

  // Normalize raw rows → flat TaskItems, expanding recurring tasks into upcoming occurrences.
  const allTasks = useMemo<TaskItem[]>(() => {
    const today = startOfToday();
    const out: TaskItem[] = [];
    for (const r of rows) {
      const tags = r.tags ? r.tags.split(",").filter(Boolean) : [];
      const doneDates = r.done_dates ? r.done_dates.split(",").filter(Boolean) : [];
      const recurring = !!r.rrule;
      const baseDone = recurring ? !!r.due && doneDates.includes(r.due) : r.done;
      const base: TaskItem = {
        text: stripTaskMeta(r.text),
        due: r.due,
        done: baseDone,
        rel_path: r.rel_path,
        line: r.line,
        depth: r.depth,
        parent_line: r.parent_line,
        tags,
        priority: r.priority,
        recurring,
        occurrence: recurring ? r.due : null,
      };
      out.push(base);
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
    return out;
  }, [rows, showAhead]);

  // Every tag present, for the filter popover chips.
  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const t of allTasks) for (const tag of t.tags) s.add(tag);
    return [...s].sort();
  }, [allTasks]);

  // Aggregate stats over the full (unfiltered) set — the summary always reflects everything.
  const stats = useMemo(() => {
    const today = startOfToday();
    let open = 0,
      done = 0,
      overdue = 0;
    for (const t of allTasks) {
      if (t.done) done++;
      else open++;
      if (isOverdue(t, today)) overdue++;
    }
    const total = allTasks.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return { total, open, done, overdue, pct };
  }, [allTasks]);

  // When grouping by Page (or not grouping), tasks within a page stay in document order and we
  // reconstruct the parent→child tree. The other groupings (tag/status/due) can scatter a parent
  // and child into different buckets, so there we render every matching task flat at depth 0.
  const hierarchical = groupBy === "page" || groupBy === "none";

  // Apply search + status + tag filters. Keep the set of matched keys so we can re-introduce a
  // matched subtask's ancestors as faint context rows (per the "always nest, keep parents" rule).
  const { matched, matchedKeys } = useMemo(() => {
    const today = startOfToday();
    const q = query.trim().toLowerCase();
    const matched = allTasks.filter((t) => {
      if (q && !t.text.toLowerCase().includes(q) && !t.tags.some((tg) => tg.toLowerCase().includes(q)))
        return false;
      if (status === "open" && t.done) return false;
      if (status === "done" && !t.done) return false;
      if (status === "overdue" && !isOverdue(t, today)) return false;
      if (activeTags.length && !activeTags.every((tg) => t.tags.includes(tg))) return false;
      return true;
    });
    return { matched, matchedKeys: new Set(matched.map(taskKey)) };
  }, [allTasks, query, status, activeTags]);

  // Per-page index of real (non-virtual) tasks by key, for walking parent chains.
  const byKey = useMemo(() => {
    const m = new Map<string, TaskItem>();
    for (const t of allTasks) {
      if (t.virtual) continue;
      const k = taskKey(t);
      if (!m.has(k)) m.set(k, t);
    }
    return m;
  }, [allTasks]);

  // The displayed result count (matched only — context rows aren't "results").
  const resultCount = matched.length;

  // Bucket → ordered, possibly-nested rows.
  const groups = useMemo(() => {
    const today = startOfToday();
    // Calendar-period bucketing (by day/week/month) replaces the smart due split when chosen.
    const periodMode = groupBy === "due" && duePeriod !== "smart";
    // In period mode, the chronological sort key for each bucket *label* (overdue first, dates in
    // order, "No date" last) — used to order groups when no explicit group-sort overrides it.
    const periodSortKey = new Map<string, string>();

    const groupKey = (t: TaskItem) => {
      if (periodMode) {
        const { key, label } = duePeriodBucket(t, today, duePeriod as Exclude<DuePeriod, "smart">, dateFormat);
        periodSortKey.set(label, key);
        return label;
      }
      return groupBy === "tag"
        ? t.tags[0]
          ? `#${t.tags[0]}`
          : "Untagged"
        : groupBy === "status"
        ? t.done
          ? "Done"
          : isOverdue(t, today)
          ? "Overdue"
          : "Open"
        : groupBy === "page"
        ? pageName(t.rel_path)
        : groupBy === "due"
        ? dueBucket(t, today)
        : "All tasks";
    };

    // Partition matched rows into buckets.
    const m = new Map<string, TaskItem[]>();
    for (const t of matched) {
      const k = groupKey(t);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    }

    // Order buckets. "default" keeps each grouping's natural sequence (due/status buckets in their
    // semantic order, tag/page alphabetical); the other group-sorts override that uniformly. Group
    // metrics for the count/due sorts: open-task count and earliest non-virtual due date per bucket.
    const entries = [...m.entries()];
    const openCount = (items: TaskItem[]) => items.reduce((n, t) => n + (t.done ? 0 : 1), 0);
    const earliestDue = (items: TaskItem[]) =>
      items.reduce((min, t) => (t.due && t.due < min ? t.due : min), "9999-99-99");
    if (groupSort === "name-asc") entries.sort((a, b) => a[0].localeCompare(b[0]));
    else if (groupSort === "name-desc") entries.sort((a, b) => b[0].localeCompare(a[0]));
    else if (groupSort === "count-desc") entries.sort((a, b) => openCount(b[1]) - openCount(a[1]));
    else if (groupSort === "count-asc") entries.sort((a, b) => openCount(a[1]) - openCount(b[1]));
    else if (groupSort === "due-asc") entries.sort((a, b) => earliestDue(a[1]).localeCompare(earliestDue(b[1])));
    // Period buckets default to chronological (overdue → dated → no-date) via their precomputed keys.
    else if (periodMode)
      entries.sort((a, b) => (periodSortKey.get(a[0]) ?? "").localeCompare(periodSortKey.get(b[0]) ?? ""));
    else if (groupBy === "due") entries.sort((a, b) => DUE_ORDER.indexOf(a[0]) - DUE_ORDER.indexOf(b[0]));
    else if (groupBy === "status") {
      const order = ["Overdue", "Open", "Done"];
      entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    } else if (groupBy !== "none") entries.sort((a, b) => a[0].localeCompare(b[0]));

    // Within each bucket, build the render list.
    return entries.map(([name, items]) => {
      const rows = hierarchical
        ? nestRows(items, matchedKeys, byKey)
        : flatSorted(items, sortBy, sortScope);
      return [name, rows] as const;
    });
  }, [matched, matchedKeys, byKey, groupBy, sortBy, sortScope, groupSort, duePeriod, dateFormat, hierarchical]);

  // Whether any flat bucket actually contains a parent with a child alongside it — only then is the
  // parent/child sort-scope choice meaningful, so the scope picker is offered conditionally.
  const sortHasNesting = useMemo(() => {
    if (hierarchical) return false;
    return groups.some(([, rows]) => bucketHasNesting(rows));
  }, [groups, hierarchical]);

  const today = startOfToday();
  const filterCount = (status !== "all" ? 1 : 0) + activeTags.length;
  const hasTasks = allTasks.length > 0;
  const hasResults = resultCount > 0;

  return (
    <div className="panel tasks-view">
      <div className="panel-header">
        <h2>Tasks</h2>
        <label className="toggle">
          <input type="checkbox" checked={showAhead} onChange={(e) => setShowAhead(e.target.checked)} />
          Show all recurring ahead
        </label>
      </div>

      {/* Aggregation summary — live counts + completion bar. */}
      {hasTasks && (
        <div className="tasks-summary">
          <Stat icon={<ListBullets size={15} />} label="Total" value={stats.total} />
          <Stat icon={<Circle size={15} />} label="Open" value={stats.open} />
          <Stat icon={<CheckCircle size={15} weight="fill" />} label="Done" value={stats.done} tone="accent" />
          <Stat
            icon={<Warning size={15} weight="fill" />}
            label="Overdue"
            value={stats.overdue}
            tone={stats.overdue ? "danger" : undefined}
          />
          <div className="tasks-progress" title={`${stats.pct}% complete`}>
            <div className="tasks-progress-bar">
              <div className="tasks-progress-fill" style={{ width: `${stats.pct}%` }} />
            </div>
            <span className="tasks-progress-pct">{stats.pct}%</span>
          </div>
        </div>
      )}

      {/* Toolbar — search + filter / group / sort, mirroring the database toolbar. */}
      {hasTasks && (
        <div className="db-toolbar tasks-toolbar">
          <div className="tasks-search">
            <MagnifyingGlass size={15} className="tasks-search-icon" />
            <input
              className="tasks-search-input"
              type="text"
              placeholder="Search tasks…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search tasks"
            />
            {query && (
              <button className="tasks-search-clear" onClick={() => setQuery("")} aria-label="Clear search">
                <X size={13} weight="bold" />
              </button>
            )}
          </div>

          <ToolBtn active={!!filterCount} onClick={() => setOpenPop(openPop === "filter" ? null : "filter")}>
            <Funnel size={14} /> Filter{filterCount ? ` · ${filterCount}` : ""}
          </ToolBtn>
          <ToolBtn active={groupBy !== "tag"} onClick={() => setOpenPop(openPop === "group" ? null : "group")}>
            <ListBullets size={14} /> Group: {GROUP_OPTIONS.find((g) => g.value === groupBy)?.label}
          </ToolBtn>
          {/* Period granularity refines the Due-date grouping (smart vs. day/week/month), so it only
              applies — and only appears — while grouping by due date. */}
          {groupBy === "due" && (
            <ToolBtn active={duePeriod !== "smart"} onClick={() => setOpenPop(openPop === "duePeriod" ? null : "duePeriod")}>
              <CalendarBlank size={14} /> Period: {DUE_PERIOD_OPTIONS.find((p) => p.value === duePeriod)?.label.replace(/ \(.*\)$/, "")}
            </ToolBtn>
          )}
          {/* "None" yields a single group, so ordering groups is moot — only offer it when grouped. */}
          {groupBy !== "none" && (
            <ToolBtn active={groupSort !== "default"} onClick={() => setOpenPop(openPop === "groupSort" ? null : "groupSort")}>
              <Stack size={14} /> Sort groups
            </ToolBtn>
          )}
          {/* In hierarchical groupings (Page/None) rows follow document order to keep the tree intact,
              so task sorting only applies to the flat groupings. */}
          {!hierarchical && (
            <ToolBtn
              active={sortBy !== "due-asc" || (sortHasNesting && sortScope !== "all")}
              onClick={() => setOpenPop(openPop === "sort" ? null : "sort")}
            >
              <SortAscending size={14} /> Sort tasks
            </ToolBtn>
          )}

          {openPop === "filter" && (
            <FilterPopover
              status={status}
              setStatus={setStatus}
              allTags={allTags}
              activeTags={activeTags}
              setActiveTags={setActiveTags}
              onClose={() => setOpenPop(null)}
            />
          )}
          {openPop === "group" && (
            <ChoicePopover
              title="Group by"
              value={groupBy}
              options={GROUP_OPTIONS}
              onChange={(v) => setGroupBy(v as GroupBy)}
              onClose={() => setOpenPop(null)}
            />
          )}
          {openPop === "duePeriod" && groupBy === "due" && (
            <ChoicePopover
              title="Bucket by period"
              value={duePeriod}
              options={DUE_PERIOD_OPTIONS}
              onChange={(v) => setDuePeriod(v as DuePeriod)}
              onClose={() => setOpenPop(null)}
            />
          )}
          {openPop === "groupSort" && groupBy !== "none" && (
            <ChoicePopover
              title="Sort groups by"
              value={groupSort}
              options={GROUP_SORT_OPTIONS}
              onChange={(v) => setGroupSort(v as GroupSort)}
              onClose={() => setOpenPop(null)}
            />
          )}
          {openPop === "sort" && !hierarchical && (
            <SortPopover
              sortBy={sortBy}
              onSortBy={(v) => setSortBy(v)}
              hasNesting={sortHasNesting}
              scope={sortScope}
              onScope={(v) => setSortScope(v)}
              onClose={() => setOpenPop(null)}
            />
          )}
        </div>
      )}

      {/* States: no tasks at all → onboarding; tasks but filtered to nothing → no-results. */}
      {!hasTasks && (
        <div className="tasks-empty">
          <CheckCircle size={28} weight="duotone" />
          <p>No tasks yet</p>
          <span className="muted">
            Add <code>- [ ] something</code> to any page and it shows up here.
          </span>
        </div>
      )}
      {hasTasks && !hasResults && (
        <div className="tasks-empty">
          <MagnifyingGlass size={28} weight="duotone" />
          <p>No matching tasks</p>
          <span className="muted">Try a different search or clear your filters.</span>
        </div>
      )}

      {hasResults &&
        groups.map(([name, items]) => {
          const real = items.filter((t) => !t.contextOnly);
          const open = real.filter((t) => !t.done).length;
          const done = real.length - open;
          return (
            <div key={name} className="task-group">
              <h3 className="task-group-title">
                <span>{name}</span>
                <span className="task-group-count">
                  {open} open{done ? ` · ${done} done` : ""}
                </span>
              </h3>
              <TaskList
                tasks={items}
                dateFormat={dateFormat}
                onOpen={onOpen}
                onOpenName={onOpenName}
                onToggle={onToggle}
                today={today}
                onContextMenu={(task, e) => {
                  e.preventDefault();
                  setMenu({ task, x: e.clientX, y: e.clientY });
                }}
              />
            </div>
          );
        })}

      {menu && (
        <TaskActionMenu
          x={menu.x}
          y={menu.y}
          task={menu.task}
          onSetPriority={(level) => onSetPriority(menu.task, level)}
          onSend={(target) => onSend(menu.task, target)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/* ---- Summary stat pill ---------------------------------------------------------------------- */
function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "accent" | "danger";
}) {
  return (
    <div className={`tasks-stat${tone ? ` ${tone}` : ""}`}>
      <span className="tasks-stat-icon">{icon}</span>
      <span className="tasks-stat-value">{value}</span>
      <span className="tasks-stat-label">{label}</span>
    </div>
  );
}

/* ---- Toolbar button (mirrors DbToolbar's ToolbarButton) ------------------------------------- */
function ToolBtn({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`db-tool-btn${active ? " active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

/* ---- Outside-click + Escape dismiss (local copy of DbShared.useDismiss semantics) ----------- */
function useDismiss(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node) && !(e.target as Element)?.closest?.(".tasks-toolbar"))
        onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return ref;
}

/* ---- Filter popover: status segmented control + tag chips ----------------------------------- */
function FilterPopover({
  status,
  setStatus,
  allTags,
  activeTags,
  setActiveTags,
  onClose,
}: {
  status: StatusFilter;
  setStatus: (s: StatusFilter) => void;
  allTags: string[];
  activeTags: string[];
  setActiveTags: (t: string[]) => void;
  onClose: () => void;
}) {
  const ref = useDismiss(onClose);
  const toggleTag = (tag: string) =>
    setActiveTags(activeTags.includes(tag) ? activeTags.filter((t) => t !== tag) : [...activeTags, tag]);
  const dirty = status !== "all" || activeTags.length > 0;

  return (
    <div className="db-popover tasks-pop" ref={ref}>
      <div className="db-popover-head">
        <span>Filter</span>
        {dirty && (
          <button
            className="tasks-pop-reset"
            onClick={() => {
              setStatus("all");
              setActiveTags([]);
            }}
          >
            Reset
          </button>
        )}
      </div>

      <div className="tasks-pop-label">Status</div>
      <div className="seg tasks-status-seg">
        {STATUS_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={`tasks-seg-btn${status === o.value ? " active" : ""}`}
            onClick={() => setStatus(o.value as StatusFilter)}
          >
            {o.label}
          </button>
        ))}
      </div>

      {allTags.length > 0 && (
        <>
          <div className="tasks-pop-label">Tags</div>
          <div className="tasks-tag-chips">
            {allTags.map((tag) => (
              <button
                key={tag}
                className={`tasks-chip${activeTags.includes(tag) ? " active" : ""}`}
                onClick={() => toggleTag(tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---- Single-choice popover (Group by / Sort by), using the shared Select for keyboard nav --- */
function ChoicePopover({
  title,
  value,
  options,
  onChange,
  onClose,
}: {
  title: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  const ref = useDismiss(onClose);
  return (
    <div className="db-popover tasks-pop tasks-pop-narrow" ref={ref}>
      <div className="db-popover-head">
        <span>{title}</span>
      </div>
      <Select value={value} options={options} onChange={onChange} ariaLabel={title} />
    </div>
  );
}

/* ---- Sort-tasks popover: order + (when the view has nested tasks) the parent/child scope -------
   The scope picker only appears when the visible results actually contain a parent with a child
   alongside it — otherwise "Sort ALL / Parents only / Children only" would be a no-op choice. */
function SortPopover({
  sortBy,
  onSortBy,
  hasNesting,
  scope,
  onScope,
  onClose,
}: {
  sortBy: SortBy;
  onSortBy: (v: SortBy) => void;
  hasNesting: boolean;
  scope: SortScope;
  onScope: (v: SortScope) => void;
  onClose: () => void;
}) {
  const ref = useDismiss(onClose);
  return (
    <div className="db-popover tasks-pop tasks-pop-narrow" ref={ref}>
      <div className="db-popover-head">
        <span>Sort tasks by</span>
      </div>
      <Select
        value={sortBy}
        options={SORT_OPTIONS}
        onChange={(v) => onSortBy(v as SortBy)}
        ariaLabel="Sort tasks by"
      />
      {hasNesting && (
        <>
          <div className="tasks-pop-label">Some tasks have children — apply sort to</div>
          <Select
            value={scope}
            options={SORT_SCOPE_OPTIONS}
            onChange={(v) => onScope(v as SortScope)}
            ariaLabel="Sort scope"
          />
        </>
      )}
    </div>
  );
}
