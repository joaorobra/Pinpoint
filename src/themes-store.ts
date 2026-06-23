// Theme data layer: typed CRUD over the raw-JSON theme storage exposed by `api` (which proxies to
// either the Tauri or the web FSA backend). Keeps the JSON (de)serialization and validation in one
// place so the UI works with `Theme` objects, never strings.

import { api } from "./api";
import { BUILTIN_THEME, STARTER_THEMES } from "./types";
import type { Theme, ThemeColors, ThemeInfo, ThemeVariant } from "./types";

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
  const fonts =
    o.fonts && typeof o.fonts === "object"
      ? {
          ui: typeof o.fonts.ui === "string" ? o.fonts.ui : undefined,
          editor: typeof o.fonts.editor === "string" ? o.fonts.editor : undefined,
        }
      : undefined;
  return {
    name,
    dark: variant(o.dark, BUILTIN_THEME.dark),
    light: variant(o.light, BUILTIN_THEME.light),
    ...(fonts && (fonts.ui || fonts.editor) ? { fonts } : {}),
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
    hasFonts: !!(t.fonts && (t.fonts.ui || t.fonts.editor)),
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
    ...(src.fonts ? { fonts: { ...src.fonts } } : {}),
  };
}
