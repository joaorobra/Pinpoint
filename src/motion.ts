// Shared motion tokens for Framer Motion, kept in lock-step with the CSS design system.
//
// The app's CSS already defines the motion language in styles.css:
//     --ease: cubic-bezier(0.32, 0.72, 0, 1);   --dur: 140ms;
// Framer Motion can't read CSS custom properties for its `ease`/`duration`, so we mirror the same
// curve and timings here. Import from this module instead of hand-writing `ease: [...]` / `duration`
// inline, so every animated surface shares one feel and a single place to tune it.
//
// Reduced motion: `prefersReducedMotion()` reads the OS setting once at call time. The exported
// helpers collapse to near-instant, movement-free transitions when it's on, so we honour
// `prefers-reduced-motion` for JS-driven motion the same way the CSS does for keyframes.

import type { Transition } from "framer-motion";

/** The design system's standard easing curve (matches `--ease` in styles.css). */
export const EASE = [0.32, 0.72, 0, 1] as const;

/** Duration scale in seconds (Framer Motion works in seconds; CSS `--dur` is 140ms). */
export const DUR = {
  /** Micro-interactions: popovers, palette, small toggles. Mirrors `--dur` (140ms). */
  fast: 0.14,
  /** Panel/section transitions: sidebars, view crossfades. */
  base: 0.2,
  /** Larger surfaces that slide a longer distance. */
  slow: 0.26,
} as const;

/** True when the user has asked the OS to minimise non-essential motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Build an eased `transition` at one of the named durations. When reduced-motion is on, every
 * transition collapses to a 1-frame fade so state still changes visibly without travel or scaling.
 */
export function transition(speed: keyof typeof DUR = "base"): Transition {
  if (prefersReducedMotion()) return { duration: 0.01 };
  return { duration: DUR[speed], ease: EASE };
}

/**
 * A reusable enter/exit variant set: fade + a small offset along one axis. Reduced-motion drops the
 * offset and scale so only opacity changes. Pass the axis/distance to suit the surface
 * (e.g. a left panel slides from -24 on x; a popover lifts from -6 on y).
 */
export function slideFade(opts: {
  axis?: "x" | "y";
  distance?: number;
  scale?: number;
  speed?: keyof typeof DUR;
} = {}) {
  const { axis = "y", distance = 8, scale, speed = "base" } = opts;
  const reduce = prefersReducedMotion();
  const offset = reduce ? 0 : distance;
  const from: Record<string, number> = { opacity: 0, [axis]: offset };
  const to: Record<string, number> = { opacity: 1, [axis]: 0 };
  if (scale !== undefined && !reduce) {
    from.scale = scale;
    to.scale = 1;
  }
  return {
    initial: from,
    animate: to,
    exit: from,
    transition: transition(speed),
  };
}
