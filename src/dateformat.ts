// Tiny, dependency-free date/time formatter driven by user-configurable patterns.
// Tokens are the familiar moment/day.js subset so format strings stay discoverable in the
// settings UI ("YYYY-MM-DD", "DD/MM/YYYY HH:mm", …). Everything renders in LOCAL time — these
// notes are personal and local-first, so we never surprise the user with UTC.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

/**
 * Supported tokens (longest-match-first so "YYYY" wins over "YY"):
 *   YYYY 2026   YY 26      year
 *   MMMM March  MMM Mar    MM 03    M 3        month
 *   DD 09       D 9        day of month
 *   dddd Monday ddd Mon                        weekday
 *   HH 14       H 14       hh 02    h 2         hour (24h / 12h)
 *   mm 05       m 5        minute
 *   ss 09       s 9        second
 *   A PM        a pm                           meridiem
 * Anything inside [square brackets] is emitted literally (e.g. "[Week] ww").
 */
const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a/g;

export function formatDate(date: Date, pattern: string): string {
  if (isNaN(date.getTime())) return "";
  const h12 = date.getHours() % 12 || 12;
  return pattern.replace(TOKEN, (tok, literal) => {
    if (literal !== undefined) return literal;
    switch (tok) {
      case "YYYY": return String(date.getFullYear());
      case "YY": return pad(date.getFullYear() % 100);
      case "MMMM": return MONTHS[date.getMonth()];
      case "MMM": return MONTHS[date.getMonth()].slice(0, 3);
      case "MM": return pad(date.getMonth() + 1);
      case "M": return String(date.getMonth() + 1);
      case "DD": return pad(date.getDate());
      case "D": return String(date.getDate());
      case "dddd": return DAYS[date.getDay()];
      case "ddd": return DAYS[date.getDay()].slice(0, 3);
      case "HH": return pad(date.getHours());
      case "H": return String(date.getHours());
      case "hh": return pad(h12);
      case "h": return String(h12);
      case "mm": return pad(date.getMinutes());
      case "m": return String(date.getMinutes());
      case "ss": return pad(date.getSeconds());
      case "s": return String(date.getSeconds());
      case "A": return date.getHours() < 12 ? "AM" : "PM";
      case "a": return date.getHours() < 12 ? "am" : "pm";
      default: return tok;
    }
  });
}

/** Parse an ISO date (YYYY-MM-DD) as a LOCAL calendar day, avoiding the UTC shift `new Date(str)` causes. */
export function parseISODate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return new Date(iso);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

/** Curated date presets offered in settings. The value IS the pattern. */
export const DATE_PRESETS: { value: string; label: string }[] = [
  { value: "YYYY-MM-DD", label: "2026-06-21 (ISO)" },
  { value: "DD/MM/YYYY", label: "21/06/2026" },
  { value: "MM/DD/YYYY", label: "06/21/2026" },
  { value: "D MMMM YYYY", label: "21 June 2026" },
  { value: "MMMM D, YYYY", label: "June 21, 2026" },
  { value: "ddd, D MMM YYYY", label: "Sat, 21 Jun 2026" },
  { value: "dddd, MMMM D", label: "Saturday, June 21" },
];

/** Curated time presets. */
export const TIME_PRESETS: { value: string; label: string }[] = [
  { value: "HH:mm", label: "14:30 (24-hour)" },
  { value: "HH:mm:ss", label: "14:30:05" },
  { value: "h:mm A", label: "2:30 PM (12-hour)" },
  { value: "h:mm:ss A", label: "2:30:05 PM" },
];
