// Shared building blocks for the database views (table, board, calendar, gallery):
//   - the typed cell editors (text, number, currency, checkbox, select, multi-select, dates),
//   - the option chip + read-only value renderer used on cards/lanes,
//   - the mini calendar, the dismiss-on-outside-click hook, and the column-type metadata.
//
// Every view imports from here so cell editing behaves identically no matter the layout.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  TextT,
  Hash,
  CurrencyDollar,
  CheckSquare,
  CalendarBlank,
  Clock,
  CalendarDots,
  ListChecks,
  Tag,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { DbColumn, DbColumnType, DbDateRange, DbOption } from "../types";
import { formatDate, parseISODate } from "../dateformat";
import type { DbRow } from "../dblogic";
import { cellValue } from "../dblogic";

export const TYPE_META: { type: DbColumnType; label: string; icon: PhosphorIcon }[] = [
  { type: "text", label: "Text", icon: TextT },
  { type: "number", label: "Number", icon: Hash },
  { type: "currency", label: "Currency", icon: CurrencyDollar },
  { type: "checkbox", label: "Checkbox", icon: CheckSquare },
  { type: "select", label: "Select", icon: Tag },
  { type: "multiselect", label: "Multi-select", icon: ListChecks },
  { type: "date", label: "Date", icon: CalendarBlank },
  { type: "datetime", label: "Date & time", icon: Clock },
  { type: "daterange", label: "Date range", icon: CalendarDots },
];

export function typeIcon(type: DbColumnType): PhosphorIcon {
  return TYPE_META.find((t) => t.type === type)?.icon ?? TextT;
}

/** A short unique-ish id for columns/options/views/filters. */
export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Slugify a title into a safe file leaf. */
export function safeLeaf(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
  return cleaned || "Untitled";
}

/**
 * Keep an absolutely-positioned popover inside the viewport. Attach the returned ref to the
 * popover element (the one with `top:100%; left:0`). On open it measures the popover against the
 * window and flips it above the trigger when it would overflow the bottom, and right-aligns it
 * when it would overflow the right edge — via `data-flip-y` / `data-flip-x` the CSS keys off.
 * Re-measures on scroll/resize so it stays correct inside a scrolling table.
 */
export function usePopoverPlacement<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const place = () => {
      // Reset so we measure the natural (down/left) position first.
      el.removeAttribute("data-flip-y");
      el.removeAttribute("data-flip-x");
      const trigger = el.parentElement?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const margin = 8;
      // Flip up if the popover's bottom would spill past the viewport and there's more room above.
      if (trigger && r.bottom > window.innerHeight - margin && trigger.top > window.innerHeight - trigger.bottom) {
        el.setAttribute("data-flip-y", "");
      }
      // Right-align if the left-aligned popover would spill past the right edge.
      if (r.right > window.innerWidth - margin) el.setAttribute("data-flip-x", "");
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  return ref;
}

/**
 * Dismiss-on-outside-click / Escape, attached on the next tick to dodge the opening click.
 * `ignoreSelector` lets a caller exempt a control row (e.g. the toolbar buttons) so clicking a
 * sibling button switches popovers via its own handler instead of just closing this one.
 */
export function useDismiss(open: boolean, close: () => void, ignoreSelector?: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t)) return;
      if (ignoreSelector && t.closest(ignoreSelector)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const id = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close, ignoreSelector]);
  return ref;
}

export function chipBg(color: string): string {
  return `color-mix(in srgb, ${color || "#7c5cff"} 22%, transparent)`;
}
export function chipFg(color: string): string {
  return `color-mix(in srgb, ${color || "#7c5cff"} 78%, var(--text))`;
}

export function Chip({ opt, onRemove }: { opt: DbOption; onRemove?: () => void }) {
  return (
    <span className="db-chip" style={{ background: chipBg(opt.color), color: chipFg(opt.color) }}>
      {opt.label}
      {onRemove && (
        <button className="db-chip-x" onClick={(e) => { e.stopPropagation(); onRemove(); }}>✕</button>
      )}
    </span>
  );
}

/** Format currency, falling back to "CODE 123" if Intl rejects the code. */
export function formatCurrency(num: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(num);
  } catch {
    return `${currency} ${num}`;
  }
}

