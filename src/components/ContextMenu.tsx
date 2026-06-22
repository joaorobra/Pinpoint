import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  /** A leading icon — a Phosphor icon element (or any node). */
  icon?: React.ReactNode;
  /** Visually mark as destructive (e.g. Delete). */
  danger?: boolean;
  /** A divider above this item. */
  separator?: boolean;
  onClick: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * A small floating context menu, positioned at (x, y) and clamped to the viewport. Closes on outside
 * click, Escape, scroll, or window blur. Rendered inline (no portal) — the backdrop covers the screen.
 */
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp into the viewport once we know the menu's size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - width - 8);
    const top = Math.min(y, window.innerHeight - height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div className="ctx-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        ref={ref}
        className="ctx-menu"
        style={{ left: pos.left, top: pos.top }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => (
          <div key={i}>
            {it.separator && <div className="ctx-sep" />}
            <button
              className={`ctx-item${it.danger ? " danger" : ""}`}
              onClick={() => {
                onClose();
                it.onClick();
              }}
            >
              {it.icon && <span className="ctx-icon">{it.icon}</span>}
              <span>{it.label}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
