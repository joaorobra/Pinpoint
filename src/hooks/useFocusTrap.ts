import { useEffect, type RefObject } from "react";

/** Elements that can hold keyboard focus inside a modal. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Trap Tab focus within `ref` while `active`, and restore focus to whatever was focused before the
 * modal opened once it closes. Keeps keyboard users from tabbing out to the page behind a modal —
 * the missing half of our existing Escape-to-close / backdrop-dismiss dialog behaviour.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (nodes.length === 0) {
        // Nothing focusable but the modal itself — keep focus pinned inside.
        e.preventDefault();
        root.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (activeEl === first || !root.contains(activeEl))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Restore focus to the trigger so keyboard context isn't lost when the modal closes.
      previouslyFocused?.focus?.();
    };
  }, [ref, active]);
}
