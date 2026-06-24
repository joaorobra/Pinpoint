import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, CaretRight } from "@phosphor-icons/react";
import { uiZoom } from "../lib/zoom";

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
  /** Extra class on the row (e.g. `prio-high` to tint the leading icon to the priority color). */
  className?: string;
  /**
   * When set, this row opens a nested flyout panel of these entries on hover (or → / Enter). The
   * parent menu stays open; the row shows a trailing caret. With a submenu, `onClick` is ignored.
   */
  submenu?: MenuEntry[];
  onClick?: () => void;
}

/**
 * A non-interactive uppercase section header that groups the rows beneath it (e.g. "TASKS"). Use a
 * plain `MenuItem` for a normal row; use this shape to emit a label divider.
 */
export interface MenuSection {
  section: string;
}

/** One renderable entry: an actionable/submenu row, or a section label. */
export type MenuEntry = MenuItem | MenuSection;

/**
 * A compact icon button in the top formatting row (B / I / S / code / link). Toggles or runs in
 * place; selecting one closes the menu like any command.
 */
export interface MenuFormatButton {
  /** Accessible label / tooltip. */
  label: string;
  /** Icon node (Phosphor element). */
  icon: React.ReactNode;
  /** Shown in the accent "on" state (e.g. bold while bold is active). */
  active?: boolean;
  shortcut?: string;
  onClick: () => void;
}

function isSection(e: MenuEntry): e is MenuSection {
  return (e as MenuSection).section !== undefined;
}

interface Props {
  x: number;
  y: number;
  items: MenuEntry[];
  /** Optional formatting-button row pinned to the top of the menu. */
  formatRow?: MenuFormatButton[];
  onClose: () => void;
}

/**
 * A small floating context menu, positioned at (x, y) and clamped to the viewport. Supports an
 * optional top formatting-button row, section labels, and nested submenus that open as flyouts on
 * hover (or → / Enter) — the parent stays open. Closes on outside click, Escape, scroll, or window
 * blur. Rendered inline (no portal); the backdrop covers the screen.
 */
export default function ContextMenu({ x, y, items, formatRow, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp into the viewport once we know the menu's size, then convert into the menu's own local
  // pixel space. The menu is `position: fixed` but lives inside the zoom-scaled `document.body`, so
  // its inline `left`/`top` are interpreted in LOCAL (unzoomed) pixels while the incoming pointer
  // `x`/`y` and the measured size are in OUTER (zoomed) pixels. Clamp in outer space — where the
  // pointer and the real viewport agree — then divide by the zoom factor so the menu renders exactly
  // under the cursor at any zoom (a no-op at 100%).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const z = uiZoom();
    const { width, height } = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - width - 8);
    const top = Math.min(y, window.innerHeight - height - 8);
    setPos({ left: Math.max(8, left) / z, top: Math.max(8, top) / z });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
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
        {/* Top formatting-button row. */}
        {formatRow && (
          <>
            <div className="ctx-format-row" role="group" aria-label="Formatting">
              {formatRow.map((b, i) => (
                <button
                  key={i}
                  className={`ctx-format-btn${b.active ? " on" : ""}`}
                  title={b.shortcut ? `${b.label} (${b.shortcut})` : b.label}
                  aria-label={b.label}
                  aria-pressed={b.active}
                  onClick={() => { onClose(); b.onClick(); }}
                >
                  {b.icon}
                </button>
              ))}
            </div>
            {items.length > 0 && <div className="ctx-sep" />}
          </>
        )}

        <MenuList items={items} onClose={onClose} />
      </div>
    </div>
  );
}

/**
 * Renders one panel of entries. A submenu row owns its flyout, which opens on hover (with a short
 * close delay so the pointer can travel diagonally onto it) and on → / Enter. Recurses for nesting.
 */
