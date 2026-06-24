import { useEffect, useMemo, useRef, useState } from "react";
import {
  MagnifyingGlass,
  X,
  Funnel,
  ListBullets,
  SortAscending,
  SortDescending,
  Stack,
  CalendarBlank,
  CalendarDots,
  Calendar,
  CheckCircle,
  Circle,
  Warning,
  Flag,
  ArrowsClockwise,
  Hash,
  FileText,
  Folder,
  Rows,
  TextAa,
  TreeStructure,
  ArrowUp,
  ArrowDown,
  Sparkle,
  Check,
} from "@phosphor-icons/react";
import { api } from "../api";
import type { TaskRow } from "../types";
import { upcoming } from "../recurrence";
import { parseISODate, formatDate } from "../dateformat";
import { labelFor, periodRange, pathFor, template, type Period } from "../periodic";
import { stripTaskMeta } from "../markdown";
import TaskList, { type TaskItem, PRIORITY_META } from "./TaskList";
import TaskActionMenu, { type SendTarget } from "./TaskActionMenu";
import { toast } from "./Toast";
import { type SelectOption } from "./Select";

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
/** Priority buckets for the (multi-select) priority filter; "none" = no priority set. */
type PriorityKey = "high" | "medium" | "low" | "none";
/** Due-date window filter (single-select): by date presence or how soon it falls. */
type DueFilter = "any" | "dated" | "undated" | "today" | "week";
/** Task-kind filter (single-select): recurring vs one-off. */
type TypeFilter = "any" | "recurring" | "oneoff";
/** Whether the active tag chips combine with AND ("all") or OR ("any"). */
type TagMatch = "all" | "any";
/** How rows are bucketed into groups. */
type GroupBy = "tag" | "due" | "priority" | "status" | "page" | "folder" | "none";
/** Row ordering within each group. "doc" keeps each page's source (document) order — the only
 *  ordering that was previously possible in the hierarchical Page/Folder/None groupings. */
