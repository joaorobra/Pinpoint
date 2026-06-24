// Whole-UI zoom helper.
//
// The app scales its entire UI with the CSS `zoom` property on `document.body` (see the theming
// effect in App.tsx — `document.body.style.zoom = ui_zoom`). `zoom` keeps layout, scrollbars and
// hit-testing correct, but it introduces a coordinate-space mismatch that bites any code mixing
// `getBoundingClientRect()` / `MouseEvent.clientX` (reported in the OUTER, zoomed pixel space) with
// values written to an element's inline `left`/`top` (interpreted in the element's own LOCAL,
// unzoomed pixel space). At zoom ≠ 1 the two differ by exactly the zoom factor, so a handle pinned
// from a measured rect drifts and a menu placed at the pointer lands off-target.
//
// `uiZoom()` returns the current effective factor so callers can divide measured/event pixels back
// into local space before assigning them. At 100% it's 1 and every conversion is a no-op, so this is
// safe to apply unconditionally.

/**
 * The effective whole-UI zoom factor currently applied to `document.body` (1 when unset/100%).
 * Reads the live computed value so it always reflects the latest Ctrl +/-/0 or Settings change.
 */
export function uiZoom(): number {
  if (typeof document === "undefined") return 1;
  // `zoom` computes to a number string (e.g. "1.1") or "normal" when unset. Parse defensively.
  const raw = getComputedStyle(document.body).zoom;
  const z = parseFloat(raw);
  return Number.isFinite(z) && z > 0 ? z : 1;
}
