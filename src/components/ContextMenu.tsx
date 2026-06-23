import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "@phosphor-icons/react";

export interface MenuItem {
  label: string;
  /** A leading icon — a Phosphor icon element (or any node). */
  icon?: React.ReactNode;
  /** Visually mark as destructive (e.g. Delete). */
  danger?: boolean;
  /** A divider above this item. */
  separator?: boolean;
  /**
   * For toggle items (e.g. Bold / Italic): when true the row is shown in its "on" state — accent
   * tinted with a trailing check. Lets a single menu express both commands and toggles.
   */
  active?: boolean;
  /** Right-aligned hint, e.g. a keyboard shortcut ("Ctrl+B"). */
  shortcut?: string;
  /** Disable the row (dimmed, non-interactive) without removing it. */
  disabled?: boolean;
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
  // Keyboard-highlighted row (arrow-key navigation). -1 = nothing highlighted yet.
  const [active, setActive] = useState(-1);

  // Indices of the rows that can actually be focused/run (skip disabled).
  const selectable = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (!selectable.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        setActive((cur) => {
          const at = selectable.indexOf(cur);
          // From "nothing", Down lands on the first row and Up on the last.
          const next = at < 0 ? (dir === 1 ? 0 : selectable.length - 1) : (at + dir + selectable.length) % selectable.length;
          return selectable[next];
        });
      } else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        onClose();
        items[active]?.onClick();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, active, items, selectable]);

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
              className={`ctx-item${it.danger ? " danger" : ""}${it.active ? " on" : ""}${i === active ? " hl" : ""}`}
              disabled={it.disabled}
              onClick={() => {
                onClose();
                it.onClick();
              }}
              onMouseEnter={() => !it.disabled && setActive(i)}
            >
              {it.icon && <span className="ctx-icon">{it.icon}</span>}
              <span className="ctx-label">{it.label}</span>
              {it.shortcut && <span className="ctx-shortcut">{it.shortcut}</span>}
              {it.active && <Check size={14} weight="bold" className="ctx-check" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