function MenuList({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  // Index of the row whose flyout is open (-1 = none). Keyboard highlight shares this so arrow nav
  // and hover feel identical.
  const [openSub, setOpenSub] = useState(-1);
  const [active, setActive] = useState(-1);
  // Pending "close the flyout" timer, cancelled if the pointer re-enters the row or its flyout.
  const closeTimer = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectable = items
    .map((it, i) => (isSection(it) || it.disabled ? -1 : i))
    .filter((i) => i >= 0);

  const cancelClose = () => {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpenSub(-1), 220);
  };

  const run = (it: MenuItem) => {
    if (it.submenu) return; // submenu rows don't "fire" — they reveal their flyout
    onClose();
    it.onClick?.();
  };

  // Arrow-key navigation within this panel. Right/Enter on a submenu row opens its flyout; the
  // flyout then captures focus via its own MenuList (the parent ignores keys while a sub is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (openSub >= 0) {
        if (e.key === "ArrowLeft") { e.preventDefault(); setOpenSub(-1); }
        return; // the open flyout's MenuList handles the rest
      }
      if (!selectable.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        setActive((cur) => {
          const at = selectable.indexOf(cur);
          const next = at < 0 ? (dir === 1 ? 0 : selectable.length - 1) : (at + dir + selectable.length) % selectable.length;
          return selectable[next];
        });
      } else if ((e.key === "ArrowRight" || e.key === "Enter") && active >= 0) {
        const it = items[active];
        if (!it || isSection(it)) return;
        e.preventDefault();
        if (it.submenu) setOpenSub(active);
        else run(it);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSub, active, items, selectable]);

  useEffect(() => () => cancelClose(), []);

  return (
    <div className="ctx-list" ref={listRef}>
      {items.map((it, i) => {
        if (isSection(it)) {
          return <div key={i} className="ctx-section-label">{it.section}</div>;
        }
        const hasSub = !!it.submenu;
        const isOpen = openSub === i;
        return (
          <div
            key={i}
            className="ctx-row"
            onMouseEnter={() => {
              cancelClose();
              if (!it.disabled) setActive(i);
              if (hasSub) setOpenSub(i);
              else if (openSub >= 0) scheduleClose();
            }}
            onMouseLeave={() => { if (hasSub) scheduleClose(); }}
          >
            {it.separator && <div className="ctx-sep" />}
            <button
              className={`ctx-item${it.danger ? " danger" : ""}${it.active ? " on" : ""}${i === active ? " hl" : ""}${isOpen ? " sub-open" : ""}${it.className ? ` ${it.className}` : ""}`}
              disabled={it.disabled}
              aria-haspopup={hasSub || undefined}
              aria-expanded={hasSub ? isOpen : undefined}
              onClick={() => run(it)}
            >
              {it.icon && <span className="ctx-icon">{it.icon}</span>}
              <span className="ctx-label">{it.label}</span>
              {it.shortcut && <span className="ctx-shortcut">{it.shortcut}</span>}
              {it.active && <Check size={14} weight="bold" className="ctx-check" />}
              {hasSub && <CaretRight size={13} className="ctx-submenu-caret" />}
            </button>

            {hasSub && isOpen && (
              <Flyout onClose={onClose} onCancelClose={cancelClose} onScheduleClose={scheduleClose}>
                {it.submenu as MenuEntry[]}
              </Flyout>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A submenu's flyout panel. Opens to the parent row's right, flipping to the left when it would
 * overflow the viewport, and nudging up when it would clip the bottom. Shares the parent's hover
 * timers so the pointer can travel onto it without it closing.
 */
function Flyout({
  children,
  onClose,
  onCancelClose,
  onScheduleClose,
}: {
  children: MenuEntry[];
  onClose: () => void;
  onCancelClose: () => void;
  onScheduleClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [adjust, setAdjust] = useState<{ flip: boolean; up: number }>({ flip: false, up: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // `r` is in outer (zoomed) pixels; the `up` nudge is written to the flyout's inline `top`, which
    // is in local (unzoomed) pixels — so divide the overflow back by the zoom factor (no-op at 100%).
    const z = uiZoom();
    const r = el.getBoundingClientRect();
    const flip = r.right > window.innerWidth - 8;
    const overflowBottom = r.bottom - (window.innerHeight - 8);
    setAdjust({ flip, up: overflowBottom > 0 ? overflowBottom / z : 0 });
  }, []);

  return (
    <div
      ref={ref}
      className={`ctx-flyout${adjust.flip ? " flip" : ""}`}
      style={adjust.up ? { top: `calc(-5px - ${adjust.up}px)` } : undefined}
      onMouseEnter={onCancelClose}
      onMouseLeave={onScheduleClose}
    >
      <MenuList items={children} onClose={onClose} />
    </div>
  );
}
