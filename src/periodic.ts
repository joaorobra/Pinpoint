// Native periodic notes: daily, weekly, monthly, quarterly, semestral, yearly.
//
// Each maps to a deterministic path under <vault>/<periodicFolder>/<Kind>/<file>.md and a starter
// template. Navigation (prev/next/today) is pure date math so it works offline and cross-platform.

import { formatDate } from "./dateformat";

export type Period = "daily" | "weekly" | "monthly" | "quarterly" | "semestral" | "yearly";

export const PERIODS: Period[] = ["daily", "weekly", "monthly", "quarterly", "semestral", "yearly"];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function isoWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
    );
  return { year: date.getUTCFullYear(), week };
}

/** The vault-relative path for a period note covering `date`. */
export function pathFor(folder: string, period: Period, date: Date): string {
  const y = date.getFullYear();
  const month = date.getMonth(); // 0-based
  const q = Math.floor(month / 3) + 1;
  const half = month < 6 ? 1 : 2;
  switch (period) {
    case "daily":
      return `${folder}/Daily/${y}-${pad(month + 1)}-${pad(date.getDate())}.md`;
    case "weekly": {
      const { year, week } = isoWeek(date);
      return `${folder}/Weekly/${year}-W${pad(week)}.md`;
    }
    case "monthly":
      return `${folder}/Monthly/${y}-${pad(month + 1)}.md`;
    case "quarterly":
      return `${folder}/Quarterly/${y}-Q${q}.md`;
    case "semestral":
      return `${folder}/Semestral/${y}-H${half}.md`;
    case "yearly":
      return `${folder}/Yearly/${y}.md`;
  }
}

/**
 * A human label for the note covering `date`. For daily notes, `dailyFormat` is a dateformat.ts
 * pattern (e.g. "dddd, MMMM D"); omitting it falls back to the native `Date#toDateString`.
 */
export function labelFor(period: Period, date: Date, dailyFormat?: string): string {
  const y = date.getFullYear();
  const q = Math.floor(date.getMonth() / 3) + 1;
  const half = date.getMonth() < 6 ? 1 : 2;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  switch (period) {
    case "daily":
      return dailyFormat ? formatDate(date, dailyFormat) : date.toDateString();
    case "weekly": {
      const { year, week } = isoWeek(date);
      return `Week ${week}, ${year}`;
    }
    case "monthly":
      return `${months[date.getMonth()]} ${y}`;
    case "quarterly":
      return `Q${q} ${y}`;
    case "semestral":
      return `H${half} ${y}`;
    case "yearly":
      return `${y}`;
  }
}

/** Step a date forward/back by one unit of the period. */
export function step(period: Period, date: Date, dir: 1 | -1): Date {
  const d = new Date(date);
  switch (period) {
    case "daily":
      d.setDate(d.getDate() + dir);
      break;
    case "weekly":
      d.setDate(d.getDate() + 7 * dir);
      break;
    case "monthly":
      d.setMonth(d.getMonth() + dir);
      break;
    case "quarterly":
      d.setMonth(d.getMonth() + 3 * dir);
      break;
    case "semestral":
      d.setMonth(d.getMonth() + 6 * dir);
      break;
    case "yearly":
      d.setFullYear(d.getFullYear() + dir);
      break;
  }
  return d;
}

/** ISO date (YYYY-MM-DD) in local time. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The inclusive [start, end] calendar window a period note covers, as ISO dates. Used to build the
 * pre-query that surfaces tasks due within the period. Weeks are ISO (Mon–Sun).
 */
export function periodRange(period: Period, date: Date): { start: string; end: string } {
  const y = date.getFullYear();
  const m = date.getMonth();
  switch (period) {
    case "daily":
      return { start: isoDate(date), end: isoDate(date) };
    case "weekly": {
      // Back up to Monday, forward to Sunday.
      const day = (date.getDay() + 6) % 7; // 0 = Monday
      const mon = new Date(y, m, date.getDate() - day);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      return { start: isoDate(mon), end: isoDate(sun) };
    }
    case "monthly":
      return { start: isoDate(new Date(y, m, 1)), end: isoDate(new Date(y, m + 1, 0)) };
    case "quarterly": {
      const qStart = Math.floor(m / 3) * 3;
      return { start: isoDate(new Date(y, qStart, 1)), end: isoDate(new Date(y, qStart + 3, 0)) };
    }
    case "semestral": {
      const hStart = m < 6 ? 0 : 6;
      return { start: isoDate(new Date(y, hStart, 1)), end: isoDate(new Date(y, hStart + 6, 0)) };
    }
    case "yearly":
      return { start: isoDate(new Date(y, 0, 1)), end: isoDate(new Date(y, 11, 31)) };
  }
}

