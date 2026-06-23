// Theme data layer: typed CRUD over the raw-JSON theme storage exposed by `api` (which proxies to
// either the Tauri or the web FSA backend). Keeps the JSON (de)serialization and validation in one
// place so the UI works with `Theme` objects, never strings.

import { api } from "./api";
import { BUILTIN_THEME, STARTER_THEMES } from "./types";
import type { Theme, ThemeColors, ThemeInfo, ThemeType, ThemeVariant } from "./types";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Coerce an unknown value to a hex color, falling back to `fb` when it isn't one. */
function hex(v: unknown, fb: string): string {
  return typeof v === "string" && HEX.test(v.trim()) ? v.trim() : fb;
}

/** Validate/normalize a colors object against a fallback variant, so a hand-edited file can't break the UI. */
function colors(raw: unknown, fb: ThemeColors): ThemeColors {
  const o = (raw ?? {}) as Partial<ThemeColors>;
  return {
    accent: hex(o.accent, fb.accent),
    bg: hex(o.bg, fb.bg),
    surface: hex(o.surface, fb.surface),
    text: hex(o.text, fb.text),
    dim: hex(o.dim, fb.dim),
    border: hex(o.border, fb.border),
  };
}

function variant(raw: unknown, fb: ThemeVariant): ThemeVariant {
  const o = (raw ?? {}) as { colors?: unknown };
  return { colors: colors(o.colors, fb.colors) };
}

/** A finite positive number, else undefined — guards size/lineHeight/pageWidth from bad JSON. */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined;

/**
 * Normalize a theme's typography block, migrating the legacy `fonts` field into `type`. Each field
 * is optional; an all-empty result returns undefined so palette-only themes stay font-neutral.
 */
function typography(rawType: unknown, rawFonts: unknown): ThemeType | undefined {
  const t = (rawType ?? {}) as Partial<ThemeType>;
  const f = (rawFonts ?? {}) as { ui?: unknown; editor?: unknown };
  const type: ThemeType = {
    ui: str(t.ui) ?? str(f.ui),
    editor: str(t.editor) ?? str(f.editor),
    size: num(t.size),
    lineHeight: num(t.lineHeight),
    pageWidth: num(t.pageWidth),
  };
  // Drop undefined keys so the persisted JSON stays clean.
  for (const k of Object.keys(type) as (keyof ThemeType)[]) {
    if (type[k] === undefined) delete type[k];
  }
  return Object.keys(type).length ? type : undefined;
}

/** Parse one raw theme JSON string into a validated `Theme`, or null if it's unusable. */
function parseTheme(json: string): Theme | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const o = raw as Partial<Theme>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return null;
  const type = typography(o.type, o.fonts);
  return {
    name,
    dark: variant(o.dark, BUILTIN_THEME.dark),
    light: variant(o.light, BUILTIN_THEME.light),
    ...(type ? { type } : {}),
  };
}

/** All themes in the vault, name-sorted. Invalid files are skipped. */
export async function listThemes(): Promise<Theme[]> {
  const blobs = await api.listThemes();
  const themes = blobs.map(parseTheme).filter((t): t is Theme => t !== null);
  themes.sort((a, b) => a.name.localeCompare(b.name));
  return themes;
}

/** Lightweight gallery rows (name + both palettes for the preview swatches). */
export async function listThemeInfos(): Promise<ThemeInfo[]> {
  const themes = await listThemes();
  return themes.map((t) => ({
    name: t.name,
    dark: t.dark.colors,
    light: t.light.colors,
    hasType: !!t.type,
  }));
}

/** Load one theme by name (returns null if missing/invalid). */
export async function getTheme(name: string): Promise<Theme | null> {
  try {
    return parseTheme(await api.readTheme(name));
  } catch {
    return null;
  }
}

/** Persist a theme (pretty-printed). The file stem is the theme's name. */
export async function saveTheme(theme: Theme): Promise<void> {
  await api.writeTheme(theme.name, JSON.stringify(theme, null, 2));
}

export async function deleteTheme(name: string): Promise<void> {
  await api.deleteTheme(name);
}

/** Rename a theme: move its file then rewrite the body so the in-file `name` matches the new stem. */
export async function renameTheme(theme: Theme, to: string): Promise<void> {
  await api.renameTheme(theme.name, to);
  await saveTheme({ ...theme, name: to });
}

/** Seed curated starters into a vault that has none yet. Safe to call on every vault open. */
export async function seedStarterThemes(): Promise<void> {
  const starters: [string, string][] = STARTER_THEMES.map((t) => [
    t.name,
    JSON.stringify(t, null, 2),
  ]);
  try {
    await api.seedThemes(starters);
  } catch {
    /* non-fatal: a vault with no themes just shows the built-in default */
  }
}

/** A fresh, unsaved theme cloned from an existing one (or the built-in), with a new name. */
export function duplicateTheme(src: Theme, name: string): Theme {
  return {
    name,
    dark: { colors: { ...src.dark.colors } },
    light: { colors: { ...src.light.colors } },
    ...(src.type ? { type: { ...src.type } } : {}),
  };
}
