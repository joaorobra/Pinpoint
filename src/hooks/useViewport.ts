import { useEffect, useMemo, useState } from "react";

// Responsive breakpoints. Keep these literals in sync with the @media queries in styles.css —
// CSS owns its own copies (it can't read JS), so the two must agree by hand. A width AT the max
// belongs to that bucket: <=639 is mobile, <=959 is tablet, the rest is desktop.
export const MOBILE_MAX = 639;
export const TABLET_MAX = 959;

export type Breakpoint = "mobile" | "tablet" | "desktop";

export interface Viewport {
  width: number;
  breakpoint: Breakpoint;
  isMobile: boolean;
  isTablet: boolean;
  isTouch: boolean;
}

function bpFor(width: number): Breakpoint {
  if (width <= MOBILE_MAX) return "mobile";
  if (width <= TABLET_MAX) return "tablet";
  return "desktop";
}

// Touch detection: a device with no hover or a coarse pointer is treated as touch, which flips the
// hover-only affordances on (see the @media (hover: none) block in styles.css). Read once and watch
// for changes (e.g. plugging in a mouse on a 2-in-1).
const touchQuery = "(hover: none), (pointer: coarse)";

/**
 * Current viewport size, breakpoint, and touch-ness. Tauri's webview always has `window`, so no SSR
 * guard is needed. A single passive resize listener updates state, and it bails when neither the
 * width nor the breakpoint changed so unrelated resizes don't re-render the whole app.
 */
export function useViewport(): Viewport {
  const [width, setWidth] = useState<number>(() => window.innerWidth);
  const [isTouch, setIsTouch] = useState<boolean>(
    () => window.matchMedia(touchQuery).matches
  );

  useEffect(() => {
    const onResize = () => {
      // Only re-render when the width actually changed; React bails on an identical value.
      setWidth(window.innerWidth);
    };
    window.addEventListener("resize", onResize, { passive: true });

    const mq = window.matchMedia(touchQuery);
    const onTouch = (e: MediaQueryListEvent) => setIsTouch(e.matches);
    mq.addEventListener("change", onTouch);

    return () => {
      window.removeEventListener("resize", onResize);
      mq.removeEventListener("change", onTouch);
    };
  }, []);

  const breakpoint = bpFor(width);
  return useMemo<Viewport>(
    () => ({
      width,
      breakpoint,
      isMobile: breakpoint === "mobile",
      isTablet: breakpoint === "tablet",
      isTouch,
    }),
    [width, breakpoint, isTouch]
  );
}