/* =============================================================================================
   Read-only renderer — used on cards, kanban tiles, calendar events.
   ============================================================================================= */
export function CellValueView({ col, row, dateFormat }: { col: DbColumn; row: DbRow; dateFormat: string }) {
  const v = cellValue(row, col);
  if (v == null || v === "") return <span className="db-empty">—</span>;
  switch (col.type) {
    case "checkbox":
      return <span>{v === true ? "☑" : "☐"}</span>;
    case "currency":
      return <span>{typeof v === "number" ? formatCurrency(v, col.currency ?? "USD") : String(v)}</span>;
    case "select": {
      const o = (col.options ?? []).find((x) => x.id === v);
      return o ? <Chip opt={o} /> : <span className="db-empty">—</span>;
    }
    case "multiselect": {
      const arr = Array.isArray(v) ? (v as string[]) : [];
      const opts = arr.map((id) => (col.options ?? []).find((o) => o.id === id)).filter(Boolean) as DbOption[];
      return <span className="db-chip-row">{opts.map((o) => <Chip key={o.id} opt={o} />)}</span>;
    }
    case "date":
      return <span>{formatDate(parseISODate(String(v)), dateFormat)}</span>;
    case "datetime":
      return <span>{String(v)}</span>;
    case "daterange": {
      const r = v as DbDateRange;
      return (
        <span>
          {r.start ? formatDate(parseISODate(r.start), dateFormat) : "…"} →{" "}
          {r.end ? formatDate(parseISODate(r.end), dateFormat) : "…"}
        </span>
      );
    }
    default:
      return <span>{String(v)}</span>;
  }
}

/* =============================================================================================
   Editable cell — dispatches to a typed editor. Used by the table view and the card detail.
   ============================================================================================= */
export function DbCell({
  col,
  row,
  dateFormat,
  onChange,
  onRenameTitle,
}: {
  col: DbColumn;
  row: DbRow;
  dateFormat: string;
  onChange: (value: unknown) => void;
  onRenameTitle: (value: string) => void;
}) {
  const value = cellValue(row, col);
  switch (col.type) {
    case "title":
      return <TitleCellInput title={row.title} onRename={onRenameTitle} />;
    case "text":
      return <TextCell value={typeof value === "string" ? value : value == null ? "" : String(value)} onChange={onChange} />;
    case "number":
      return <NumberCell value={value} onChange={onChange} />;
    case "currency":
      return <CurrencyCell value={value} currency={col.currency ?? "USD"} onChange={onChange} />;
    case "checkbox":
      return <CheckboxCell value={value === true} onChange={onChange} />;
    case "select":
      return <SelectCell options={col.options ?? []} value={typeof value === "string" ? value : ""} onChange={onChange} />;
    case "multiselect":
      return <MultiSelectCell options={col.options ?? []} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />;
    case "date":
      return <DateCell value={typeof value === "string" ? value : ""} dateFormat={dateFormat} onChange={onChange} />;
    case "datetime":
      return <DateTimeCell value={typeof value === "string" ? value : ""} onChange={onChange} />;
    case "daterange":
      return <DateRangeCell value={value as DbDateRange | undefined} dateFormat={dateFormat} onChange={onChange} />;
    default:
      return null;
  }
}

