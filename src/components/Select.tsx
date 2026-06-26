// Custom dropdown that replaces the native <select> everywhere in the app, so menus match the
// app's theming (rounded popover, accent highlight, blur) instead of the OS chrome.
//
// Supports both flat option lists and grouped options (optgroup-equivalent). Keyboard: ArrowUp/Down
// to move, Enter/Space to commit, Escape to close, type-ahead by first letter. Closes on outside
// click or blur. The popover is rendered in a portal at document.body and positioned via the
// trigger's viewport rect, so it is NEVER clipped by an ancestor with `overflow: hidden|auto`
// (e.g. the scrollable query-helper popup) — a plain absolutely-positioned menu would be cropped.

import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import { uiZoom } from "../lib/zoom";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional leading icon (a Phosphor element) shown before the label in the menu and trigger. */
  icon?: ReactNode;
  /** Optional one-line subtitle under the label in the menu (not shown on the trigger). */
  desc?: string;
}

export interface SelectGroup {
  label: string;
  options: SelectOption[];
}

interface Props {
  value: string;
  /** Provide either a flat list via `options` or grouped via `groups`. */
  options?: SelectOption[];
  groups?: SelectGroup[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** Extra class on the trigger button (e.g. for width tweaks in dense rows). */
  className?: string;
  ariaLabel?: string;
}

const flatten = (options?: SelectOption[], groups?: SelectGroup[]): SelectOption[] =>
  options ?? (groups ? groups.flatMap((g) => g.options) : []);

export default function Select({
  value,
  options,
  groups,
  onChange,
  placeholder = "Select…",
  className = "",
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0); // highlighted index into the flat list
  // Portal menu placement, in LOCAL (unzoomed) px — the portal sits in the zoomed body, so measured
  // rect values are divided by uiZoom() before being written here. `up` flips it above the trigger;
  // `maxH` is the room actually available on that side so the menu is never taller than it can show.
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    width: number;
    up: boolean;
    maxH: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const flat = useMemo(() => flatten(options, groups), [options, groups]);
  const selected = flat.find((o) => o.value === value);

  // Close on any click outside the component. The menu is portaled out of `rootRef`, so also treat
  // clicks inside the menu (tagged via the listbox id) as "inside" and keep the menu open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Measure the trigger and place the portaled menu. Runs on open and re-runs on scroll/resize so the
  // menu tracks the trigger (the menu lives at document.body, decoupled from the trigger's flow).
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const i = flat.findIndex((o) => o.value === value);
    setActive(i < 0 ? 0 : i);

    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const z = uiZoom(); // rect is in OUTER (zoomed) px; portal coords are LOCAL px → divide by z
      const GAP = 4; // px between trigger and menu
      const MARGIN = 8; // keep the menu off the very viewport edge
      // Room (in OUTER px) on each side of the trigger, then flip to whichever has more — but only
      // flip up when down is genuinely cramped, to avoid jitter when the two are close.
      const below = window.innerHeight - rect.bottom - GAP - MARGIN;
      const above = rect.top - GAP - MARGIN;
      const up = below < 240 && above > below;
      // The menu can grow to the room on the chosen side (capped at the design max), so it never
      // overflows the viewport and never renders clipped/short against a popover edge.
      const maxH = Math.min(240, Math.max(96, (up ? above : below) / z));
      setPos({
        left: rect.left / z,
        top: (up ? rect.top - GAP : rect.bottom + GAP) / z,
        width: rect.width / z,
        up,
        maxH,
      });
    };
    place();
    window.addEventListener("scroll", place, true); // capture: catch any scrolling ancestor
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, flat, value]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const commit = (i: number) => {
    const opt = flat[i];
    if (opt) onChange(opt.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(flat.length - 1);
    } else if (e.key.length === 1) {
      // Type-ahead: jump to the next option starting with the typed character.
      const ch = e.key.toLowerCase();
      const start = active + 1;
      const idx = flat.findIndex((o, j) => j >= start && o.label.toLowerCase().startsWith(ch));
      const wrap = flat.findIndex((o) => o.label.toLowerCase().startsWith(ch));
      const next = idx >= 0 ? idx : wrap;
      if (next >= 0) setActive(next);
    }
  };

  // Render rows; track a running flat index across groups so keyboard nav and rendering agree.
  let cursor = -1;
  const renderRow = (opt: SelectOption) => {
    cursor += 1;
    const idx = cursor;
    const isSel = opt.value === value;
    return (
      <div
        key={opt.value}
        data-idx={idx}
        role="option"
        aria-selected={isSel}
        className={`select-option${idx === active ? " active" : ""}${isSel ? " selected" : ""}`}
        onMouseEnter={() => setActive(idx)}
        onMouseDown={(e) => {
          // preventDefault keeps editor/input focus; stopPropagation keeps the click from
          // bubbling to a parent popup's outside-click dismiss handler (e.g. the query helper),
          // which would otherwise close the whole popup the moment an option is picked.
          e.preventDefault();
          e.stopPropagation();
          commit(idx);
        }}
      >
        {opt.icon && <span className="select-option-icon">{opt.icon}</span>}
        {opt.desc ? (
          <span className="select-option-text">
            <span className="select-option-label">{opt.label}</span>
            <span className="select-option-desc">{opt.desc}</span>
          </span>
        ) : (
          <span className="select-option-label">{opt.label}</span>
        )}
        {isSel && <Check size={14} weight="bold" className="select-check" />}
      </div>
    );
  };

  return (
    <div className={`select${open ? " open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className={`select-trigger ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        {selected?.icon && <span className="select-value-icon">{selected.icon}</span>}
        <span className={`select-value${selected ? "" : " placeholder"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <CaretDown size={13} weight="bold" className="select-caret" />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            className={`select-menu portal${pos.up ? " up" : ""}`}
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              minWidth: pos.width,
              maxHeight: pos.maxH,
              transform: pos.up ? "translateY(-100%)" : undefined,
            }}
          >
            {groups
              ? groups.map((g) => (
                  <div key={g.label} className="select-group">
                    <div className="select-group-label">{g.label}</div>
                    {g.options.map(renderRow)}
                  </div>
                ))
              : (options ?? []).map(renderRow)}
          </div>,
          document.body
        )}
    </div>
  );
}