type SortBy = "doc" | "due-asc" | "due-desc" | "prio-desc" | "alpha";
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
/** Priority filter chips (multi-select). Colour-coded by level via the `--prio-*` tokens. */
const PRIORITY_FILTER_OPTIONS: { value: PriorityKey; label: string }[] = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "none", label: "None" },
];
const DUE_FILTER_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "dated", label: "Has date" },
  { value: "undated", label: "No date" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
];
const TYPE_FILTER_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "recurring", label: "Recurring" },
  { value: "oneoff", label: "One-off" },
];
const GROUP_OPTIONS: SelectOption[] = [
  { value: "tag", label: "Tag", icon: <Hash size={15} /> },
  { value: "due", label: "Due date", icon: <CalendarBlank size={15} /> },
  { value: "priority", label: "Priority", icon: <Flag size={15} /> },
  { value: "status", label: "Status", icon: <CheckCircle size={15} /> },
  { value: "page", label: "Page", icon: <FileText size={15} /> },
  { value: "folder", label: "Folder", icon: <Folder size={15} /> },
  { value: "none", label: "None", icon: <Rows size={15} /> },
];
const SORT_OPTIONS: SelectOption[] = [
  { value: "doc", label: "Document order", icon: <ListBullets size={15} /> },
  { value: "due-asc", label: "Due ↑ (soonest)", icon: <SortAscending size={15} /> },
  { value: "due-desc", label: "Due ↓ (latest)", icon: <SortDescending size={15} /> },
  { value: "prio-desc", label: "Priority (high → low)", icon: <Flag size={15} /> },
  { value: "alpha", label: "A → Z", icon: <TextAa size={15} /> },
];
const SORT_SCOPE_OPTIONS: SelectOption[] = [
  { value: "all", label: "Sort ALL (keep hierarchy)", icon: <TreeStructure size={15} /> },
  { value: "parents", label: "Parents only", icon: <ArrowUp size={15} /> },
  { value: "children", label: "Children only", icon: <ArrowDown size={15} /> },
];
const GROUP_SORT_OPTIONS: SelectOption[] = [
  { value: "default", label: "Default order", icon: <Stack size={15} /> },
  { value: "name-asc", label: "Name A → Z", icon: <SortAscending size={15} /> },
  { value: "name-desc", label: "Name Z → A", icon: <SortDescending size={15} /> },
  { value: "count-desc", label: "Most tasks", icon: <Hash size={15} /> },
  { value: "count-asc", label: "Fewest tasks", icon: <Hash size={15} /> },
  { value: "due-asc", label: "Soonest due", icon: <CalendarBlank size={15} /> },
];
const DUE_PERIOD_OPTIONS: SelectOption[] = [
  { value: "smart", label: "Smart (Overdue / Today / …)", icon: <Sparkle size={15} /> },
  { value: "day", label: "By day", icon: <CalendarBlank size={15} /> },
  { value: "week", label: "By week", icon: <CalendarDots size={15} /> },
  { value: "month", label: "By month", icon: <Calendar size={15} /> },
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

/** Containing folder of a page path; pages at the vault root bucket under "Vault root". */
function folderName(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? "Vault root" : relPath.slice(0, i);
}

/** Priority bucket key for a task (for filtering): its level, or "none" when unset. */
function prioKey(t: TaskItem): PriorityKey {
  return (t.priority as PriorityKey) || "none";
}

/** Ordering weight for a task's priority (high=3 … none=0), used by the priority sort. */
function prioWeight(t: TaskItem): number {
  return t.priority && PRIORITY_META[t.priority] ? PRIORITY_META[t.priority].weight : 0;
}

/** True when a task's due date satisfies the due-window filter (presence / today / this week). */
function dueMatches(t: TaskItem, filter: DueFilter, today: Date): boolean {
  if (filter === "any") return true;
  if (filter === "dated") return !!t.due;
  if (filter === "undated") return !t.due;
  if (!t.due) return false;
  const due = parseISODate(t.due).getTime();
  const day = 86400000;
  if (filter === "today") return due >= today.getTime() && due < today.getTime() + day;
  if (filter === "week") return due >= today.getTime() && due < today.getTime() + day * 7;
  return true;
}

/**
 * Persist the Tasks toolbar (search/filter/group/sort) in localStorage so leaving the page and
 * coming back restores the same view. Mirrors App.tsx's `pp.`-prefixed UI-state convention.
 */
const TASKS_STATE_KEY = "pp.tasksView";
interface TasksState {
  query: string;
  status: StatusFilter;
  activePrios: PriorityKey[];
  dueFilter: DueFilter;
  typeFilter: TypeFilter;
  activeTags: string[];
  tagMatch: TagMatch;
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
  // Pull in any unmatched ancestors as faint context rows, then group by page.
  const byPage = withAncestors(items, matchedKeys, byKey);

  // Within each page emit rows in document order with depth re-based to that page's shallowest visible
  // task — so indentation always starts at the gutter even when only a deep subtask matched. Pages are
  // ordered by path for a stable layout.
  const out: TaskItem[] = [];
  for (const [, pageRows] of [...byPage.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    pageRows.sort((a, b) => a.line - b.line);
    const base = pageRows.reduce((min, r) => Math.min(min, r.depth ?? 0), Infinity);
    const norm = Number.isFinite(base) ? base : 0;
    for (const r of pageRows) out.push({ ...r, depth: (r.depth ?? 0) - norm });
  }
  return out;
}

/**
 * Like {@link nestRows}, but sorts the rows *within each page* by the active task-sort while keeping
 * the parent→child tree intact (via {@link flatSorted}). Used by the hierarchical groupings
 * (Page/Folder/None) when a sort other than "Document order" is chosen — so e.g. grouping by Page can
 * still list each page's tasks soonest-due-first. Pages themselves stay path-ordered; injected
 * ancestors come along as context rows so deep subtasks never render orphaned.
 */
function nestSorted(
  items: TaskItem[],
  matchedKeys: Set<string>,
  byKey: Map<string, TaskItem>,
  sortBy: SortBy,
  scope: SortScope
): TaskItem[] {
  const byPage = withAncestors(items, matchedKeys, byKey);
  const out: TaskItem[] = [];
  for (const [, pageRows] of [...byPage.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // flatSorted rebuilds the page's forest, sorts per scope, and re-bases depth to the gutter.
    out.push(...flatSorted(pageRows, sortBy, scope));
  }
  return out;
}

/**
 * Re-introduce every matched row's unmatched ancestors as faint `contextOnly` rows (so a deep subtask
 * never renders orphaned), then bucket all rows — matches and injected ancestors — by their page path.
 * Shared by the document-order ({@link nestRows}) and sorted ({@link nestSorted}) hierarchical paths.
 */
function withAncestors(
  items: TaskItem[],
  matchedKeys: Set<string>,
  byKey: Map<string, TaskItem>
): Map<string, TaskItem[]> {
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

  const byPage = new Map<string, TaskItem[]>();
  for (const r of [...items, ...ancestors.values()]) {
    if (!byPage.has(r.rel_path)) byPage.set(r.rel_path, []);
    byPage.get(r.rel_path)!.push(r);
  }
  return byPage;
}

/** Compare two rows by the active task-sort (document order, A→Z, priority, or due asc/desc). */
function sortCmp(a: TaskItem, b: TaskItem, sortBy: SortBy): number {
  // Document order = source line order within a page (callers only compare rows from one page).
  if (sortBy === "doc") return a.line - b.line;
  if (sortBy === "alpha") return a.text.localeCompare(b.text);
  if (sortBy === "prio-desc") {
    // Most-urgent first; tasks of equal priority fall back to soonest due so the order stays useful.
    const d = prioWeight(b) - prioWeight(a);
    if (d !== 0) return d;
    return (a.due ?? "9999").localeCompare(b.due ?? "9999");
  }
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
  const [activePrios, setActivePrios] = useState<PriorityKey[]>(saved.activePrios ?? []);
  const [dueFilter, setDueFilter] = useState<DueFilter>(saved.dueFilter ?? "any");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(saved.typeFilter ?? "any");
  const [activeTags, setActiveTags] = useState<string[]>(saved.activeTags ?? []);
  const [tagMatch, setTagMatch] = useState<TagMatch>(saved.tagMatch ?? "all");
  const [groupBy, setGroupBy] = useState<GroupBy>(saved.groupBy ?? "tag");
  const [sortBy, setSortBy] = useState<SortBy>(saved.sortBy ?? "due-asc");
  const [sortScope, setSortScope] = useState<SortScope>(saved.sortScope ?? "all");
  const [groupSort, setGroupSort] = useState<GroupSort>(saved.groupSort ?? "default");
  const [duePeriod, setDuePeriod] = useState<DuePeriod>(saved.duePeriod ?? "smart");
  const [openPop, setOpenPop] = useState<null | "filter" | "group" | "sort" | "groupSort" | "duePeriod">(null);

  // Persist toolbar state whenever any part of it changes.
  useEffect(() => {
    const state: TasksState = {
      query, status, activePrios, dueFilter, typeFilter, activeTags, tagMatch,
      groupBy, sortBy, sortScope, groupSort, duePeriod, showAhead,
    };
    try {
      localStorage.setItem(TASKS_STATE_KEY, JSON.stringify(state));
    } catch {
      /* storage may be unavailable; restoring is best-effort */
    }
  }, [query, status, activePrios, dueFilter, typeFilter, activeTags, tagMatch, groupBy, sortBy, sortScope, groupSort, duePeriod, showAhead]);

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

  // When grouping by Page/Folder (or not grouping) we reconstruct the parent→child tree per page. By
  // default rows stay in document order; choosing any other task-sort orders them within each page
  // while keeping the tree intact (see nestSorted). The other groupings (tag/status/due/priority) can
  // scatter a parent and child into different buckets, so there we render every matching task flat.
  const hierarchical = groupBy === "page" || groupBy === "folder" || groupBy === "none";

  // Apply search + status + priority + due + type + tag filters. Keep the set of matched keys so we
  // can re-introduce a matched subtask's ancestors as faint context rows (the "always nest" rule).
  const { matched, matchedKeys } = useMemo(() => {
    const today = startOfToday();
    const q = query.trim().toLowerCase();
    const matched = allTasks.filter((t) => {
      if (q && !t.text.toLowerCase().includes(q) && !t.tags.some((tg) => tg.toLowerCase().includes(q)))
        return false;
      if (status === "open" && t.done) return false;
      if (status === "done" && !t.done) return false;
      if (status === "overdue" && !isOverdue(t, today)) return false;
      if (activePrios.length && !activePrios.includes(prioKey(t))) return false;
      if (!dueMatches(t, dueFilter, today)) return false;
      if (typeFilter === "recurring" && !t.recurring) return false;
      if (typeFilter === "oneoff" && t.recurring) return false;
      if (activeTags.length) {
        const ok =
          tagMatch === "all"
            ? activeTags.every((tg) => t.tags.includes(tg))
            : activeTags.some((tg) => t.tags.includes(tg));
        if (!ok) return false;
      }
      return true;
    });
    return { matched, matchedKeys: new Set(matched.map(taskKey)) };
  }, [allTasks, query, status, activePrios, dueFilter, typeFilter, activeTags, tagMatch]);

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
        : groupBy === "priority"
        ? t.priority && PRIORITY_META[t.priority]
          ? PRIORITY_META[t.priority].label
          : "No priority"
        : groupBy === "status"
        ? t.done
          ? "Done"
          : isOverdue(t, today)
          ? "Overdue"
          : "Open"
        : groupBy === "page"
        ? pageName(t.rel_path)
        : groupBy === "folder"
        ? folderName(t.rel_path)
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
    } else if (groupBy === "priority") {
      // Most-urgent bucket first, unset priority last.
      const order = ["High", "Medium", "Low", "No priority"];
      entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    } else if (groupBy !== "none") entries.sort((a, b) => a[0].localeCompare(b[0]));

    // Within each bucket, build the render list. Hierarchical groups stay in document order ("doc")
    // by default, but honour any other task-sort within each page; flat groups always sort.
    return entries.map(([name, items]) => {
      const rows = hierarchical
        ? sortBy === "doc"
          ? nestRows(items, matchedKeys, byKey)
          : nestSorted(items, matchedKeys, byKey, sortBy, sortScope)
        : flatSorted(items, sortBy, sortScope);
      return [name, rows] as const;
    });
  }, [matched, matchedKeys, byKey, groupBy, sortBy, sortScope, groupSort, duePeriod, dateFormat, hierarchical]);

  // Whether any bucket actually contains a parent with a child alongside it — only then is the
  // parent/child sort-scope choice meaningful, so the scope picker is offered conditionally. (Now that
  // hierarchical groups can be sorted too, this is no longer restricted to the flat groupings.)
  const sortHasNesting = useMemo(() => {
    return groups.some(([, rows]) => bucketHasNesting(rows));
  }, [groups]);

  const today = startOfToday();
  const filterCount =
    (status !== "all" ? 1 : 0) +
    activePrios.length +
    (dueFilter !== "any" ? 1 : 0) +
    (typeFilter !== "any" ? 1 : 0) +
    activeTags.length;
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

      {/* Aggregation summary — live counts + completion bar. The count pills double as a quick
          status filter: clicking one sets the Status filter (re-clicking the active one clears it
          back to "all"). */}
      {hasTasks && (
        <div className="tasks-summary">
          <Stat
            icon={<ListBullets size={15} />}
            label="Total"
            value={stats.total}
            active={status === "all"}
            onClick={() => setStatus("all")}
          />
          <Stat
            icon={<Circle size={15} />}
            label="Open"
            value={stats.open}
            active={status === "open"}
            onClick={() => setStatus(status === "open" ? "all" : "open")}
          />
          <Stat
            icon={<CheckCircle size={15} weight="fill" />}
            label="Done"
            value={stats.done}
            tone="accent"
            active={status === "done"}
            onClick={() => setStatus(status === "done" ? "all" : "done")}
          />
          <Stat
            icon={<Warning size={15} weight="fill" />}
            label="Overdue"
            value={stats.overdue}
            tone={stats.overdue ? "danger" : undefined}
            active={status === "overdue"}
            onClick={() => setStatus(status === "overdue" ? "all" : "overdue")}
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
          {/* Task sorting applies inside every grouping now: flat groups sort directly, hierarchical
              groups (Page/Folder/None) sort within each page while keeping the parent→child tree. */}
          <ToolBtn
            active={sortBy !== "due-asc" || (sortHasNesting && sortScope !== "all")}
            onClick={() => setOpenPop(openPop === "sort" ? null : "sort")}
          >
            <SortAscending size={14} /> Sort tasks
          </ToolBtn>

          {openPop === "filter" && (
            <FilterPopover
              status={status}
              setStatus={setStatus}
              activePrios={activePrios}
              setActivePrios={setActivePrios}
              dueFilter={dueFilter}
              setDueFilter={setDueFilter}
              typeFilter={typeFilter}
              setTypeFilter={setTypeFilter}
              allTags={allTags}
              activeTags={activeTags}
              setActiveTags={setActiveTags}
              tagMatch={tagMatch}
              setTagMatch={setTagMatch}
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
          {openPop === "sort" && (
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

/* ---- Summary stat pill (doubles as a one-click status filter) ------------------------------- */
function Stat({
  icon,
  label,
  value,
  tone,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "accent" | "danger";
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`tasks-stat${tone ? ` ${tone}` : ""}${active ? " active" : ""}`}
      onClick={onClick}
      aria-pressed={active}
      title={`Filter by ${label}`}
    >
      <span className="tasks-stat-icon">{icon}</span>
      <span className="tasks-stat-value">{value}</span>
      <span className="tasks-stat-label">{label}</span>
    </button>
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

/* ---- Filter popover: status / priority / due / type / tags, all behind one toolbar button -----
   Single-select dimensions render as segmented controls; multi-select ones (priority, tags) render
   as toggleable chips. Sections for priority/tags only appear when there's data to act on. */
function FilterPopover({
  status,
  setStatus,
  activePrios,
  setActivePrios,
  dueFilter,
  setDueFilter,
  typeFilter,
  setTypeFilter,
  allTags,
  activeTags,
  setActiveTags,
  tagMatch,
  setTagMatch,
  onClose,
}: {
  status: StatusFilter;
  setStatus: (s: StatusFilter) => void;
  activePrios: PriorityKey[];
  setActivePrios: (p: PriorityKey[]) => void;
  dueFilter: DueFilter;
  setDueFilter: (d: DueFilter) => void;
  typeFilter: TypeFilter;
  setTypeFilter: (t: TypeFilter) => void;
  allTags: string[];
  activeTags: string[];
  setActiveTags: (t: string[]) => void;
  tagMatch: TagMatch;
  setTagMatch: (m: TagMatch) => void;
  onClose: () => void;
}) {
  const ref = useDismiss(onClose);
  const toggleTag = (tag: string) =>
    setActiveTags(activeTags.includes(tag) ? activeTags.filter((t) => t !== tag) : [...activeTags, tag]);
  const togglePrio = (p: PriorityKey) =>
    setActivePrios(activePrios.includes(p) ? activePrios.filter((x) => x !== p) : [...activePrios, p]);
  const dirty =
    status !== "all" || activePrios.length > 0 || dueFilter !== "any" || typeFilter !== "any" || activeTags.length > 0;

  return (
    <div className="db-popover tasks-pop" ref={ref}>
      <div className="db-popover-head">
        <span>Filter</span>
        {dirty && (
          <button
            className="tasks-pop-reset"
            onClick={() => {
              setStatus("all");
              setActivePrios([]);
              setDueFilter("any");
              setTypeFilter("any");
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

      <div className="tasks-pop-label">Priority</div>
      <div className="tasks-chip-row">
        {PRIORITY_FILTER_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={`tasks-chip tasks-prio-chip prio-${o.value}${activePrios.includes(o.value) ? " active" : ""}`}
            onClick={() => togglePrio(o.value)}
            aria-pressed={activePrios.includes(o.value)}
          >
            <Flag size={11} weight={o.value === "none" ? "regular" : "fill"} />
            {o.label}
          </button>
        ))}
      </div>

      <div className="tasks-pop-label">Due</div>
      <div className="seg tasks-seg-wrap">
        {DUE_FILTER_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={`tasks-seg-btn${dueFilter === o.value ? " active" : ""}`}
            onClick={() => setDueFilter(o.value as DueFilter)}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="tasks-pop-label">Type</div>
      <div className="seg tasks-seg-wrap">
        {TYPE_FILTER_OPTIONS.map((o) => (
          <button
            key={o.value}
            className={`tasks-seg-btn${typeFilter === o.value ? " active" : ""}`}
            onClick={() => setTypeFilter(o.value as TypeFilter)}
          >
            {o.value === "recurring" && <ArrowsClockwise size={11} weight="bold" />}
            {o.label}
          </button>
        ))}
      </div>

      {allTags.length > 0 && (
        <>
          <div className="tasks-pop-label tasks-pop-label-row">
            <span>Tags</span>
            {/* Combine the selected tags with AND ("all") or OR ("any"); only matters with 2+ selected. */}
            <span className="tasks-match-toggle" role="group" aria-label="Combine tags with">
              <button className={tagMatch === "all" ? "active" : ""} onClick={() => setTagMatch("all")}>
                All
              </button>
              <button className={tagMatch === "any" ? "active" : ""} onClick={() => setTagMatch("any")}>
                Any
              </button>
            </span>
          </div>
          <div className="tasks-tag-chips">
            {allTags.map((tag) => (
              <button
                key={tag}
                className={`tasks-chip${activeTags.includes(tag) ? " active" : ""}`}
                onClick={() => toggleTag(tag)}
                aria-pressed={activeTags.includes(tag)}
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

/* ---- Inline single-choice list: the options ARE the menu, shown the moment the popover opens, so
   picking takes a single click (no nested collapsed dropdown to expand first). Mirrors the Select
   option row visually; `<button>`s keep it keyboard-reachable, with Arrow Up/Down roving focus and
   focus landing on the current choice when shown. --------------------------------------------------- */
function ChoiceList({
  value,
  options,
  onPick,
  autoFocus,
}: {
  value: string;
  options: SelectOption[];
  onPick: (v: string) => void;
  autoFocus?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    (listRef.current?.querySelector<HTMLElement>('[data-selected="true"]') ??
      listRef.current?.querySelector<HTMLElement>("button"))?.focus();
  }, [autoFocus]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0);
    items[next < 0 ? 0 : next]?.focus();
  };

  return (
    <div className="tasks-choice-list" role="listbox" ref={listRef} onKeyDown={onKeyDown}>
      {options.map((o) => {
        const sel = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={sel}
            data-selected={sel}
            className={`tasks-choice-item${sel ? " selected" : ""}`}
            onClick={() => onPick(o.value)}
          >
            {o.icon && <span className="tasks-choice-icon">{o.icon}</span>}
            <span className="tasks-choice-label">{o.label}</span>
            {sel && <Check size={14} weight="bold" className="tasks-choice-check" />}
          </button>
        );
      })}
    </div>
  );
}

/* ---- Single-choice popover (Group by / Due period / Sort groups): the option list shows directly,
   and picking applies it and closes — one click to open, one click to choose. */
function ChoicePopover({
  title,
  value,
  options,
  onChange,
  onClose,
}: {
  title: string;
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  const ref = useDismiss(onClose);
  return (
    <div className="db-popover tasks-pop tasks-pop-narrow" ref={ref}>
      <div className="db-popover-head">
        <span>{title}</span>
      </div>
      <ChoiceList
        value={value}
        options={options}
        autoFocus
        onPick={(v) => {
          onChange(v);
          onClose();
        }}
      />
    </div>
  );
}

/* ---- Sort-tasks popover: order + (when the view has nested tasks) the parent/child scope -------
   Both lists show directly. With no nesting, the order is the only decision, so picking it closes;
   when the scope picker is present the popover stays open until you pick a scope (the final say). */
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
      <ChoiceList
        value={sortBy}
        options={SORT_OPTIONS}
        autoFocus
        onPick={(v) => {
          onSortBy(v as SortBy);
          if (!hasNesting) onClose();
        }}
      />
      {hasNesting && (
        <>
          <div className="tasks-pop-label">Some tasks have children — apply sort to</div>
          <ChoiceList
            value={scope}
            options={SORT_SCOPE_OPTIONS}
            onPick={(v) => {
              onScope(v as SortScope);
              onClose();
            }}
          />
        </>
      )}
    </div>
  );
}
