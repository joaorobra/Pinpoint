// Custom dropdown that replaces the native <select> everywhere in the app, so menus match the
// app's theming (rounded popover, accent highlight, blur) instead of the OS chrome.
//
// Supports both flat option lists and grouped options (optgroup-equivalent). Keyboard: ArrowUp/Down
// to move, Enter/Space to commit, Escape to close, type-ahead by first letter. Closes on outside
// click or blur. Renders the popover inline (absolutely positioned) under the trigger.

import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional leading icon (a Phosphor element) shown before the label in the menu and trigger. */
  icon?: ReactNode;
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
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const flat = useMemo(() => flatten(options, groups), [options, groups]);
  const selected = flat.find((o) => o.value === value);

  // Close on any click outside the component.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // When opening, highlight the current value and decide whether to drop up (near viewport bottom).
  useLayoutEffect(() => {
    if (!open) return;
    const i = flat.findIndex((o) => o.value === value);
    setActive(i < 0 ? 0 : i);
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) setDropUp(window.innerHeight - rect.bottom < 260 && rect.top > 260);
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
          e.preventDefault();
          commit(idx);
        }}
      >
        {opt.icon && <span className="select-option-icon">{opt.icon}</span>}
        <span className="select-option-label">{opt.label}</span>
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

      {open && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          className={`select-menu${dropUp ? " up" : ""}`}
        >
          {groups
            ? groups.map((g) => (
                <div key={g.label} className="select-group">
                  <div className="select-group-label">{g.label}</div>
                  {g.options.map(renderRow)}
                </div>
              ))
            : (options ?? []).map(renderRow)}
        </div>
      )}
    </div>
  );
}
