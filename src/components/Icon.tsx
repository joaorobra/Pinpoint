// Lightweight icon rendering used throughout the app (file tree, editor header).
//
// To keep the main bundle small, this module does NOT import the full Phosphor set. Instead, when a
// node has a *custom* chosen icon, we resolve that one icon's component by lazy-loading the heavy
// registry (./icon-registry) on demand and caching the result. Nodes without a custom icon render
// their statically-imported fallback with zero extra cost — the overwhelmingly common case.

import { useEffect, useState } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { NodeIcon } from "../types";

// Resolved icon components, cached across the app once the registry has loaded.
const resolved = new Map<string, PhosphorIcon>();
let registryPromise: Promise<typeof import("./icon-registry")> | null = null;

function loadRegistry() {
  if (!registryPromise) registryPromise = import("./icon-registry");
  return registryPromise;
}

/**
 * Resolve a chosen icon name to its component. Returns the cached component synchronously when
 * already loaded; otherwise returns null and triggers `onReady` once the registry resolves.
 */
function useResolvedIcon(name: string | undefined): PhosphorIcon | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!name || resolved.has(name)) return;
    let alive = true;
    loadRegistry().then((reg) => {
      const cmp = reg.iconComponent(name);
      if (cmp) resolved.set(name, cmp);
      if (alive) force((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [name]);
  return name ? resolved.get(name) ?? null : null;
}

interface NodeIconViewProps {
  icon: NodeIcon | undefined;
  /** Component shown when no custom icon is set (or while the chosen one is still loading). */
  fallback: PhosphorIcon;
  /** Default color when the icon has no color of its own. */
  fallbackColor?: string;
  size?: number;
  className?: string;
}

/**
 * Render a node's icon: the user's chosen Phosphor icon when set, otherwise the supplied fallback.
 * Color falls back to `currentColor` so it inherits the surrounding text color unless overridden.
 */
export function NodeIconView({ icon, fallback, fallbackColor, size = 16, className }: NodeIconViewProps) {
  const Resolved = useResolvedIcon(icon?.name);
  const Cmp = Resolved ?? fallback;
  const color = icon?.color || fallbackColor || "currentColor";
  const weight = icon?.weight ?? "regular";
  return <Cmp size={size} color={color} weight={weight} className={className} />;
}