/* ---- Title (plain input, no row actions — the table wraps it with actions itself) ---------- */
function TitleCellInput({ title, onRename }: { title: string; onRename: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        className="db-text-input"
        defaultValue={title}
        autoFocus
        onBlur={(e) => { onRename(e.target.value); setEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { onRename((e.target as HTMLInputElement).value); setEditing(false); }
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return <span className="db-title-text" onClick={() => setEditing(true)}>{title || <span className="db-empty">Untitled</span>}</span>;
}

function TextCell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="db-text-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onChange(draft)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function NumberCell({ value, onChange }: { value: unknown; onChange: (v: number | "") => void }) {
  const initial = typeof value === "number" ? String(value) : value == null ? "" : String(value);
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  const commit = () => {
    if (draft.trim() === "") return onChange("");
    const n = Number(draft);
    if (!Number.isNaN(n)) onChange(n);
  };
  return (
    <input
      className="db-text-input db-num"
      inputMode="decimal"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function CurrencyCell({ value, currency, onChange }: { value: unknown; currency: string; onChange: (v: number | "") => void }) {
  const [editing, setEditing] = useState(false);
  const num = typeof value === "number" ? value : value == null || value === "" ? null : Number(value);
  const [draft, setDraft] = useState(num == null || Number.isNaN(num) ? "" : String(num));
  useEffect(() => setDraft(num == null || Number.isNaN(num) ? "" : String(num)), [num]);
  const formatted = useMemo(() => (num == null || Number.isNaN(num) ? "" : formatCurrency(num, currency)), [num, currency]);
  const commit = () => {
    setEditing(false);
    if (draft.trim() === "") return onChange("");
    const n = Number(draft);
    if (!Number.isNaN(n)) onChange(n);
  };
  if (editing) {
    return (
      <input
        className="db-text-input db-num"
        inputMode="decimal"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    );
  }
  return (
    <div className="db-currency-display" onClick={() => setEditing(true)}>
      {formatted || <span className="db-empty">—</span>}
    </div>
  );
}

function CheckboxCell({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="db-check" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="db-check-box" />
    </label>
  );
}

function SelectCell({ options, value, onChange }: { options: DbOption[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const place = usePopoverPlacement<HTMLDivElement>(open);
  const current = options.find((o) => o.id === value);
  return (
    <div className="db-select-cell" ref={ref}>
      <button className="db-select-trigger" onClick={() => setOpen((o) => !o)}>
        {current ? <Chip opt={current} /> : <span className="db-empty">—</span>}
      </button>
      {open && (
        <div className="db-select-menu" ref={place}>
          {value && <button className="db-select-opt db-clear" onClick={() => { onChange(""); setOpen(false); }}>Clear</button>}
          {options.map((o) => (
            <button key={o.id} className="db-select-opt" onClick={() => { onChange(o.id); setOpen(false); }}>
              <Chip opt={o} />
            </button>
          ))}
          {options.length === 0 && <div className="db-select-empty">No options — add some in the column header.</div>}
        </div>
      )}
    </div>
  );
}

function MultiSelectCell({ options, value, onChange }: { options: DbOption[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const place = usePopoverPlacement<HTMLDivElement>(open);
  const selected = value.map((id) => options.find((o) => o.id === id)).filter(Boolean) as DbOption[];
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div className="db-select-cell" ref={ref}>
      <button className="db-select-trigger db-multi" onClick={() => setOpen((o) => !o)}>
        {selected.length ? selected.map((o) => <Chip key={o.id} opt={o} onRemove={() => toggle(o.id)} />) : <span className="db-empty">—</span>}
      </button>
      {open && (
        <div className="db-select-menu" ref={place}>
          {options.map((o) => (
            <button key={o.id} className={`db-select-opt${value.includes(o.id) ? " checked" : ""}`} onClick={() => toggle(o.id)}>
              <Chip opt={o} />
              {value.includes(o.id) && <CheckSquare size={13} weight="fill" className="db-multi-check" />}
            </button>
          ))}
          {options.length === 0 && <div className="db-select-empty">No options — add some in the column header.</div>}
        </div>
      )}
    </div>
  );
}

export function MiniCalendar({ value, onPick, marks }: { value: string; onPick: (iso: string) => void; marks?: Set<string> }) {
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const initial = value ? parseISODate(value) : today;
  const [view, setView] = useState(new Date(initial.getFullYear(), initial.getMonth(), 1));
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const WEEKDAYS = ["Mo","Tu","We","Th","Fr","Sa","Su"];
  const cells = useMemo<(Date | null)[]>(() => {
    const y = view.getFullYear(), m = view.getMonth();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= days; d++) out.push(new Date(y, m, d));
    while (out.length % 7) out.push(null);
    return out;
  }, [view]);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const sel = value ? parseISODate(value) : null;
  return (
    <div className="db-cal">
      <div className="db-cal-head">
        <button onClick={() => setView((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}>‹</button>
        <span>{MONTHS[view.getMonth()]} {view.getFullYear()}</span>
        <button onClick={() => setView((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}>›</button>
      </div>
      <div className="db-cal-grid">
        {WEEKDAYS.map((w) => <div key={w} className="db-cal-wd">{w}</div>)}
        {cells.map((d, i) => d === null ? <div key={`b${i}`} /> : (
          <button
            key={d.getTime()}
            className={`db-cal-day${same(d, today) ? " today" : ""}${sel && same(d, sel) ? " sel" : ""}${marks?.has(iso(d)) ? " marked" : ""}`}
            onClick={() => onPick(iso(d))}
          >
            {d.getDate()}
          </button>
        ))}
      </div>
    </div>
  );
}

function DateCell({ value, dateFormat, onChange }: { value: string; dateFormat: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const place = usePopoverPlacement<HTMLDivElement>(open);
  const label = value ? formatDate(parseISODate(value), dateFormat) : "";
  return (
    <div className="db-date-cell" ref={ref}>
      <button className="db-date-trigger" onClick={() => setOpen((o) => !o)}>
        {label || <span className="db-empty">—</span>}
      </button>
      {open && (
        <div className="db-date-pop" ref={place}>
          <MiniCalendar value={value} onPick={(iso) => { onChange(iso); setOpen(false); }} />
          {value && <button className="db-date-clear" onClick={() => { onChange(""); setOpen(false); }}>Clear</button>}
        </div>
      )}
    </div>
  );
}

function DateTimeCell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [datePart, timePart] = value ? value.split(" ") : ["", ""];
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const place = usePopoverPlacement<HTMLDivElement>(open);
  const setDate = (iso: string) => onChange(`${iso}${timePart ? " " + timePart : " 09:00"}`);
  const setTime = (t: string) => { if (datePart) onChange(`${datePart} ${t}`); };
  return (
    <div className="db-date-cell" ref={ref}>
      <button className="db-date-trigger" onClick={() => setOpen((o) => !o)}>
        {value || <span className="db-empty">—</span>}
      </button>
      {open && (
        <div className="db-date-pop" ref={place}>
          <MiniCalendar value={datePart} onPick={setDate} />
          <div className="db-time-row">
            <Clock size={13} />
            <input type="time" value={timePart || ""} onChange={(e) => setTime(e.target.value)} />
            {value && <button className="db-date-clear" onClick={() => { onChange(""); setOpen(false); }}>Clear</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function DateRangeCell({ value, dateFormat, onChange }: { value: DbDateRange | undefined; dateFormat: string; onChange: (v: DbDateRange | "") => void }) {
  const start = value?.start ?? "";
  const end = value?.end ?? "";
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<"start" | "end">("start");
  const ref = useDismiss(open, () => setOpen(false));
  const place = usePopoverPlacement<HTMLDivElement>(open);
  const commit = (s: string, e: string) => { if (!s && !e) onChange(""); else onChange({ start: s, end: e }); };
  const label = start || end
    ? `${start ? formatDate(parseISODate(start), dateFormat) : "…"} → ${end ? formatDate(parseISODate(end), dateFormat) : "…"}`
    : "";
  return (
    <div className="db-date-cell" ref={ref}>
      <button className="db-date-trigger" onClick={() => setOpen((o) => !o)}>
        {label || <span className="db-empty">—</span>}
      </button>
      {open && (
        <div className="db-date-pop" ref={place}>
          <div className="db-range-tabs">
            <button className={picking === "start" ? "active" : ""} onClick={() => setPicking("start")}>
              Start{start ? `: ${formatDate(parseISODate(start), dateFormat)}` : ""}
            </button>
            <button className={picking === "end" ? "active" : ""} onClick={() => setPicking("end")}>
              End{end ? `: ${formatDate(parseISODate(end), dateFormat)}` : ""}
            </button>
          </div>
          <MiniCalendar
            value={picking === "start" ? start : end}
            onPick={(iso) => { if (picking === "start") { commit(iso, end); setPicking("end"); } else commit(start, iso); }}
          />
          {(start || end) && <button className="db-date-clear" onClick={() => { commit("", ""); setOpen(false); }}>Clear</button>}
        </div>
      )}
    </div>
  );
}
