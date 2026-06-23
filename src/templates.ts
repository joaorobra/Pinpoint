// Templates: reusable page/row bodies with {{variables}}, à la Notion/Obsidian.
//
// A template is just a plain `.md` file living under <vault>/<templatesFolder>/ (the folder is
// configurable in settings, like the Periodic folder). Its body IS the template; its frontmatter,
// if any, seeds the new page/row's frontmatter (after variable substitution). Because templates are
// ordinary pages, the user edits them with the normal editor and {{variables}} are just text.
//
// At insert time we substitute {{variables}}:
//   - built-in tokens resolve automatically (date/time/title/period…);
//   - any remaining {{custom}} token prompts the user once and fills every occurrence.
//
// This module is host-agnostic: it never touches the filesystem. Callers read a template's
// `ParsedDoc` via `api.readPage` and feed its body/frontmatter through `fillTemplate`.

import { formatDate } from "./dateformat";
import type { Period } from "./periodic";
import { labelFor, periodRange } from "./periodic";

/** Where templates are looked up by default (overridable via settings.templates_folder). */
export const DEFAULT_TEMPLATES_FOLDER = "Templates";

/** A template file discovered in the templates folder. */
export interface TemplateInfo {
  /** Vault-relative path to the `.md` file. */
  rel_path: string;
  /** Display name (file name without `.md`). */
  name: string;
}

/**
 * Walk a tree node and collect every `.md` page directly or transitively under `folderRel`.
 * The templates folder itself is matched by exact rel_path; subfolders nest as "Folder / Name".
 * Returns [] when the folder doesn't exist yet.
 */
