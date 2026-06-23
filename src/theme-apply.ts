// Theme application engine. Pure functions that turn a stored Theme + the active appearance
// (dark / light / system) into the set of CSS custom properties to push onto the document root.
//
// The design system (styles.css) derives every accent and surface effect from a handful of base
// tokens via color-mix, so we only ever need to set those base tokens; hovers, rings, tints, the
// elevation/border ramp and the contrast color all recompute automatically. Setting them inline on
// :root wins over the stylesheet's :root rules, exactly like the existing `--accent` push in App.

import type { Theme, ThemeColors, ThemeVariant } from "./types";

/** The resolved appearance: which variant of a theme is showing. "system" follows the OS. */
export type ResolvedMode = "dark" | "light";

/** Resolve the Appearance setting to a concrete variant, consulting the OS for "system". */
export function resolveMode(theme: "dark" | "light" | "system"): ResolvedMode {
  if (theme === "system") {
    const prefersLight =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: light)").matches;
    return prefersLight ? "light" : "dark";
  }
  return theme;
}

/**
 * Relative luminance (WCAG) of a #rrggbb color, 0 (black) – 1 (white). Used to derive a readable
 * on-accent contrast color and a couple of faint/strong shades from the theme's own colors, so the
 * theme stays internally consistent without asking the user for every token.
 */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** Pick black or white text for legibility on top of `bg`. */
function contrastOn(bg: string): string {
  return luminance(bg) > 0.45 ? "#000000" : "#ffffff";
}

/**
 * The CSS custom properties a theme variant maps to. Keys are the exact token names from styles.css.
 * We set the six core tokens the user controls plus the few derived ones that aren't already a
 * color-mix of a core token (the surface ramp `--bg-2/3/hover`, the strong border, the faint text
 * and the accent's contrast color), so layered surfaces and disabled/hover states track the theme.
 */
export function variantToVars(v: ThemeVariant, mode: ResolvedMode): Record<string, string> {
  const c: ThemeColors = v.colors;
  // Surface ramp: nudge bg toward (light mode) or away from (dark mode) the text color so the
  // raised/hover layers read correctly in either polarity. color-mix in the *value* keeps it
  // resolution-independent and consistent with the rest of the system.
  const towardText = (pct: number) => `color-mix(in srgb, ${c.bg} ${100 - pct}%, ${c.text} ${pct}%)`;
  return {
    "--accent": c.accent,
    "--bg": c.bg,
    "--surface": c.surface,
    "--text": c.text,
    "--text-dim": c.dim,
    "--border": c.border,
    // Derived, but not a plain mix of a single core token — so we compute them here.
    "--bg-2": towardText(3),
    "--bg-3": towardText(7),
    "--bg-hover": towardText(11),
    "--border-strong": `color-mix(in srgb, ${c.border} 70%, ${c.text} 30%)`,
    "--text-faint": `color-mix(in srgb, ${c.dim} 60%, ${c.bg} 40%)`,
    "--accent-contrast": contrastOn(c.accent),
    // Shadows read heavier on light surfaces; match the stock light-theme tuning.
    "--shadow-color": mode === "light" ? "240deg 30% 30%" : "0deg 0% 0%",
    "--shadow-strength": mode === "light" ? "0.5" : "1",
  };
}

/** The token names a theme manages — used to cleanly remove them when no theme is active. */
export const THEME_VAR_KEYS = Object.keys(
  variantToVars({ colors: { accent: "", bg: "", surface: "", text: "", dim: "", border: "" } }, "dark")
);

/**
 * Apply (or clear) a theme on the document root. Passing `null` removes every theme-managed token so
 * the stock stylesheet values take back over. `mode` is the already-resolved variant to show.
 * Returns nothing; it mutates `:root`'s inline style, the same surface App uses for `--accent` etc.
 */
export function applyTheme(theme: Theme | null, mode: ResolvedMode): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!theme) {
    for (const k of THEME_VAR_KEYS) root.style.removeProperty(k);
    return;
  }
  const vars = variantToVars(mode === "light" ? theme.light : theme.dark, mode);
  for (const [k, val] of Object.entries(vars)) root.style.setProperty(k, val);
}
