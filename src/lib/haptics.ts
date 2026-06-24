// Lightweight haptic feedback for touch devices.
//
// Built on the Web Vibration API (`navigator.vibrate`), which is honoured by Android WebViews —
// the surface Pinpoint's mobile build runs in. iOS Safari/WKWebView ignores it silently, and
// desktop has no vibrator, so every call is a safe no-op there: we never throw and never block.
//
// The patterns are deliberately *short* and *quiet*. Mobile haptics turn obnoxious fast; these are
// the gentlest taps that still register as intentional feedback (a few ms), reserved for moments
// that genuinely confirm an action. Semantic names (not raw durations) keep call sites honest about
// *why* they buzz, so the vocabulary stays small and consistent across the app.

/** Patterns in ms. A single number is one pulse; an array alternates vibrate/pause/vibrate. */
const PATTERNS = {
  /** A light tick — pressing a button, toggling a drawer. The default "something happened". */
  tap: 8,
  /** Picking an item from a list (folder, menu option). A touch crisper than `tap`. */
  select: 12,
  /** A committed, positive outcome (task captured, note created). Two quick beats. */
  success: [10, 40, 18] as number[],
  /** A firm, deliberate press — the primary FAB. Slightly weightier than `tap`. */
  impact: 16,
} as const;

export type HapticKind = keyof typeof PATTERNS;

// Feature-detect once. `vibrate` is missing on desktop and iOS WebViews; guard so call sites stay
// clean. We don't cache a "supported" boolean for touch-ness — the device either has the API or not.
const canVibrate =
  typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

/**
 * Fire a haptic pulse by intent. No-ops where the platform can't vibrate, so it's always safe to
 * call inline from a tap handler without guarding the call site.
 *
 *   haptic("tap")      // light tick on a toggle
 *   haptic("success")  // confirm a capture
 */
export function haptic(kind: HapticKind = "tap"): void {
  if (!canVibrate) return;
  try {
    navigator.vibrate(PATTERNS[kind]);
  } catch {
    // Some webviews throw if vibration is disabled by the user/OS — never let that surface.
  }
}