export function collectTemplates(
  tree: { rel_path: string; name: string; is_dir: boolean; ext: string; children: any[] } | null,
  folderRel: string
): TemplateInfo[] {
  if (!tree || !folderRel) return [];
  // Find the templates folder node.
  let folder: any = null;
  const find = (n: any) => {
    if (folder) return;
    if (n.is_dir && n.rel_path === folderRel) { folder = n; return; }
    n.children?.forEach(find);
  };
  find(tree);
  if (!folder) return [];

  const out: TemplateInfo[] = [];
  const visit = (n: any, prefix: string) => {
    for (const c of n.children ?? []) {
      if (c.is_dir) {
        // Skip databases; recurse plain folders, prefixing nested names for disambiguation.
        if (!c.is_database) visit(c, prefix ? `${prefix} / ${c.name}` : c.name);
      } else if (!c.ext) {
        // `.md` pages carry ext === "" in this tree model.
        const leaf = c.name.replace(/\.md$/i, "");
        out.push({ rel_path: c.rel_path, name: prefix ? `${prefix} / ${leaf}` : leaf });
      }
    }
  };
  visit(folder, "");
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Formats used when resolving built-in date/time tokens. */
export interface TemplateFormats {
  dateFormat: string;
  timeFormat: string;
}

/**
 * A sentinel inserted where {{cursor}} appears. The editor finds it after inserting the filled
 * markdown and places the caret there (then deletes it). Non-editor creates strip it (see
 * `stripCursor`). Chosen to be vanishingly unlikely to occur in real prose.
 */
export const CURSOR_SENTINEL = "​⁣CURSOR⁣​";

/**
 * Context a template is filled against. `title` is the new page/row leaf name. `date` anchors the
 * date tokens (defaults to now). `period`/`periodDate` enable the periodic tokens for periodic
 * templates. `relPath`/`vaultName` drive the path tokens. `prompt` is asked for any non-built-in
 * {{token}} (labeled via `{{prompt:Label}}`); returning null cancels the fill.
 */
export interface FillContext {
  title?: string;
  date?: Date;
  formats: TemplateFormats;
  period?: Period;
  periodDate?: Date;
  dailyFormat?: string;
  /** Vault-relative path the new page will live at, for {{parent}}/{{parentPath}}/{{folder}}. */
  relPath?: string;
  /** The vault's display name, for {{vault}}. */
  vaultName?: string;
  /** Asks the user for a custom variable's value; `label` is the friendly prompt text. Null cancels. */
  prompt?: (key: string, label: string) => Promise<string | null>;
}

const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Random uuid without Web Crypto guarantees — fine for note ids; varies per call. */
function makeUuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Apply a `+Nd` / `-Nw` style offset (days/weeks/months/years) to a date. */
function shiftDate(base: Date, sign: number, n: number, unit: string): Date {
  const d = new Date(base);
  switch (unit) {
    case "d": d.setDate(d.getDate() + sign * n); break;
    case "w": d.setDate(d.getDate() + sign * n * 7); break;
    case "m": d.setMonth(d.getMonth() + sign * n); break;
    case "y": d.setFullYear(d.getFullYear() + sign * n); break;
  }
  return d;
}

/** Parent folder name + full folder path for a vault-relative file path. */
function pathParts(relPath?: string): { parent: string; parentPath: string } {
  if (!relPath) return { parent: "", parentPath: "" };
  const slash = relPath.replace(/\.md$/i, "").lastIndexOf("/");
  if (slash < 0) return { parent: "", parentPath: "" };
  const parentPath = relPath.slice(0, slash);
  const parent = parentPath.split("/").pop() ?? "";
  return { parent, parentPath };
}

/**
 * Resolve a single token name to its value, or `undefined` if it isn't a built-in (so the caller
 * knows to prompt). Token grammar:
 *   {{title}}                       new page/row name
 *   {{date}} {{time}}               user's configured date/time formats
 *   {{date:PATTERN}} {{time:PATTERN}}  explicit dateformat.ts pattern
 *   {{date+3d}} {{date-1w}}         offset by N days/weeks/months/years (d/w/m/y)
 *   {{date+1d:YYYY-MM-DD}}          offset + explicit format
 *   {{yesterday}} {{tomorrow}}      ±1 day in the default date format
 *   {{week}} {{weekday}} {{month}} {{year}}  parts of the anchor date
 *   {{parent}} {{folder}}          immediate parent folder name (aliases)
 *   {{parentPath}}                 full parent folder path
 *   {{vault}}                       vault name
 *   {{uuid}}                        a fresh unique id (per occurrence)
 *   {{cursor}}                      where the caret lands after insertion (editor only)
 *   {{period}} {{periodStart}} {{periodEnd}}  periodic templates only
 */
function resolveBuiltin(name: string, ctx: FillContext): string | undefined {
  const lower = name.toLowerCase();
  const at = ctx.date ?? new Date();
  const df = ctx.formats.dateFormat;

  if (lower === "title") return ctx.title ?? "";
  if (lower === "date") return formatDate(at, df);
  if (lower === "time") return formatDate(at, ctx.formats.timeFormat);
  if (lower === "yesterday") return formatDate(shiftDate(at, -1, 1, "d"), df);
  if (lower === "tomorrow") return formatDate(shiftDate(at, 1, 1, "d"), df);
  if (lower === "weekday") return formatDate(at, "dddd");
  if (lower === "month") return formatDate(at, "MMMM");
  if (lower === "year") return formatDate(at, "YYYY");
  if (lower === "week") return String(isoWeekNum(at));
  if (lower === "uuid") return makeUuid();
  if (lower === "cursor") return CURSOR_SENTINEL;

  // Date/time with an explicit format and/or an offset: date[+|-Nunit][:PATTERN].
  const dateMatch = /^(date|time)\s*(?:([+-])\s*(\d+)\s*([dwmy]))?\s*(?::(.+))?$/i.exec(name);
  if (dateMatch) {
    const [, kind, sign, num, unit, pattern] = dateMatch;
    let when = at;
    if (sign && num && unit) when = shiftDate(at, sign === "-" ? -1 : 1, parseInt(num, 10), unit.toLowerCase());
    const fmt = pattern?.trim() || (kind.toLowerCase() === "time" ? ctx.formats.timeFormat : df);
    return formatDate(when, fmt);
  }

  // Path tokens.
  if (lower === "parent" || lower === "folder") return pathParts(ctx.relPath).parent;
  if (lower === "parentpath") return pathParts(ctx.relPath).parentPath;
  if (lower === "vault") return ctx.vaultName ?? "";

  // Periodic-only tokens.
  if (ctx.period && ctx.periodDate) {
    if (lower === "period") return labelFor(ctx.period, ctx.periodDate, ctx.dailyFormat);
    if (lower === "periodstart") return periodRange(ctx.period, ctx.periodDate).start;
    if (lower === "periodend") return periodRange(ctx.period, ctx.periodDate).end;
  }
  return undefined;
}

/** ISO-8601 week number (1–53) for a date, in local time. */
function isoWeekNum(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  return 1 + Math.round(
    ((date.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
}

/**
 * A custom (non-built-in) variable: `key` is what we store the answer under (so repeats share one
 * prompt), `label` is the friendly text shown. `{{prompt:Ask something}}` sets the label; a bare
 * `{{client}}` uses the name as both.
 */
interface CustomVar { key: string; label: string; }

/** Parse a token into its custom-variable identity, or null if it's a built-in. */
function asCustom(rawName: string, ctx: FillContext): CustomVar | null {
  const name = rawName.trim();
  if (resolveBuiltin(name, ctx) !== undefined) return null;
  const labeled = /^prompt\s*:\s*(.+)$/i.exec(name);
  if (labeled) {
    const label = labeled[1].trim();
    return { key: `prompt:${label.toLowerCase()}`, label };
  }
  return { key: name.toLowerCase(), label: name };
}

/** The distinct custom variables referenced in a string, in first-seen order, de-duped by key. */
function customVariables(text: string, ctx: FillContext): CustomVar[] {
  const seen = new Map<string, CustomVar>();
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text))) {
    const v = asCustom(m[1], ctx);
    if (v && !seen.has(v.key)) seen.set(v.key, v);
  }
  return [...seen.values()];
}

/** Replace every {{token}} in a string given an already-resolved custom-variable map (keyed by key). */
function substitute(text: string, ctx: FillContext, custom: Record<string, string>): string {
  return text.replace(TOKEN_RE, (_full, raw) => {
    const name = String(raw).trim();
    const builtin = resolveBuiltin(name, ctx);
    if (builtin !== undefined) return builtin;
    const v = asCustom(name, ctx);
    return v ? custom[v.key] ?? "" : "";
  });
}

/** Remove any {{cursor}} sentinel(s) from filled text (for non-editor creates). */
export function stripCursor(text: string): string {
  return text.split(CURSOR_SENTINEL).join("");
}

/**
 * Fill a template's body (and optional frontmatter values) against `ctx`, prompting once per
 * distinct custom variable across BOTH body and frontmatter. Returns null if the user cancels a
 * prompt — callers should then abort the create/insert. Built-in tokens never prompt.
 */
export async function fillTemplate(
  body: string,
  frontmatter: Record<string, unknown> | undefined,
  ctx: FillContext
): Promise<{ body: string; frontmatter: Record<string, unknown> } | null> {
  // Gather custom variables from the body plus any string frontmatter values.
  const fmStrings = Object.values(frontmatter ?? {})
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  // De-dupe across body + frontmatter by variable key.
  const byKey = new Map<string, CustomVar>();
  for (const v of [...customVariables(body, ctx), ...customVariables(fmStrings, ctx)]) {
    if (!byKey.has(v.key)) byKey.set(v.key, v);
  }

  const custom: Record<string, string> = {};
  for (const v of byKey.values()) {
    const val = ctx.prompt ? await ctx.prompt(v.key, v.label) : "";
    if (val === null) return null; // cancelled
    custom[v.key] = val;
  }

  const outFm: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(frontmatter ?? {})) {
    outFm[k] = typeof val === "string" ? substitute(val, ctx, custom) : val;
  }
  return { body: substitute(body, ctx, custom), frontmatter: outFm };
}
