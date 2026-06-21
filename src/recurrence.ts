// Recurrence: rule-based, virtual occurrences.
//
// A task line carries a recurrence rule via `🔁 <rule>` or `repeat:: <rule>`. We accept either a
// natural shorthand ("every week", "every 2 days", "monthly") or a raw RRULE string
// ("FREQ=WEEKLY;INTERVAL=1"). Future occurrences are computed on the fly — never materialized.

import { RRule, RRuleSet, rrulestr } from "rrule";

const FREQ: Record<string, number> = {
  day: RRule.DAILY,
  daily: RRule.DAILY,
  week: RRule.WEEKLY,
  weekly: RRule.WEEKLY,
  month: RRule.MONTHLY,
  monthly: RRule.MONTHLY,
  quarter: RRule.MONTHLY, // interval 3
  year: RRule.YEARLY,
  yearly: RRule.YEARLY,
};

/** Parse a shorthand or raw RRULE into an RRule, anchored at `start`. Returns null if unparseable. */
export function parseRule(rule: string, start: Date): RRule | RRuleSet | null {
  const trimmed = rule.trim();
  try {
    if (/FREQ=/i.test(trimmed)) {
      return rrulestr(trimmed, { dtstart: start }) as RRule;
    }
    // shorthand: "every [n] <unit>"
    const m = trimmed.toLowerCase().match(/^(?:every\s+)?(\d+)?\s*([a-z]+)/);
    if (m) {
      const interval = m[1] ? parseInt(m[1], 10) : trimmed.toLowerCase().startsWith("quarter") ? 3 : 1;
      const unit = m[2];
      const freq = FREQ[unit];
      if (freq === undefined) return null;
      return new RRule({
        freq,
        interval: unit.startsWith("quarter") ? 3 : interval,
        dtstart: start,
      });
    }
  } catch {
    return null;
  }
  return null;
}

export interface Occurrence {
  date: Date;
  iso: string;
}

/** Compute up to `count` upcoming occurrences from `from` (inclusive), bounded for "show all ahead". */
export function upcoming(
  rule: string,
  start: Date,
  from: Date,
  count = 12
): Occurrence[] {
  const r = parseRule(rule, start);
  if (!r) return [];
  const horizon = new Date(from);
  horizon.setFullYear(horizon.getFullYear() + 2); // 2-year safety horizon
  const dates = r.between(from, horizon, true).slice(0, count);
  return dates.map((d) => ({ date: d, iso: d.toISOString().slice(0, 10) }));
}
