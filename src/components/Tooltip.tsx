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
//
// The bubble is mounted only while open, in a portal at document.body with fixed positioning, so it
// is never clipped by (or widens the scroll area of) an `overflow: hidden` panel like the sidebars,
// and it is clamped to stay inside the viewport near the window edges.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { uiZoom } from "../lib/zoom";

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
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const timer = useRef<number | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);

  // Place the bubble beside the trigger once it has rendered (so its size is known), in LOCAL
  // (unzoomed) px since the portal sits inside the zoomed body.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const wrap = wrapRef.current;
    const bubble = bubbleRef.current;
    if (!wrap || !bubble) return;
    const z = uiZoom();
    const t = wrap.getBoundingClientRect();
    const r = { left: t.left / z, top: t.top / z, right: t.right / z, bottom: t.bottom / z };
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const gap = 6;
    const margin = 6;
    let left: number;
    let top: number;
    if (side === "left" || side === "right") {
      left = side === "left" ? r.left - gap - w : r.right + gap;
      top = (r.top + r.bottom) / 2 - h / 2;
    } else {
      left = (r.left + r.right) / 2 - w / 2;
      top = side === "top" ? r.top - gap - h : r.bottom + gap;
    }
    const vw = window.innerWidth / z;
    const vh = window.innerHeight / z;
    left = Math.min(Math.max(margin, left), vw - w - margin);
    top = Math.min(Math.max(margin, top), vh - h - margin);
    setPos({ left, top });
  }, [open, side, label]);

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
      ref={wrapRef}
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
      {open &&
        createPortal(
          <span
            ref={bubbleRef}
            className="tooltip-bubble"
            role="tooltip"
            aria-hidden="true"
            data-side={side}
            data-open={pos ? "" : undefined}
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0 }}
          >
            {label}
          </span>,
          document.body
        )}
    </span>
  );
}
