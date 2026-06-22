// The FULL Phosphor icon set — every icon, every weight. This module is intentionally heavy
// (`import * as Phosphor` pulls in ~1500 icons), so it is loaded lazily: only the icon picker and
// the on-demand resolver below import it, and both are reached through dynamic import() so the main
// app bundle stays small. Do NOT import this module eagerly from App/FileTree.

import * as Phosphor from "@phosphor-icons/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

// Members of the namespace that are NOT selectable icons.
const NON_ICON = new Set(["IconContext", "IconBase", "SSR"]);

type IconModule = Record<string, unknown>;

/** Every Phosphor icon name (PascalCase), sorted alphabetically. Computed once. */
export const ALL_ICON_NAMES: string[] = Object.keys(Phosphor as IconModule)
  .filter((k) => /^[A-Z]/.test(k) && !NON_ICON.has(k))
  .filter((k) => {
    const v = (Phosphor as IconModule)[k];
    return typeof v === "object" || typeof v === "function";
  })
  .sort((a, b) => a.localeCompare(b));

const ICON_NAME_SET = new Set(ALL_ICON_NAMES);

/** Resolve an icon name to its Phosphor component, or null if unknown. */
export function iconComponent(name: string): PhosphorIcon | null {
  if (!ICON_NAME_SET.has(name)) return null;
  return (Phosphor as IconModule)[name] as PhosphorIcon;
}

/** A loose, case-insensitive substring search over the icon names. */
export function searchIcons(query: string, limit = 300): string[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return ALL_ICON_NAMES.slice(0, limit);
  const out: string[] = [];
  for (const name of ALL_ICON_NAMES) {
    if (name.toLowerCase().includes(q)) {
      out.push(name);
      if (out.length >= limit) break;
    }
  }
  return out;
}
