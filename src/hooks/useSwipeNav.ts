import { useEffect, type RefObject } from "react";

interface SwipeNavOptions {
  /** Finger moved right→left. Step toward the RIGHT pane (editor → right, left → editor). */
  onSwipeLeft: () => void;
  /** Finger moved left→right. Step toward the LEFT pane (editor → left, right → editor). */
  onSwipeRight: () => void;
  /** Only bind while true (mobile). */
  enabled: boolean;
}

// A committed horizontal swipe needs this much travel; below it the touch is a tap or scroll.
const COMMIT_PX = 60;
// How far the finger must move before we lock the gesture as horizontal or vertical. Small, so a
// vertical scroll is recognised early and never mistaken for a pane swipe.
const DIR_LOCK_PX = 12;
// Starting a swipe inside one of these means "not a pane gesture" — leave modals, menus, the bottom
// sheet, and single-line fields to their own touch handling.
const IGNORE_ORIGIN =
  '.sheet-backdrop, .modal-backdrop, .palette-backdrop, .ctx-menu, [role="dialog"], input, textarea, select';

/**
 * Walk from `target` up to `root`, returning true if some ancestor can still scroll horizontally in
 * the swipe direction. That lets inner horizontal scrollers (tables, the doc-tab strip, the toolbar,
 * code blocks) consume the gesture; only once they hit their edge does the pane swipe take over.
 * `dir` is "left" when the finger moves right→left (content would scroll further right) and "right"
 * otherwise.
 */
function innerScrollerWins(target: Element | null, root: Element, dir: "left" | "right"): boolean {
  for (let node = target; node && node !== root.parentElement; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.scrollWidth <= node.clientWidth + 1) continue;
    const ox = getComputedStyle(node).overflowX;
    if (ox !== "auto" && ox !== "scroll") continue;
    const maxScroll = node.scrollWidth - node.clientWidth;
    if (dir === "left" && node.scrollLeft < maxScroll - 1) return true;
    if (dir === "right" && node.scrollLeft > 1) return true;
  }
  return false;
}

/**
 * Pane-swipe navigation for mobile: a horizontal flick on `ref` moves between the left drawer, the
 * editor, and the right drawer (one step per swipe). Triggers the same slide animation the toggle
 * buttons do, so swipe and tap stay consistent. Vertical scrolls, inner horizontal scrollers, and
 * touches that start inside a modal/sheet/field are all left alone. Touch-only; non-destructive —
 * every pane is still reachable from the bottom navbar.
 */
export function useSwipeNav(
  ref: RefObject<HTMLElement | null>,
  { onSwipeLeft, onSwipeRight, enabled }: SwipeNavOptions
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let axis: "h" | "v" | null = null;

    const onStart = (e: TouchEvent) => {
      // Ignore multi-touch (pinch/zoom) and gestures that begin inside an overlay or text field.
      if (e.touches.length !== 1 || (e.target as Element)?.closest?.(IGNORE_ORIGIN)) {
        tracking = false;
        return;
      }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
      axis = null;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking || axis === "v") return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (axis === null) {
        if (Math.abs(dx) < DIR_LOCK_PX && Math.abs(dy) < DIR_LOCK_PX) return;
        axis = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
        // Hand a horizontal gesture to an inner scroller that still has room to scroll.
        if (axis === "h" && innerScrollerWins(e.target as Element, el, dx < 0 ? "left" : "right")) {
          tracking = false;
        }
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (!tracking || axis !== "h") {
        tracking = false;
        return;
      }
      tracking = false;
      const dx = e.changedTouches[0].clientX - startX;
      if (dx <= -COMMIT_PX) onSwipeLeft();
      else if (dx >= COMMIT_PX) onSwipeRight();
    };

    // Passive: we never preventDefault, so vertical scrolling stays smooth and we only act on release.
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [ref, enabled, onSwipeLeft, onSwipeRight]);
}
