// Custom styled tooltip — replaces the native `title` attribute with a design-system bubble.
//
// JS-controlled visibility (not pure CSS :hover/:focus-within) so the bubble reliably hides the
// moment you leave or click. A CSS-only tooltip stays pinned after a click because the button
// keeps :focus — this avoids that by hiding on pointerdown/leave/blur explicitly, and only shows
// on keyboard focus (not the focus a mouse click leaves behind).
//
//   <Tooltip label="Tasks" side="bottom">
//     <button aria-label="Tasks"><CheckCircle /></button>
//   </Tooltip>
//
// Keep an `aria-label` on the trigger — the bubble is `aria-hidden` (visual only), so screen
// readers get the name from the trigger without double-announcing.

import { useRef, useState, type ReactNode } from "react";

export type TooltipSide = "top" | "bottom" | "left" | "right";

const SHOW_DELAY_MS = 380;

export default function Tooltip({
  label,
  side = "bottom",
  children,
}: {
  label: string;
  side?: TooltipSide;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const clear = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const show = () => {
    clear();
    timer.current = window.setTimeout(() => setOpen(true), SHOW_DELAY_MS);
  };
  const hide = () => {
    clear();
    setOpen(false);
  };

  return (
    <span
      className="tooltip-wrap"
      data-side={side}
      onPointerEnter={(e) => {
        // Touch taps shouldn't pop a tooltip; only hover-capable pointers.
        if (e.pointerType === "mouse") show();
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocusCapture={(e) => {
        // Show on keyboard focus only — a mouse click leaves focus behind but we don't want the
        // tooltip lingering after the click. :focus-visible matches keyboard-driven focus.
        if (e.target.matches?.(":focus-visible")) show();
      }}
      onBlurCapture={hide}
    >
      {children}
      <span
        className="tooltip-bubble"
        role="tooltip"
        aria-hidden="true"
        data-open={open ? "" : undefined}
      >
        {label}
      </span>
    </span>
  );
}
