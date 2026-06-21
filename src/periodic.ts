// Native periodic notes: daily, weekly, monthly, quarterly, semestral, yearly.
//
// Each maps to a deterministic path under <vault>/<periodicFolder>/<Kind>/<file>.md and a starter
// template. Navigation (prev/next/today) is pure date math so it works offline and cross-platform.

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

/** A human label for the note covering `date`. */
export function labelFor(period: Period, date: Date): string {
  const y = date.getFullYear();
  const q = Math.floor(date.getMonth() / 3) + 1;
  const half = date.getMonth() < 6 ? 1 : 2;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  switch (period) {
    case "daily":
      return date.toDateString();
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

/** Starter template body for a fresh period note. */
export function template(period: Period, date: Date): string {
  const label = labelFor(period, date);
  const sections: Record<Period, string> = {
    daily: `# ${label}\n\n## Tasks\n- [ ] \n\n## Notes\n\n## Log\n`,
    weekly: `# ${label}\n\n## Focus\n\n## Tasks\n- [ ] \n\n## Review\n`,
    monthly: `# ${label}\n\n## Goals\n\n## Highlights\n\n## Review\n`,
    quarterly: `# ${label}\n\n## Objectives\n\n## Key Results\n\n## Review\n`,
    semestral: `# ${label}\n\n## Theme\n\n## Objectives\n\n## Review\n`,
    yearly: `# ${label}\n\n## Vision\n\n## Goals\n\n## Review\n`,
  };
  return sections[period];
}
