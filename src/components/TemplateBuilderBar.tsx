// Template builder toolbar — the chip palette shown above the editor while editing a template file.
//
// A template is a plain `.md` page under the Templates folder whose body holds {{variables}} (see
// templates.ts). Typing `{{date:YYYY-MM-DD}}` by hand is error-prone, so this bar turns every token
// into a one-click chip: click to insert it at the caret. Built-in tokens resolve automatically at
// insert time; the "Variable" chip inserts a custom {{name}} that prompts the reader on use.
//
// It renders into the Editor's `headerSlot` (the same surface the DB-row properties panel uses), so
// it scrolls with the document and shares the page column width. The host owns the actual insertion
// via the Editor's `insertText` signal; this component only decides *what* to insert.

import { useState } from "react";
import {
  Stack, CalendarBlank, Clock, TextT, CaretDown, Plus, CalendarDots, Info,
  FolderSimple, CursorText, Hash, DotsThreeOutline,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { formatDate, DATE_PRESETS } from "../dateformat";
import { dialogs } from "./Dialogs";

interface Props {
  /** Insert a token string at the editor caret. */
  onInsert: (token: string) => void;
  /** User's configured date/time patterns, used for the live preview tooltips. */
  dateFormat: string;
  timeFormat: string;
  /** Show the periodic tokens ({{period}}…). Only meaningful for periodic templates. */
  showPeriodic?: boolean;
}

/** A single insertable token chip. `preview` is a function so date/time stay fresh per render. */
interface Chip {
  token: string;
  label: string;
  icon: PhosphorIcon;
  preview?: () => string;
}

export default function TemplateBuilderBar({ onInsert, dateFormat, timeFormat, showPeriodic }: Props) {
  // Which popover is open: the date-format picker, or the "More" overflow. Only one at a time.
  const [open, setOpen] = useState<null | "fmt" | "more">(null);

  const now = new Date();

  // Always-visible primary chips: the tokens reached for most often.
  const core: Chip[] = [
    { token: "{{title}}", label: "Title", icon: TextT, preview: () => "the page name" },
    { token: "{{date}}", label: "Date", icon: CalendarBlank, preview: () => formatDate(now, dateFormat) },
    { token: "{{time}}", label: "Time", icon: Clock, preview: () => formatDate(now, timeFormat) },
    { token: "{{parent}}", label: "Parent", icon: FolderSimple, preview: () => "parent folder name" },
    { token: "{{cursor}}", label: "Cursor", icon: CursorText, preview: () => "where the caret lands" },
  ];

  const periodic: Chip[] = [
    { token: "{{period}}", label: "Period", icon: CalendarDots, preview: () => "e.g. “Week 25, 2026”" },
    { token: "{{periodStart}}", label: "Start", icon: CalendarDots, preview: () => "period’s first day" },
    { token: "{{periodEnd}}", label: "End", icon: CalendarDots, preview: () => "period’s last day" },
  ];

  // Tucked behind "More" so the bar stays uncluttered — relative dates, path, identity tokens.
  const more: Chip[] = [
    { token: "{{tomorrow}}", label: "Tomorrow", icon: CalendarBlank, preview: () => formatDate(new Date(now.getTime() + 864e5), dateFormat) },
    { token: "{{yesterday}}", label: "Yesterday", icon: CalendarBlank, preview: () => formatDate(new Date(now.getTime() - 864e5), dateFormat) },
    { token: "{{date+1w:YYYY-MM-DD}}", label: "Date + 1 week", icon: CalendarDots, preview: () => formatDate(new Date(now.getTime() + 7 * 864e5), "YYYY-MM-DD") },
    { token: "{{weekday}}", label: "Weekday", icon: CalendarDots, preview: () => formatDate(now, "dddd") },
    { token: "{{week}}", label: "Week number", icon: Hash, preview: () => "ISO week (1–53)" },
    { token: "{{year}}", label: "Year", icon: CalendarDots, preview: () => formatDate(now, "YYYY") },
    { token: "{{parentPath}}", label: "Parent path", icon: FolderSimple, preview: () => "full folder path" },
    { token: "{{vault}}", label: "Vault name", icon: FolderSimple, preview: () => "the vault’s name" },
    { token: "{{uuid}}", label: "Unique id", icon: Hash, preview: () => "a fresh UUID" },
  ];

  const renderChip = (c: Chip) => {
    const Ico = c.icon;
    return (
      <button
        key={c.token}
        type="button"
        className="tb-chip"
        title={c.preview ? `${c.token} → ${c.preview()}` : c.token}
        onClick={() => onInsert(c.token)}
      >
        <Ico size={13} weight="bold" className="tb-chip-icon" />
        <span className="tb-chip-label">{c.label}</span>
      </button>
    );
  };

  // Insert a custom variable. The reader is prompted on use; an optional friendly label becomes the
  // prompt text (→ {{prompt:Label}}), otherwise a bare {{name}} is inserted.
  const addVariable = async () => {
    const name = await dialogs.prompt({
      title: "Insert variable",
      message: "A {{variable}} the reader is asked to fill when they use this template. You can write a question, e.g. “Who owns this?”.",
      placeholder: "client  —  or  —  Who owns this?",
    });
    const raw = name?.trim();
    if (!raw) return;
    // A multi-word / punctuated entry reads as a prompt label; a single identifier is a bare name.
    if (/^[\w-]+$/.test(raw)) onInsert(`{{${raw}}}`);
    else onInsert(`{{prompt:${raw.replace(/\}\}/g, "")}}}`);
  };

  return (
    <div className="tb-bar" role="toolbar" aria-label="Template tokens">
      <span className="tb-bar-title">
        <Stack size={14} weight="duotone" />
        Template tokens
      </span>

      <div className="tb-chips">
        {core.map(renderChip)}

        {/* Date with an explicit format → {{date:PATTERN}} */}
        <div className="tb-fmt-wrap">
          <button
            type="button"
            className={`tb-chip tb-chip-split${open === "fmt" ? " is-open" : ""}`}
            title="Insert a date in a specific format"
            onClick={() => setOpen((o) => (o === "fmt" ? null : "fmt"))}
            aria-expanded={open === "fmt"}
            aria-haspopup="menu"
          >
            <CalendarDots size={13} weight="bold" className="tb-chip-icon" />
            <span className="tb-chip-label">Date format</span>
            <CaretDown size={11} weight="bold" />
          </button>
          {open === "fmt" && (
            <div
              className="tb-fmt-menu"
              role="menu"
              tabIndex={-1}
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(null); }}
            >
              {DATE_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  role="menuitem"
                  className="tb-fmt-item"
                  onClick={() => { onInsert(`{{date:${p.value}}}`); setOpen(null); }}
                >
                  <span className="tb-fmt-sample">{formatDate(now, p.value)}</span>
                  <code className="tb-fmt-code">{p.value}</code>
                </button>
              ))}
            </div>
          )}
        </div>

        {showPeriodic && (
          <>
            <span className="tb-sep" aria-hidden />
            {periodic.map(renderChip)}
          </>
        )}

        <span className="tb-sep" aria-hidden />

        {/* Overflow: relative dates, path, identity tokens — kept out of the way until wanted. */}
        <div className="tb-fmt-wrap">
          <button
            type="button"
            className={`tb-chip tb-chip-split${open === "more" ? " is-open" : ""}`}
            title="More tokens"
            onClick={() => setOpen((o) => (o === "more" ? null : "more"))}
            aria-expanded={open === "more"}
            aria-haspopup="menu"
          >
            <DotsThreeOutline size={13} weight="bold" className="tb-chip-icon" />
            <span className="tb-chip-label">More</span>
            <CaretDown size={11} weight="bold" />
          </button>
          {open === "more" && (
            <div
              className="tb-more-menu"
              role="menu"
              tabIndex={-1}
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(null); }}
            >
              {more.map((c) => {
                const Ico = c.icon;
                return (
                  <button
                    key={c.token}
                    type="button"
                    role="menuitem"
                    className="tb-more-item"
                    onClick={() => { onInsert(c.token); setOpen(null); }}
                  >
                    <Ico size={14} weight="bold" className="tb-more-icon" />
                    <span className="tb-more-label">{c.label}</span>
                    {c.preview && <span className="tb-more-preview">{c.preview()}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button type="button" className="tb-chip tb-chip-add" onClick={addVariable} title="Insert a custom variable">
          <Plus size={13} weight="bold" className="tb-chip-icon" />
          <span className="tb-chip-label">Variable</span>
        </button>
      </div>

      <span className="tb-hint" title="Built-in tokens resolve automatically; custom variables prompt the reader.">
        <Info size={13} weight="bold" />
      </span>
    </div>
  );
}