/**
 * Pre-query blocks for a period note: an inline query block (```query fences) listing tasks due
 * inside the period, plus one listing recurring tasks (whose upcoming occurrences the block expands
 * client-side). These render live in the editor via the QueryBlock node.
 */
function taskQueries(period: Period, date: Date): string {
  const { start, end } = periodRange(period, date);
  const due = `\`\`\`query\nTASK WHERE due >= "${start}" AND due <= "${end}" AND done = false SORT due\n\`\`\``;
  const recurring = `\`\`\`query\nTASK WHERE recurring = true AND done = false SORT due\n\`\`\``;
  const windowLabel: Record<Period, string> = {
    daily: "Due today",
    weekly: "Due this week",
    monthly: "Due this month",
    quarterly: "Due this quarter",
    semestral: "Due this semester",
    yearly: "Due this year",
  };
  return `## ${windowLabel[period]}\n\n${due}\n\n## Recurring\n\n${recurring}\n`;
}

/** Starter template body for a fresh period note. */
export function template(period: Period, date: Date, dailyFormat?: string): string {
  const label = labelFor(period, date, dailyFormat);
  const tasks = taskQueries(period, date);
  const sections: Record<Period, string> = {
    daily: `# ${label}\n\n${tasks}\n## Tasks\n- [ ] \n\n## Notes\n\n## Log\n`,
    weekly: `# ${label}\n\n## Focus\n\n${tasks}\n## Tasks\n- [ ] \n\n## Review\n`,
    monthly: `# ${label}\n\n## Goals\n\n${tasks}\n## Highlights\n\n## Review\n`,
    quarterly: `# ${label}\n\n## Objectives\n\n${tasks}\n## Key Results\n\n## Review\n`,
    semestral: `# ${label}\n\n## Theme\n\n${tasks}\n## Objectives\n\n## Review\n`,
    yearly: `# ${label}\n\n## Vision\n\n${tasks}\n## Goals\n\n## Review\n`,
  };
  return sections[period];
}

/** Monday (local time) of the given ISO week-year — the inverse of `isoWeek`. */
export function isoWeekStart(year: number, week: number): Date {
  // ISO week 1 is the week containing Jan 4th; find that week's Monday, then add (week-1) weeks.
  const jan4 = new Date(year, 0, 4);
  const jan4Dow = (jan4.getDay() + 6) % 7; // 0 = Monday
  const week1Monday = new Date(year, 0, 4 - jan4Dow);
  week1Monday.setDate(week1Monday.getDate() + (week - 1) * 7);
  week1Monday.setHours(0, 0, 0, 0);
  return week1Monday;
}

/** Subfolder name (as produced by `pathFor`) → period. */
const FOLDER_TO_PERIOD: Record<string, Period> = {
  Daily: "daily",
  Weekly: "weekly",
  Monthly: "monthly",
  Quarterly: "quarterly",
  Semestral: "semestral",
  Yearly: "yearly",
};

/**
 * Reverse of `pathFor`: given a page's vault-relative path and the configured periodic folder,
 * recover which period note it is and the date it represents (the period's start), or null if the
 * path isn't a periodic note. The returned date is local-midnight at the start of the period (e.g.
 * Monday for a week, the 1st for a month), suitable for feeding back into `pathFor`/`labelFor`/`step`.
 */
export function periodFromPath(relPath: string, folder: string): { period: Period; date: Date } | null {
  const norm = relPath.replace(/\\/g, "/");
  const prefix = `${folder.replace(/\/+$/, "")}/`;
  if (!norm.startsWith(prefix)) return null;
  const rest = norm.slice(prefix.length); // e.g. "Weekly/2026-W26.md"
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const sub = rest.slice(0, slash);
  const file = rest.slice(slash + 1).replace(/\.md$/i, "");
  const period = FOLDER_TO_PERIOD[sub];
  if (!period) return null;

  let m: RegExpMatchArray | null;
  switch (period) {
    case "daily":
      m = file.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? { period, date: new Date(+m[1], +m[2] - 1, +m[3]) } : null;
    case "weekly":
      m = file.match(/^(\d{4})-W(\d{2})$/);
      return m ? { period, date: isoWeekStart(+m[1], +m[2]) } : null;
    case "monthly":
      m = file.match(/^(\d{4})-(\d{2})$/);
      return m ? { period, date: new Date(+m[1], +m[2] - 1, 1) } : null;
    case "quarterly":
      m = file.match(/^(\d{4})-Q([1-4])$/);
      return m ? { period, date: new Date(+m[1], (+m[2] - 1) * 3, 1) } : null;
    case "semestral":
      m = file.match(/^(\d{4})-H([12])$/);
      return m ? { period, date: new Date(+m[1], (+m[2] - 1) * 6, 1) } : null;
    case "yearly":
      m = file.match(/^(\d{4})$/);
      return m ? { period, date: new Date(+m[1], 0, 1) } : null;
  }
}
