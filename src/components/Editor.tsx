import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table as TableExt } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { WikiLink } from "./WikiLink";
import { ImageNode } from "./ImageNode";
import { dialogs } from "./Dialogs";
import { Extension, InputRule } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Fragment } from "@tiptap/pm/model";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckSquare,
  Quotes,
  TextHOne,
  TextHTwo,
  TextHThree,
  ListBullets,
  ListNumbers,
  Code,
  Minus,
  Lightbulb,
  CalendarBlank,
  CalendarDots,
  CalendarPlus,
  Repeat,
  Clock,
  FilePlus,
  FileText,
  LinkSimple,
  Plus,
  Table,
  Database,
  TextB,
  TextItalic,
  TextStrikethrough,
  LinkSimpleHorizontal,
  SortAscending,
  SortDescending,
  CalendarCheck,
  Circle,
  CheckCircle,
  Flag,
  CaretRight,
  ArrowBendUpRight,
  type Icon,
} from "@phosphor-icons/react";
import ContextMenu, { type MenuItem, type MenuEntry, type MenuFormatButton } from "./ContextMenu";
import DatePicker from "./DatePicker";
import QueryHelper from "./QueryHelper";
import { QueryBlock } from "./QueryBlock";
import { docToMarkdown, markdownToHtml } from "../markdown";
import { formatDate } from "../dateformat";
import { CURSOR_SENTINEL } from "../templates";
import type { Period } from "../periodic";

/** A page the `/link` command can reference. */
export interface PageRef {
  name: string;
  rel_path: string;
}

/**
 * Where a task should be *moved* (not due-dated) by the context menu's "Send to". `line` is the
 * 0-based index of the task's line in the document's serialized markdown body — what the host's
 * `moveTaskBlock` expects. `date` is any date inside the destination period; the host derives the
 * exact note path. The editor flushes its pending markdown before computing `line` so it matches
 * what the host reads from disk.
 */
export interface SendTaskTarget {
  period: Period;
  date: Date;
}

interface Props {
  /** Markdown body to edit. */
  value: string;
  /** Called (debounced) with the serialized markdown when the user edits. */
  onChange: (markdown: string) => void;
  /** Bumping this forces the editor to reload external content (e.g. switched files). */
  reloadKey: string;
  /** Pages available for the `/link` slash command (wikilink references). */
  pages?: PageRef[];
  /** Templates available for the `/template` slash command. */
  templates?: { rel_path: string; name: string }[];
  /**
   * Resolve a chosen template (by rel_path) to its variable-filled markdown body, prompting the
   * host for any custom {{variables}}. Resolves null if cancelled. The editor inserts the body at
   * the caret. When absent, `/template` is hidden from the slash menu.
   */
  onInsertTemplate?: (relPath: string) => Promise<string | null>;
  /** Existing tags in the vault, suggested by the `#` autocomplete (Obsidian-style). */
  tags?: string[];
  /**
   * Create a new page from the `/page` slash command. Receives an optional name (prompted by the
   * editor) and resolves to the created page's display name, or null if creation was cancelled.
   * The editor then inserts a `[[wikilink]]` to it at the caret.
   */
  onCreatePage?: (name?: string) => Promise<string | null> | string | null | void;
  /**
   * Create a database from the `/database` slash command (a folder + `.pinpoint-db.json` schema).
   * Receives an optional name (prompted by the editor) and resolves to the created database's
   * rel_path, or null if creation was cancelled. The editor inserts a `[[wikilink]]` to it.
   */
  onCreateDatabase?: (name?: string) => Promise<string | null> | string | null | void;
  /** Open the page referenced by a `[[wikilink]]` when it's clicked. */
  onOpenPage?: (name: string) => void;
  /** Open a page by its vault-relative path (used by inline TASK query results). */
  onOpenPath?: (relPath: string) => void;
  /** Open a tag in the Tags view when its inline pill is clicked. */
  onOpenTag?: (tag: string) => void;
  /**
   * Persist a pasted/dropped image into the vault (the `.attachments` folder) and resolve to its
   * vault-relative path, which is inserted as a markdown image. Resolves to null on failure (the
   * image is then skipped). When absent, image paste/drop falls back to the editor's default.
   */
  onAddAttachment?: (file: { bytes: Uint8Array; mime: string; name?: string }) => Promise<string | null>;
  /**
   * Called when a selected image whose file lives in `.attachments` is deleted (Delete/Backspace),
   * once no other reference to that file remains in the document. The host decides the file's fate
   * (keep it, move it to Trash, or delete it permanently). `relPath` is the orphaned file's path.
   */
  onAttachmentRemoved?: (relPath: string) => void;
  /**
   * Called after an inline TASK query block toggles a task on disk, with that task's vault-relative
   * path. The host reloads the editor when the path is the open document so its own checkboxes
   * refresh without a manual F5.
   */
  onTaskToggled?: (relPath: string) => void;
  /**
   * Move the task under the caret (and its subtasks) into another periodic note — the context
   * menu's "Send to". `line` is the 0-based index of the task line in the *current* serialized
   * markdown body (the editor flushes pending edits before computing it). The host derives the
   * destination path from `target`, creating that note from the period's template if it doesn't
   * exist yet (warning the user first). When absent, "Send to" is hidden. Distinct from setting a
   * due date — this relocates the task line itself.
   */
  onSendTask?: (line: number, target: SendTaskTarget) => void;
  /** Pattern for /today and the /date default. */
  dateFormat?: string;
  /** Pattern for the /time command. */
  timeFormat?: string;
  /** Pattern for rendering task due-dates in inline TASK query blocks. */
  taskDateFormat?: string;
  /** Current editor page-column width in px (drives the draggable ruler and the column max-width). */
  pageWidth?: number;
  /**
   * Persist a new page width (px) chosen via the ruler. Applies to all pages — the host clamps and
   * saves it to settings. Omit to disable the ruler entirely.
   */
  onPageWidthChange?: (px: number) => void;
  /**
   * Optional content rendered at the top of the scrolling editor column, above the document body
   * (used for the database-row properties panel). Scrolls with the doc and shares its width.
   */
  headerSlot?: React.ReactNode;
  /**
   * Imperative "insert this text at the caret" signal, used by the template builder's chips. Bump
   * `n` (with the new `text`) to insert; the editor inserts once per distinct `n`. A signal rather
   * than a callback so the host stays declarative and React de-dupes re-renders.
   */
  insertText?: { text: string; n: number };
  /** As-you-type symbol replacements: trigger → output (e.g. `"->": "→"`). From settings. */
  smartReplacements?: Record<string, string>;
  /** Text-expansion snippets: name → inserted text, fired as `<delimiter>name<delimiter>`. */
  snippets?: Record<string, string>;
  /** Delimiter that wraps a snippet name to fire it (default `_`). */
  snippetDelimiter?: string;
  /** Show the floating formatting toolbar at the top of the editor (Settings → Editor). Default true. */
  showToolbar?: boolean;
}

/** Slash-menu command groups, in display order. */
type SlashGroup = "Basic blocks" | "Lists" | "Advanced" | "Insert" | "Task";
const GROUP_ORDER: SlashGroup[] = ["Basic blocks", "Lists", "Advanced", "Insert", "Task"];

/** A slash-menu command. `run` receives the TipTap editor with the typed `/query` already removed. */
interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  group: SlashGroup;
  icon: Icon;
  run: (editor: any, ctx: SlashContext) => void | Promise<void>;
}

interface SlashContext {
  pages: PageRef[];
  onCreatePage?: (name?: string) => Promise<string | null> | string | null | void;
  onCreateDatabase?: (name?: string) => Promise<string | null> | string | null | void;
  /** User-chosen pattern for /today and the /date default (see dateformat.ts). */
  dateFormat: string;
  /** User-chosen pattern for /time (current time). */
  timeFormat: string;
  /** Open the inline date-picker popup; resolves to a YYYY-MM-DD string, or null if dismissed. */
  requestDate: () => Promise<string | null>;
  /** Open the inline query-helper popup to compose a query and insert it as a query block. */
  requestQuery: () => void;
  /** Templates available for `/template` (empty hides the command). */
  templates: { rel_path: string; name: string }[];
  /** Resolve a template to its filled markdown body (prompting for variables), or null if cancelled. */
  onInsertTemplate?: (relPath: string) => Promise<string | null>;
}

/**
 * Subsequence fuzzy match: returns a score (higher is better) if every char of `query` appears in
 * `text` in order, else -1. Consecutive and start-of-word matches score higher, so "rdm" ranks
 * "Readme" above "Random Draft Meeting". Case-insensitive.
 */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] === ch) { found = j; break; }
    }
    if (found === -1) return -1;
    score += 1;
    if (found === prevMatch + 1) score += 2; // consecutive
    if (found === 0 || /\W|_|\//.test(t[found - 1])) score += 3; // word boundary
    prevMatch = found;
    ti = found + 1;
  }
  // Prefer shorter targets and earlier first matches.
  return score - text.length * 0.01;
}

/** Rank `pages` against a wikilink query, returning the best matches first. */
function rankPages(pages: PageRef[], query: string): PageRef[] {
  if (!query) return pages.slice(0, 20);
  return pages
    .map((p) => ({ p, s: fuzzyScore(query, p.name) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 20)
    .map((x) => x.p);
}

// Auto-closing pairs for brackets and quotes.
const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" };
const CLOSERS = new Set(Object.values(PAIRS));

/**
 * ProseMirror `handleTextInput` for auto-closing brackets/quotes. Returns true when it handled the
 * input (so the default insertion is suppressed). Behaviours:
 *  - typing an opener inserts the matching closer and leaves the caret between them;
 *  - with a non-empty selection, the opener/closer wrap the selection;
 *  - typing a closer right before the same auto-inserted closer just steps over it.
 *
 * `getReplacements` lets the step-over path also apply a symbol replacement, so triggers that end in
 * an auto-closed bracket (e.g. `(tm)` → `™`, `(c)` → `©`) still fire: stepping over the `)` isn't a
 * text-input transaction, so the SmartReplace input rule never sees it — we resolve it here instead.
 */
function handleAutoClose(
  view: any,
  from: number,
  to: number,
  text: string,
  getReplacements: () => Record<string, string>
): boolean {
  const { state } = view;
  const close = PAIRS[text];
  const nextChar = state.doc.textBetween(to, Math.min(to + 1, state.doc.content.size));

  // Step over an existing closing char instead of inserting a duplicate.
  if (from === to && CLOSERS.has(text) && nextChar === text) {
    const tr = state.tr;
    // Resolve a symbol whose trigger ends with this just-stepped-over closer (e.g. `(tm)` → `™`).
    // The trigger = up-to-5 chars before the caret + the closer being typed. `windowStart` anchors
    // those preceding chars so we can map resolveSymbol's `back` count to a real doc range.
    const windowStart = Math.max(0, from - 5);
    const before = state.doc.textBetween(windowStart, from) + text;
    const prevChar = windowStart > 0 ? state.doc.textBetween(windowStart - 1, windowStart) : "";
    const hit = resolveSymbol(before, prevChar, getReplacements());
    if (hit) {
      // `back` counts trigger chars from the END of `before` (… + the closer). The closer occupies
      // [to, to+1]; the preceding `back-1` chars occupy [from-(back-1), from]. Replace the whole span.
      tr.insertText(hit.output, from - (hit.back - 1), to + 1);
      view.dispatch(tr);
      return true;
    }
    // No trigger — just step over the closer.
    view.dispatch(tr.setSelection(TextSelection.near(state.doc.resolve(to + 1))));
    return true;
  }

  if (!close) return false;

  // Don't auto-close a quote when it's likely an apostrophe (preceded by a word char).
  if ((text === '"' || text === "'") && from === to) {
    const prev = state.doc.textBetween(Math.max(0, from - 1), from);
    if (/\w/.test(prev)) return false;
    // Also skip if the next char is a word char (e.g. typing before a word).
    if (/\w/.test(nextChar)) return false;
  }

  if (from !== to) {
    // Wrap the current selection.
    const selected = state.doc.textBetween(from, to);
    const tr = state.tr.insertText(text + selected + close, from, to);
    tr.setSelection(state.selection.constructor.create(tr.doc, from + 1, to + 1));
    view.dispatch(tr);
    return true;
  }

  // Insert the pair and place the caret between the two characters.
  const tr = state.tr.insertText(text + close, from, to);
  tr.setSelection(state.selection.constructor.near(tr.doc.resolve(from + 1)));
  view.dispatch(tr);
  return true;
}

/**
 * Move the current top-level block up or down, swapping it with its sibling (VS Code's
 * Alt+↑ / Alt+↓ "Move Line"). Operates on whole blocks because this is a rich-text editor —
 * the document unit is a block, matching how the line-number gutter counts blocks. The caret
 * (and any selection) rides along with the moved block. Returns false when there's no sibling
 * in that direction, so the keypress falls through.
 */
function moveBlock(state: any, dispatch: any, dir: -1 | 1): boolean {
  const { $from, $to } = state.selection;
  // Find the depth-1 block that contains the selection (a direct child of the doc).
  if ($from.depth < 1) return false;
  const blockStart = $from.before(1);
  const block = $from.node(1);
  const index = $from.index(0);
  const parent = state.doc; // depth-0 node
  const target = index + dir;
  if (target < 0 || target >= parent.childCount) return false;

  const sibling = parent.child(target);
  const tr = state.tr;
  // Compute insertion math before mutating: the offset of the caret inside the moved block, so
  // we can restore the selection to the same spot after the swap.
  const selOffset = state.selection.from - blockStart;

  let newBlockStart: number;
  if (dir === 1) {
    // Delete the block, then re-insert it after the (now-shifted) sibling.
    tr.delete(blockStart, blockStart + block.nodeSize);
    const insertAt = blockStart + sibling.nodeSize;
    tr.insert(insertAt, block);
    newBlockStart = insertAt;
  } else {
    const siblingStart = blockStart - sibling.nodeSize;
    tr.delete(blockStart, blockStart + block.nodeSize);
    tr.insert(siblingStart, block);
    newBlockStart = siblingStart;
  }
  if (dispatch) {
    const pos = newBlockStart + selOffset;
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
    tr.scrollIntoView();
    dispatch(tr);
  }
  return true;
}

const MoveBlock = Extension.create({
  name: "moveBlock",
  addKeyboardShortcuts() {
    return {
      "Alt-ArrowUp": ({ editor }) =>
        moveBlock(editor.state, editor.view.dispatch, -1),
      "Alt-ArrowDown": ({ editor }) =>
        moveBlock(editor.state, editor.view.dispatch, 1),
    };
  },
});

/**
 * Resolve the top-level block (a direct child of the doc) under viewport point (x, y) to the
 * document position just BEFORE it, plus its node and DOM. We map the point to a doc position, then
 * walk up to depth 1 — so hovering anywhere inside a nested list item still grabs the whole
 * top-level block it belongs to (matching the keyboard `moveBlock`, which also operates on whole
 * top-level blocks). Returns null off any block.
 */
/**
 * Resolve the draggable "line" under viewport point (x, y) — matching what the user sees and what
 * the line-number gutter counts: a LIST ITEM (`listItem`/`taskItem`) when the point is inside a
 * list, otherwise the top-level block. Returns that node's start position, its parent (for sibling
 * reordering), its index among the parent's children, and its DOM element. Null off any line.
 */
function lineAtCoords(
  view: any,
  x: number,
  y: number
): { pos: number; dom: HTMLElement } | null {
  // The gutter where the handle lives sits LEFT of the text column, so a point there often misses
  // every block. Clamp x into the text column before mapping, so hovering the gutter still resolves
  // to the line on that row.
  const domBox = view.dom.getBoundingClientRect();
  const clampedX = Math.max(domBox.left + 4, Math.min(x, domBox.right - 4));
  const found = view.posAtCoords({ left: clampedX, top: y });
  if (!found) return null;
  const $pos = view.state.doc.resolve(Math.min(found.pos, view.state.doc.content.size));
  if ($pos.depth < 1) return null;

  // Prefer the DEEPEST list item ancestor (so each row of a list is its own draggable line); fall
  // back to the top-level block (depth 1) for plain paragraphs/headings/etc.
  let depth = 1;
  for (let d = $pos.depth; d >= 1; d--) {
    const name = $pos.node(d).type.name;
    if (name === "listItem" || name === "taskItem") { depth = d; break; }
  }
  const pos = $pos.before(depth);
  const dom = view.nodeDOM(pos) as HTMLElement | null;
  if (!dom || dom.nodeType !== 1) return null;
  return { pos, dom };
}

/**
 * The sibling rows of the line whose node starts at `linePos`, as {pos, dom} pairs in document
 * order — i.e. the children of that line's parent at the same depth. Used to compute the drop gap
 * and indicator, so dragging reorders strictly within the same list/level the line belongs to.
 */
function siblingRows(view: any, linePos: number): { pos: number; dom: HTMLElement }[] {
  const { state } = view;
  const $line = state.doc.resolve(linePos + 1);
  const depth = $line.depth;
  const parent = $line.node(depth - 1);
  const parentStart = $line.start(depth - 1);
  const rows: { pos: number; dom: HTMLElement }[] = [];
  let at = parentStart;
  for (let i = 0; i < parent.childCount; i++) {
    const dom = view.nodeDOM(at) as HTMLElement | null;
    if (dom && dom.nodeType === 1) rows.push({ pos: at, dom });
    at += parent.child(i).nodeSize;
  }
  return rows;
}

/**
 * Move the line whose node starts at `fromPos` (a list item or top-level block) so it lands before
 * the sibling at `targetIndex`, reordering among its same-depth siblings only. The node (with any
 * nested sub-list) rides along, in one transaction (single undo). A no-op when order wouldn't change.
 */
function moveLineTo(view: any, fromPos: number, targetIndex: number): boolean {
  const { state } = view;
  const $from = state.doc.resolve(fromPos + 1);
  const depth = $from.depth;
  const parent = $from.node(depth - 1);
  const srcIndex = $from.index(depth - 1);
  // Dropping into the line's own slot, or the slot right after it, is a no-op.
  if (targetIndex === srcIndex || targetIndex === srcIndex + 1) return false;
  if (targetIndex < 0 || targetIndex > parent.childCount) return false;

  const node = parent.child(srcIndex);
  // Start position of `targetIndex` among the parent's children, on the CURRENT doc.
  const parentStart = $from.start(depth - 1);
  let insertAt = parentStart;
  for (let i = 0; i < targetIndex; i++) insertAt += parent.child(i).nodeSize;

  const tr = state.tr;
  tr.delete(fromPos, fromPos + node.nodeSize);
  const mappedInsert = insertAt > fromPos ? insertAt - node.nodeSize : insertAt;
  tr.insert(mappedInsert, node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(mappedInsert + 1)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Notion-style block drag handle. A floating `⋮⋮` grip appears in the left gutter beside whichever
 * "line" the pointer is over — a list item when inside a list, otherwise the top-level block, which
 * matches what the user sees and what the line-number gutter counts. Grabbing it drags that line to
 * reorder it among its siblings, with a horizontal drop line showing where it will land. A
 * pointer-driven complement to the Alt+↑/↓ keyboard move.
 *
 * Built as a ProseMirror plugin so it lives and dies with the editor view. The handle and the drop
 * indicator are plain DOM nodes appended to the editor's parent (`.editor-content`), positioned
 * absolutely; no React state is touched during a drag, so dragging stays smooth.
 */
const blockDragKey = new PluginKey("blockDragHandle");
const BlockDragHandle = Extension.create({
  name: "blockDragHandle",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockDragKey,
        view(view) {
          const wrap = view.dom.parentElement as HTMLElement | null; // .editor-content
          if (!wrap) return {};
          if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";

          // The grip. `draggable` so a real HTML5 drag starts; positioned over the left gutter.
          const handle = document.createElement("div");
          handle.className = "block-drag-handle";
          handle.setAttribute("draggable", "true");
          handle.setAttribute("contenteditable", "false");
          handle.title = "Drag to move • click to select";
          handle.innerHTML =
            '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
            '<circle cx="5" cy="3" r="1.4"/><circle cx="11" cy="3" r="1.4"/>' +
            '<circle cx="5" cy="8" r="1.4"/><circle cx="11" cy="8" r="1.4"/>' +
            '<circle cx="5" cy="13" r="1.4"/><circle cx="11" cy="13" r="1.4"/></svg>';
          wrap.appendChild(handle);

          // Horizontal drop indicator, shown only while dragging.
          const indicator = document.createElement("div");
          indicator.className = "block-drop-indicator";
          indicator.style.display = "none";
          wrap.appendChild(indicator);

          let hoverPos: number | null = null; // doc pos of the block the handle is pinned to
          let dragging = false;
          let dropIndex: number | null = null; // top-level index the block would land before

          // Pin the grip a fixed gap to the LEFT of the block's own left edge, vertically aligned to
          // its first text line. Both offsets are measured against the block's box (not the centered
          // .editor-content column), so the handle stays glued to the line under any page width,
          // column centering, or list indentation — no drift.
          const HANDLE_GAP = 26; // px between the grip's right side and the line's left edge
          // With line numbers on, the number column lives in the block's left padding (≈2.6rem), so
          // a plain gap would drop the grip over the digits. Push it further left to clear them.
          const LINE_NUM_CLEAR = 44;
          const place = (dom: HTMLElement) => {
            // Measure against the element the browser actually positions the handle against (its
            // offsetParent) — NOT an assumed `wrap`. If those differ, `left`/`top` would be applied
            // to a different origin and the grip drifts (e.g. far to the right). This keeps it exact.
            const originBox = (handle.offsetParent ?? wrap).getBoundingClientRect();
            const box = dom.getBoundingClientRect();
            const lineNums = document.documentElement.classList.contains("show-line-numbers");
            const gap = lineNums ? HANDLE_GAP + LINE_NUM_CLEAR : HANDLE_GAP;
            handle.style.left = `${box.left - originBox.left - gap}px`;
            handle.style.top = `${box.top - originBox.top + 1}px`;
            handle.style.display = "flex";
          };

          const onMove = (e: MouseEvent) => {
            if (dragging) return;
            const hit = lineAtCoords(view, e.clientX, e.clientY);
            if (!hit) {
              hoverPos = null;
              handle.style.display = "none";
              return;
            }
            hoverPos = hit.pos;
            place(hit.dom);
          };
          const onLeave = (e: MouseEvent) => {
            // Keep the handle while the pointer is over it (so it stays grabbable).
            if (dragging) return;
            const to = e.relatedTarget as Node | null;
            if (to && (handle.contains(to) || view.dom.contains(to))) return;
            handle.style.display = "none";
            hoverPos = null;
          };

          view.dom.addEventListener("mousemove", onMove);
          view.dom.addEventListener("mouseleave", onLeave);

          // Compute the drop index + indicator Y from a pointer Y, by finding the nearest gap between
          // the dragged line's SIBLINGS (same list/level). `left`/`right` bound the indicator to the
          // sibling column so it reads as "drop among these rows". Returns the sibling index to insert
          // before. Falls back to no-op data when the source line can't be resolved mid-drag.
          const computeDrop = (
            clientY: number
          ): { index: number; y: number; left: number; right: number } | null => {
            if (hoverPos == null) return null;
            const rows = siblingRows(view, hoverPos);
            if (!rows.length) return null;
            // Same origin the indicator is positioned against (its offsetParent), see `place`.
            const wrapBox = (indicator.offsetParent ?? wrap).getBoundingClientRect();
            const first = rows[0].dom.getBoundingClientRect();
            const last = rows[rows.length - 1].dom.getBoundingClientRect();
            const left = first.left - wrapBox.left;
            const right = wrapBox.right - last.right;
            for (let i = 0; i < rows.length; i++) {
              const box = rows[i].dom.getBoundingClientRect();
              const mid = box.top + box.height / 2;
              if (clientY < mid) return { index: i, y: box.top - wrapBox.top, left, right };
            }
            return { index: rows.length, y: last.bottom - wrapBox.top, left, right };
          };

          handle.addEventListener("dragstart", (e) => {
            if (hoverPos == null) { e.preventDefault(); return; }
            dragging = true;
            handle.classList.add("dragging");
            // A drag image isn't useful here (the grip is tiny); use a transparent 1px.
            const img = new Image();
            img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
            e.dataTransfer?.setDragImage(img, 0, 0);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
          });

          const onDragOver = (e: DragEvent) => {
            if (!dragging) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            const drop = computeDrop(e.clientY);
            if (!drop) { indicator.style.display = "none"; dropIndex = null; return; }
            dropIndex = drop.index;
            indicator.style.top = `${drop.y - 1}px`;
            indicator.style.left = `${drop.left}px`;
            indicator.style.right = `${drop.right}px`;
            indicator.style.display = "block";
          };
          wrap.addEventListener("dragover", onDragOver);

          const finishDrag = () => {
            dragging = false;
            dropIndex = null;
            handle.classList.remove("dragging");
            indicator.style.display = "none";
          };

          const onDrop = (e: DragEvent) => {
            if (!dragging) return;
            e.preventDefault();
            if (hoverPos != null && dropIndex != null) {
              moveLineTo(view, hoverPos, dropIndex);
            }
            finishDrag();
            handle.style.display = "none";
            hoverPos = null;
          };
          wrap.addEventListener("drop", onDrop);
          handle.addEventListener("dragend", finishDrag);

          // Click the grip (no drag) to select the whole block — handy before formatting/deleting it.
          handle.addEventListener("click", () => {
            if (hoverPos == null) return;
            const node = view.state.doc.nodeAt(hoverPos);
            if (!node) return;
            const tr = view.state.tr.setSelection(
              TextSelection.create(view.state.doc, hoverPos + 1, hoverPos + node.nodeSize - 1)
            );
            view.dispatch(tr);
            view.focus();
          });

          return {
            destroy() {
              view.dom.removeEventListener("mousemove", onMove);
              view.dom.removeEventListener("mouseleave", onLeave);
              wrap.removeEventListener("dragover", onDragOver);
              wrap.removeEventListener("drop", onDrop);
              handle.remove();
              indicator.remove();
            },
          };
        },
      }),
    ];
  },
});

/** Escape a literal trigger string for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface SmartReplaceConfig {
  /** Symbol replacements: trigger → output (e.g. `"->": "→"`). */
  replacements: Record<string, string>;
  /** Snippets: name → inserted text. Fired as `<delim>name<delim>`. */
  snippets: Record<string, string>;
  /** Delimiter wrapping a snippet name (default `_`). */
  delimiter: string;
}

interface SmartReplaceOptions {
  /**
   * Returns the live config. A getter (not a static object) so Settings edits apply without
   * re-creating the editor — the input-rule handlers read through it on every keystroke.
   */
  getConfig: () => SmartReplaceConfig;
}

/**
 * As-you-type replacements, Notion-style:
 *   - SYMBOLS: type `->` and it becomes `→`, `(tm)` → `™`, etc. (configurable in Settings).
 *   - SNIPPETS: type `_mycnpj_` and it expands to a predefined string (configurable in Settings).
 *   - DASHES: `word--word` → em dash, `1900--2000` → en dash (built-in, position-sensitive).
 *
 * All run as TipTap InputRules, so each swap is undoable: a single Backspace immediately after a
 * swap reverts it to the literal text you typed (see the Backspace shortcut below), and Ctrl+Z does
 * the same. Outputs are CommonMark-safe literals, so the markdown round-trip (src/markdown.ts) is
 * unaffected. Triggers are matched at the caret by longest suffix, and a trigger that's a prefix of
 * a longer one (`<-` vs `<->`) re-extends on the next char (see the symbol rule's handler).
 */
/**
 * Resolve a symbol replacement at the caret. `before` is the text immediately preceding the caret;
 * `prevChar` is the single char before that (for the re-extend case). Returns how many characters to
 * delete back from the caret and the `output` to insert, or null if nothing matches. Pure, so it's
 * shared between the input rule (typing) and the auto-close step-over (typing a closer).
 */
function resolveSymbol(
  before: string,
  prevChar: string,
  replacements: Record<string, string>
): { back: number; output: string } | null {
  // Longest suffix of the trailing run first.
  for (let i = 0; i < before.length; i++) {
    const cand = before.slice(i);
    const out = replacements[cand];
    if (out != null && out !== "") return { back: cand.length, output: out };
  }
  // Re-extend: the char before the run is a prior replacement's output we can grow into a longer one.
  if (prevChar) {
    let prevTrigger: string | undefined;
    for (const [trig, o] of Object.entries(replacements)) {
      if (o === prevChar) { prevTrigger = trig; break; }
    }
    if (prevTrigger) {
      const combined = prevTrigger + before;
      for (let i = 0; i < combined.length; i++) {
        const cand = combined.slice(i);
        const out = replacements[cand];
        if (out != null && out !== "" && cand.length > before.length) {
          return { back: before.length + 1, output: out };
        }
      }
    }
  }
  return null;
}

const SmartReplace = Extension.create<SmartReplaceOptions>({
  name: "smartReplace",
  addOptions() {
    return { getConfig: () => ({ replacements: {}, snippets: {}, delimiter: "_" }) };
  },
  addInputRules() {
    const getConfig = this.options.getConfig;
    const rules: InputRule[] = [];

    // ONE symbol rule. Rather than a rule per trigger (which would freeze the trigger set at mount),
    // we match a trailing run of symbol-ish chars and resolve the LONGEST trigger that's a suffix of
    // it against the live map — so adding/removing symbols in Settings takes effect immediately, with
    // no editor re-create. Symbol chars are the punctuation our triggers use (arrows, (), /, etc.).
    //
    // Re-extend: a trigger that is a prefix of a longer one (`<-` vs `<->`) fires first as you type,
    // so the longer one would never complete. To fix it we also peek at the ONE char before the run:
    // if it's the output of a prior replacement (e.g. `←`), we reconstruct the original trigger
    // (`<-`) + the new chars and re-resolve. So typing `<-` → `←`, then `>` → `↔` (the `←` is undone
    // and `<->` fires). A reverse output→trigger map makes this O(1).
    rules.push(
      new InputRule({
        find: /[-<>=!+~.()/\w]{1,6}$/,
        handler: ({ state, range, match }) => {
          const { replacements } = getConfig();
          const tail = match[0];
          const prevChar = range.from > 0 ? state.doc.textBetween(range.from - 1, range.from) : "";
          const hit = resolveSymbol(tail, prevChar, replacements);
          if (!hit) return null; // no trigger matched — leave the text as typed
          state.tr.insertText(hit.output, range.to - hit.back, range.to);
        },
      })
    );

    // Snippet rule — `<delim>name<delim>` looks `name` up in the live map. Fires on the closing
    // delimiter, so `_mycnpj_` expands the instant you type the trailing `_`.
    rules.push(
      new InputRule({
        find: /(?:[_;/~|])([\w.-]+)(?:[_;/~|])$/,
        handler: ({ state, range, match }) => {
          const { snippets, delimiter } = getConfig();
          const d = delimiter || "_";
          // Only honor the user's configured delimiter (the find regex is permissive for perf).
          if (!match[0].startsWith(d) || !match[0].endsWith(d)) return null;
          const text = snippets[match[1]];
          if (text == null) return null; // unknown name → leave literal text untouched
          state.tr.insertText(text, range.from, range.to);
        },
      })
    );

    // Em/en dash, fired by the character that follows `--` (Notion-style). These don't shadow a
    // `-->` arrow: that's triggered by `>` (not a word char), so the dash patterns don't match it.
    rules.push(
      new InputRule({
        find: /(\d)--(\d)$/,
        handler: ({ state, range, match }) => {
          state.tr.insertText(`${match[1]}–${match[2]}`, range.from, range.to);
        },
      }),
      new InputRule({
        find: /(\w)--(\w)$/,
        handler: ({ state, range, match }) => {
          state.tr.insertText(`${match[1]}—${match[2]}`, range.from, range.to);
        },
      })
    );
    return rules;
  },
  addKeyboardShortcuts() {
    // Backspace right after a replacement reverts it to the literal text (Notion behavior). TipTap
    // tracks the last input-rule transform; `undoInputRule` rolls just that back. Returning false
    // when there's nothing to undo lets Backspace fall through to its normal delete.
    return { Backspace: () => this.editor.commands.undoInputRule() };
  },
});

/**
 * Marks parent to-do items with a "subtask roll-up" state so they can be styled distinctly from a
 * plain checked/unchecked item:
 *   - `partial` — has descendant to-dos with a mix of done and not-done (semi-done).
 *   - `done`    — has descendant to-dos and all of them are done.
 * TipTap's TaskItem only tracks its own checkbox, so we compute the roll-up here via a node
 * decoration that adds `data-subtasks` to the rendered `<li>`. Decorations recompute on every doc
 * change, so the state always reflects the current children.
 */
const subtaskRollupKey = new PluginKey("subtaskRollup");
const SubtaskRollup = Extension.create({
  name: "subtaskRollup",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: subtaskRollupKey,
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "taskItem") return;
              // Tally only the immediately-nested to-do items (the direct sub-list). A deeper
              // grandchild list rolls up into its own parent, which in turn rolls up here.
              let done = 0;
              let total = 0;
              node.descendants((child) => {
                if (child.type.name === "taskItem") {
                  total++;
                  if (child.attrs.checked) done++;
                  return false; // don't descend past a child item; it handles its own subtree
                }
                return true;
              });
              if (total === 0) return;
              const rollup = done === 0 ? null : done === total ? "done" : "partial";
              if (rollup) {
                decos.push(
                  Decoration.node(pos, pos + node.nodeSize, { "data-subtasks": rollup }),
                );
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

// Visually render inline `#tags` as pill chips WITHOUT touching the document model: the text stays
// literal `#tag`, so the markdown round-trip (the source of truth) is completely untouched. This is
// the same decoration-overlay pattern as SubtaskRollup — a styling layer, not a content change.
//
// We match the index's tag rule (alphanumerics, `-`, `_`, `/`, and inner `.`/`!`/`?`), require the
// `#` to start a text node or follow whitespace (so `a#b` and `#rrggbb` colours mid-word never pill),
// and skip code so `#` inside code spans/blocks stays literal. `.`/`!`/`?` are allowed inside a tag
// (`#people.John`) but the pill must not extend over trailing punctuation, so the run can't end on
// one — matching `extract_tags`, which trims trailing `.!?`.
const tagPillKey = new PluginKey("tagPill");
const TAG_DECO_RE = /(^|\s)(#[A-Za-z0-9_/.!?-]*[A-Za-z][A-Za-z0-9_/.!?-]*[A-Za-z0-9_/-]|#[A-Za-z0-9_/.!?-]*[A-Za-z])/g;
interface TagPillOptions {
  /** Open a tag in the Tags view when its pill is clicked. */
  onOpenTag?: (tag: string) => void;
}
const TagPill = Extension.create<TagPillOptions>({
  name: "tagPill",
  addOptions() {
    return { onOpenTag: undefined };
  },
  addProseMirrorPlugins() {
    const { onOpenTag } = this.options;
    return [
      new Plugin({
        key: tagPillKey,
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              // Don't pill `#` inside code (inline code mark or a code block).
              if (node.marks.some((m) => m.type.name === "code")) return;
              const text = node.text;
              TAG_DECO_RE.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = TAG_DECO_RE.exec(text))) {
                // m[1] is the leading boundary (start or whitespace); the tag itself is m[2].
                const start = pos + m.index + m[1].length;
                const end = start + m[2].length;
                decos.push(Decoration.inline(start, end, { class: "tag-pill" }));
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
          // Click a pill to open that tag in the Tags view. We read the tag from the rendered text
          // (the decoration span wraps the literal `#tag`), so there's no doc-model coupling.
          handleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement | null)?.closest(".tag-pill");
            if (!el || !onOpenTag) return false;
            const tag = (el.textContent || "").replace(/^#/, "").trim();
            if (!tag) return false;
            onOpenTag(tag);
            return true;
          },
        },
      }),
    ];
  },
});

// Render an inline `priority:: high|medium|low` field as a colored flag pill — same decoration-overlay
// approach as TagPill, so the document text stays literal `priority:: high` (the indexer's source of
// truth is untouched). Two decorations per match: the `priority:: ` keyword is visually collapsed
// (kept in the doc for the caret + markdown), and the level word becomes the pill, with a flag glyph
// added via CSS `::before`. The level class (prio-high/medium/low) colours it from the --prio-* tokens.
const priorityPillKey = new PluginKey("priorityPill");
// Capture the keyword (incl. trailing space) and the level separately so we can hide one and pill the
// other. Case-insensitive; only the three known levels match so stray text never pills.
const PRIORITY_DECO_RE = /(priority::\s*)(high|medium|low)\b/gi;
const PriorityPill = Extension.create({
  name: "priorityPill",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: priorityPillKey,
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              if (node.marks.some((m) => m.type.name === "code")) return;
              const text = node.text;
              PRIORITY_DECO_RE.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = PRIORITY_DECO_RE.exec(text))) {
                const kwStart = pos + m.index;
                const kwEnd = kwStart + m[1].length; // end of "priority:: "
                const valEnd = kwEnd + m[2].length; // end of the level word
                const level = m[2].toLowerCase();
                // Collapse the `priority:: ` keyword; pill the level word with its colour class.
                decos.push(Decoration.inline(kwStart, kwEnd, { class: "priority-kw" }));
                decos.push(
                  Decoration.inline(kwEnd, valEnd, { class: `priority-pill prio-${level}` })
                );
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

const COMMANDS: SlashCommand[] = [
  { id: "h1", label: "Heading 1", hint: "Big section heading", keywords: "h1 heading title big",
    group: "Basic blocks", icon: TextHOne,
    run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: "h2", label: "Heading 2", hint: "Medium heading", keywords: "h2 heading subtitle",
    group: "Basic blocks", icon: TextHTwo,
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: "h3", label: "Heading 3", hint: "Small heading", keywords: "h3 heading",
    group: "Basic blocks", icon: TextHThree,
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: "bullet", label: "Bulleted list", hint: "Simple list", keywords: "bullet list ul unordered",
    group: "Lists", icon: ListBullets,
    run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "numbered", label: "Numbered list", hint: "Ordered list", keywords: "numbered ordered list ol",
    group: "Lists", icon: ListNumbers,
    run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "todo", label: "To-do list", hint: "Checkbox task", keywords: "todo task checkbox check",
    group: "Lists", icon: CheckSquare,
    run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: "quote", label: "Quote", hint: "Block quote", keywords: "quote blockquote",
    group: "Advanced", icon: Quotes,
    run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: "code", label: "Code block", hint: "Fenced code", keywords: "code block fenced pre",
    group: "Advanced", icon: Code,
    run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: "divider", label: "Divider", hint: "Horizontal rule", keywords: "divider hr rule line separator",
    group: "Advanced", icon: Minus,
    run: (e) => e.chain().focus().setHorizontalRule().run() },
  { id: "callout", label: "Callout", hint: "Highlighted note", keywords: "callout note info admonition",
    group: "Advanced", icon: Lightbulb,
    run: (e) => e.chain().focus().toggleBlockquote().insertContent("💡 ").run() },
  { id: "today", label: "Today", hint: "Insert today's date", keywords: "today date now",
    group: "Insert", icon: CalendarBlank,
    run: (e, ctx) => e.chain().focus().insertContent(formatDate(new Date(), ctx.dateFormat)).run() },
  { id: "time", label: "Now", hint: "Insert the current time", keywords: "time now clock hour",
    group: "Insert", icon: Clock,
    run: (e, ctx) => e.chain().focus().insertContent(formatDate(new Date(), ctx.timeFormat)).run() },
  { id: "date", label: "Date", hint: "Insert a date", keywords: "date day calendar",
    group: "Insert", icon: CalendarDots,
    run: async (e, ctx) => {
      const def = formatDate(new Date(), ctx.dateFormat);
      const v = await dialogs.prompt({ title: "Insert date", placeholder: ctx.dateFormat, defaultValue: def });
      if (v) e.chain().focus().insertContent(v).run();
    } },
  { id: "page", label: "New page", hint: "Create & link a page", keywords: "page new note create",
    group: "Insert", icon: FilePlus,
    run: async (e, ctx) => {
      const name = await dialogs.prompt({ title: "New page", placeholder: "Notes/Idea" });
      if (!name) return;
      const created = await ctx.onCreatePage?.(name);
      // Link to the new page at the caret. Use the returned display name when available,
      // otherwise fall back to the last path segment the user typed.
      const linkName = created || name.replace(/\.md$/i, "").split("/").pop() || name;
      e.chain().focus().insertContent({ type: "wikiLink", attrs: { name: linkName } }).run();
    } },
  { id: "database", label: "Database", hint: "Create & link a database", keywords: "database db table collection notion grid",
    group: "Insert", icon: Database,
    run: async (e, ctx) => {
      const name = await dialogs.prompt({ title: "New database", placeholder: "Projects" });
      if (!name) return;
      const rel = await ctx.onCreateDatabase?.(name);
      // Link to the new database folder at the caret. Prefer the returned rel_path's leaf,
      // otherwise fall back to the last segment the user typed.
      const linkName = (rel || name).replace(/\.md$/i, "").split("/").pop() || name;
      e.chain().focus().insertContent({ type: "wikiLink", attrs: { name: linkName } }).run();
    } },
  { id: "link", label: "Link to page", hint: "Reference a page", keywords: "link reference wikilink mention",
    group: "Insert", icon: LinkSimple,
    run: async (e, ctx) => {
      if (!ctx.pages.length) return;
      const names = ctx.pages.map((p) => p.name);
      const pick = await dialogs.prompt({
        title: "Link to page",
        message: names.slice(0, 30).join(", "),
        placeholder: "Page name",
        defaultValue: names[0],
      });
      if (!pick) return;
      const match = ctx.pages.find((p) => p.name.toLowerCase() === pick.toLowerCase()) ?? { name: pick };
      // Insert the wikiLink node so it renders as a styled page-link immediately.
      e.chain().focus().insertContent({ type: "wikiLink", attrs: { name: match.name } }).run();
    } },
  { id: "query", label: "Query", hint: "Embed a live query", keywords: "query dataview table list task sql dynamic embed",
    group: "Insert", icon: Table,
    // The `/query` token is already removed when this runs; the helper popup inserts the block.
    run: (_e, ctx) => ctx.requestQuery() },
  { id: "template", label: "Template", hint: "Insert a template", keywords: "template snippet boilerplate variable insert reuse",
    group: "Insert", icon: FileText,
    run: async (e, ctx) => {
      if (!ctx.templates.length || !ctx.onInsertTemplate) return;
      const names = ctx.templates.map((t) => t.name);
      const pick = await dialogs.prompt({
        title: "Insert template",
        message: names.slice(0, 30).join(", "),
        placeholder: "Template name",
        defaultValue: names[0],
      });
      if (!pick) return;
      const t = ctx.templates.find((x) => x.name.toLowerCase() === pick.toLowerCase());
      if (!t) return;
      const body = await ctx.onInsertTemplate(t.rel_path);
      if (body == null) return; // cancelled a variable prompt
      // Convert the filled markdown to HTML so multi-block templates insert as real blocks.
      e.chain().focus().insertContent(markdownToHtml(body)).run();
      // Honor a {{cursor}} marker, if the template had one.
      placeCursorAtSentinel(e);
    } },
  // Task properties — insert the inline markers the indexer parses (📅 due, 🔁 recurrence).
  { id: "due", label: "Due date", hint: "Set a 📅 due date", keywords: "due date deadline task 📅 schedule when",
    group: "Task", icon: CalendarPlus,
    run: async (e, ctx) => {
      const iso = await ctx.requestDate();
      if (iso) insertMarker(e, `📅 ${iso} `);
    } },
  { id: "repeat", label: "Recurrence", hint: "Repeat this task (🔁)", keywords: "repeat recurring rrule every 🔁 weekly daily task",
    group: "Task", icon: Repeat,
    run: async (e) => {
      const rule = await dialogs.prompt({
        title: "Recurrence",
        message: "e.g. “every week”, “every 2 days”, or an RRULE like FREQ=WEEKLY",
        placeholder: "every week",
      });
      if (rule) insertMarker(e, `🔁 ${rule} `);
    } },
];

/**
 * Insert an inline task marker (`📅 …` / `🔁 …`), guaranteeing a leading space when the caret is
 * directly after a non-space character. Without it the marker fuses to the preceding word
 * (`Task📅 …`), which muddies the task text and the indexer's field parsing.
 */
/** Local-midnight ISO date (YYYY-MM-DD) `days` from today — for the due-date / send-to presets. */
function isoFromOffset(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local-midnight `Date` `days` from today — for the "Send to" presets (which need a real Date). */
function dayFromOffset(days: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}

/** Day-offset from today to the coming Saturday (0 if today is already Saturday). */
function isoOffsetToWeekend(): number {
  const d = new Date();
  // 6 = Saturday; wrap so a result is always in [0, 6].
  return (6 - d.getDay() + 7) % 7;
}

function insertMarker(editor: any, marker: string): void {
  const { state } = editor;
  const { from } = state.selection;
  const prev = from > 0 ? state.doc.textBetween(from - 1, from) : " ";
  const needsSpace = prev !== "" && !/\s/.test(prev);
  editor.chain().focus().insertContent((needsSpace ? " " : "") + marker).run();
}

/**
 * Locate the enclosing `taskItem` of the current selection's anchor. Returns the position bounds of
 * its first text block (the paragraph holding the task text) plus that text, or null when the caret
 * isn't inside a task. Lets the marker setters edit a task line by position — independent of the
 * selection — so they append/replace markers without ever overwriting selected text.
 */
function taskParaRange(editor: any): { start: number; end: number; text: string } | null {
  const { $from } = editor.state.selection;
  let taskDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "taskItem") { taskDepth = d; break; }
  }
  if (taskDepth < 0) return null;
  const itemPos = $from.before(taskDepth);
  const para = $from.node(taskDepth).firstChild;
  const start = itemPos + 1 + 1; // +1 into taskItem, +1 into the paragraph
  const size = para?.content.size ?? 0;
  return { start, end: start + size, text: para?.textContent ?? "" };
}

/** Matches a serialized task line (`- [ ] …` / `- [x] …`), at any indent — never a plain bullet. */
const TASK_LINE_RE = /^\s*-\s*\[[ xX]\]/;

/**
 * The 0-based index, in the document's serialized markdown body, of the line for the task under the
 * caret — what the host's `moveTaskBlock` expects. We can't map ProseMirror positions to markdown
 * line numbers directly (the serializer normalizes blank lines), so we use an ORDINAL bridge: the
 * caret's `taskItem` is the Nth task item in document order, and — because only task items serialize
 * with a `[ ]`/`[x]` checkbox, in that same order — the Nth checkbox line in the markdown is its
 * line. Returns null off-task or if the counts somehow disagree.
 */
function taskLineIndexInMarkdown(editor: any): number | null {
  const { $from } = editor.state.selection;
  // The taskItem node enclosing the caret, and its document position.
  let taskDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "taskItem") { taskDepth = d; break; }
  }
  if (taskDepth < 0) return null;
  const targetPos = $from.before(taskDepth);

  // Ordinal of this taskItem among all taskItems, in document order.
  let ordinal = -1;
  let seen = 0;
  editor.state.doc.descendants((node: any, pos: number) => {
    if (node.type.name !== "taskItem") return true;
    if (pos === targetPos) ordinal = seen;
    seen++;
    return true; // keep descending — nested task items count too, in their own order
  });
  if (ordinal < 0) return null;

  // Walk the serialized markdown to the (ordinal)-th task line.
  const lines = docToMarkdown(editor.getJSON() as any).split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!TASK_LINE_RE.test(lines[i])) continue;
    if (count === ordinal) return i;
    count++;
  }
  return null;
}

/**
 * The task-line property markers, in the canonical trailing order we always normalize to:
 * priority, then due date (📅), then recurrence (🔁). Each entry knows how to match itself in the
 * paragraph text. Editing any one re-emits all present markers in this order at the line's end.
 */
type MarkerKind = "priority" | "due" | "repeat";
const MARKERS: { kind: MarkerKind; re: RegExp; render: (v: string) => string }[] = [
  { kind: "priority", re: /\bpriority::\s*(\S+)/i, render: (v) => `priority:: ${v}` },
  { kind: "due",      re: /📅\s*([^\s📅🔁]+)/u,    render: (v) => `📅 ${v}` },
  { kind: "repeat",   re: /🔁\s*([^📅🔁]*?)(?=\s*(?:📅|🔁|$))/u, render: (v) => `🔁 ${v}` },
];

/**
 * Apply one property change to the task under the caret, then rewrite ALL of its priority / due /
 * recurrence markers at the END of the line in the canonical order (priority → due → recurrence).
 * `value` is the new value for `kind`; `null` removes that marker. Works by position so a non-empty
 * selection is never overwritten, and de-duplicates/reorders any pre-existing markers. No-op off-task.
 */
function setTaskMarker(editor: any, kind: MarkerKind, value: string | null): void {
  const range = taskParaRange(editor);
  if (!range) return;
  const { start, end, text } = range;

  // Read each marker's current value, and the earliest offset any marker begins at, so we only
  // rewrite the trailing marker region and leave the task body (and its inline formatting) intact.
  const values: Record<MarkerKind, string | null> = { priority: null, due: null, repeat: null };
  let markersAt = text.length;
  for (const m of MARKERS) {
    const hit = m.re.exec(text);
    if (hit) {
      values[m.kind] = hit[1].trim();
      markersAt = Math.min(markersAt, hit.index);
    }
  }
  values[kind] = value && value.trim() ? value.trim() : null;

  // Re-emit present markers in canonical order: priority → due → recurrence.
  const tail = MARKERS
    .filter((m) => values[m.kind])
    .map((m) => m.render(values[m.kind] as string))
    .join(" ");

  // Keep everything before the first existing marker (right-trimmed) — its formatted nodes survive —
  // and replace only [bodyEnd .. paraEnd] with the normalized marker tail.
  const body = text.slice(0, markersAt).replace(/\s+$/, "");
  const replaceFrom = start + body.length;
  const insert = tail ? (body ? ` ${tail}` : tail) : "";

  editor.chain()
    .insertContentAt({ from: replaceFrom, to: end }, insert)
    .run();
}

/** Set (or clear, with `level: null`) the `priority:: <level>` field on the task under the caret. */
function setPriorityInEditor(editor: any, level: string | null): void {
  setTaskMarker(editor, "priority", level);
}

/**
 * Set (or refresh) an emoji-prefixed marker — due date (`📅`) or recurrence (`🔁`) — on the task under
 * the caret. `emoji` selects the kind; an empty `value` clears it. Markers are always re-normalized to
 * the canonical trailing order (priority → due → recurrence). A no-op outside a task.
 */
function setMarkerInEditor(editor: any, emoji: string, value: string): void {
  setTaskMarker(editor, emoji === "📅" ? "due" : "repeat", value);
}

/**
 * After inserting a filled template, move the caret to its {{cursor}} marker (the CURSOR_SENTINEL
 * text) and delete the marker. If the template had no {{cursor}}, the caret stays where insert left
 * it. Walks the doc once for the sentinel text; safe to call unconditionally.
 */
function placeCursorAtSentinel(editor: any): void {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node: any, pos: number) => {
    if (found || !node.isText) return;
    const idx = (node.text as string).indexOf(CURSOR_SENTINEL);
    if (idx >= 0) found = { from: pos + idx, to: pos + idx + CURSOR_SENTINEL.length };
    return !found;
  });
  if (!found) return;
  const { from, to } = found;
  // Delete the sentinel, then drop the caret where it was.
  editor.chain().focus().deleteRange({ from, to }).setTextSelection(from).run();
}

/**
 * Pull image files out of a paste/drop payload. Screenshots and copied images arrive under
 * `items` (kind "file"); dragged files arrive under `files`. We prefer `items` so a rich paste
 * that also carries `text/html` still yields the image, and only fall back to `files`.
 */
function imageFilesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  if (!out.length) {
    for (const f of Array.from(dt.files ?? [])) {
      if (f.type.startsWith("image/")) out.push(f);
    }
  }
  return out;
}

/** Does any image node currently in the document use this src? (Used to decide whether deleting an
 *  image orphaned its file, or whether other references to the same file remain.) */
function docReferencesImage(editor: any, src: string): boolean {
  let found = false;
  editor.state.doc.descendants((n: any) => {
    if (found) return false;
    if (n.type.name === "image" && n.attrs?.src === src) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Heuristic: does this plain text contain markdown block/inline syntax worth parsing? Used to
 * decide whether a text/plain paste (e.g. the contents of a .md file) should be rendered as
 * formatted blocks instead of dropped in literally. Conservative — a line of prose with a stray
 * asterisk won't trip it; we look for structural markers at line starts plus common inline marks.
 */
function looksLikeMarkdown(text: string): boolean {
  return /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|---\s*$|\|.*\|)/m.test(text) ||
    /\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)/.test(text);
}

/**
 * What the "Sort lines" actions order by. `alpha` is a locale-aware case-insensitive compare;
 * `date` pulls the first date-like token from each line and orders chronologically (lines without a
 * date sink to the end, keeping their relative order); `length` orders by character count; `done` /
 * `done-desc` order by a task item's checkbox state (only meaningful for taskItem siblings — the
 * menu only offers these when the selection is over task-list items).
 */
type SortMode = "asc" | "desc" | "date" | "length" | "done" | "done-desc" | "priority" | "priority-desc";

// An item's OWN first line of text, excluding any nested sub-list. `node.textContent` concatenates
// every descendant — so a parent task would inherit a child's `priority:: high`. We instead read the
// text up to the first nested list child, which is exactly the row the user sees as "this line".
function ownLineText(node: any): string {
  if (!node?.forEach) return node?.textContent ?? "";
  let out = "";
  node.forEach((child: any) => {
    const n = child.type?.name;
    if (n === "bulletList" || n === "orderedList" || n === "taskList") return; // skip the sub-list
    out += child.textContent;
  });
  return out;
}

// Priority rank from a task's OWN `priority:: high|medium|low` field: 3/2/1 for the levels, 0 when
// the line carries no (or an unrecognised) priority. Reads only the item's own line (not its nested
// children), so a subtask's priority never bleeds into its parent. Matches the indexer's `priority::`.
function nodePriority(node: any): number {
  const m = ownLineText(node).match(/\bpriority::\s*(high|medium|low)\b/i);
  if (!m) return 0;
  const level = m[1].toLowerCase();
  return level === "high" ? 3 : level === "medium" ? 2 : 1;
}

// First date-like token in a line: ISO (2024-01-31), slashed (01/31/2024 or 31/01/2024), or a
// `📅 YYYY-MM-DD` task due-marker. Returns a sortable timestamp, or null when the line has no date.
function lineDate(text: string): number | null {
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}`);
  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slash) {
    // Ambiguous MM/DD vs DD/MM — assume the larger of the two is the day (best-effort).
    const a = +slash[1], b = +slash[2];
    const [mm, dd] = a > 12 ? [b, a] : [a, b];
    const t = Date.parse(`${slash[3]}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// Is this a checked task item? Reads the taskItem's own `checked` attr, falling back to the node's
// first descendant taskItem (so a wrapping listItem still reports its checkbox). Non-tasks → false.
function taskChecked(node: any): boolean {
  if (node?.type?.name === "taskItem") return !!node.attrs?.checked;
  let found = false;
  node?.descendants?.((child: any) => {
    if (found) return false;
    if (child.type.name === "taskItem") { found = !!child.attrs?.checked; return false; }
    return true;
  });
  return found;
}

// A stable comparator for `mode`. Stability (via the original index) keeps equal lines in place and
// keeps date-less lines in their typed order at the bottom of a date sort.
function lineComparator(mode: SortMode) {
  return (a: { text: string; i: number; node: any }, b: { text: string; i: number; node: any }): number => {
    let d = 0;
    if (mode === "done" || mode === "done-desc") {
      // Unchecked (0) before checked (1) for `done`; reversed for `done-desc`.
      const ca = taskChecked(a.node) ? 1 : 0, cb = taskChecked(b.node) ? 1 : 0;
      d = mode === "done-desc" ? cb - ca : ca - cb;
    } else if (mode === "priority" || mode === "priority-desc") {
      // High → low for `priority` (rank 3 first); reversed for `priority-desc`. Lines with no
      // priority (rank 0) sink to the bottom of a high-first sort, rise to the top of low-first.
      // Rank reads each item's OWN line (via the node), so a subtask's priority never lifts a parent.
      const pa = nodePriority(a.node), pb = nodePriority(b.node);
      d = mode === "priority-desc" ? pa - pb : pb - pa;
    } else if (mode === "date") {
      const da = lineDate(a.text), db = lineDate(b.text);
      if (da == null && db == null) d = 0;
      else if (da == null) d = 1; // a sinks below b
      else if (db == null) d = -1;
      else d = da - db;
    } else if (mode === "length") {
      d = a.text.trim().length - b.text.trim().length;
    } else {
      d = a.text.localeCompare(b.text, undefined, { sensitivity: "base", numeric: true });
      if (mode === "desc") d = -d;
    }
    return d !== 0 ? d : a.i - b.i;
  };
}

const LIST_NAMES = new Set(["bulletList", "orderedList", "taskList"]);

/**
 * Resolve WHAT the current selection should reorder. The result is the single source of truth both
 * the menu gating (`selectedSiblings`) and the mutation (`sortSelectedLines`) consume, so the menu
 * never offers a sort the action can't perform.
 *
 * Three shapes, in priority order:
 *  - `single`: the selection sits within ONE container (a list, or the doc) — reorder the children
 *    the selection spans. This is the ordinary case.
 *  - `descend`: the selection's shared ancestor is the doc but it brushes exactly ONE list (e.g. the
 *    caret started in a heading above it) — drop INTO that list and reorder all its items.
 *  - `multi`: the selection spans SEVERAL adjacent same-type lists. A markdown task list broken by
 *    blank lines (or interleaved blocks) parses into multiple sibling `taskList` nodes; the user sees
 *    one list and expects one sort. We reorder every item across those lists as one sequence and
 *    write them back keeping each list node's original item COUNT, so the visual grouping survives.
 *    Without this, the doc-level children are opaque list blocks and sorting fuses their text.
 */
type SortScope =
  | { kind: "single"; parent: any; fromIdx: number; toIdx: number; contentStart: number }
  | { kind: "multi"; lists: { node: any; start: number }[] };

function sortScope(state: any): SortScope | null {
  const { $from, $to } = state.selection;
  for (let d = Math.min($from.depth, $to.depth); d >= 0; d--) {
    const parent = $from.node(d);
    if (parent !== $to.node(d)) continue; // not a shared ancestor at this depth
    const isList = LIST_NAMES.has(parent.type.name);
    const isDoc = d === 0;
    if (!isList && !isDoc) continue;

    const fromIdx = $from.index(d);
    // `$to.index(d)` is the index AFTER the last touched child when the selection ends at the parent's
    // content boundary; clamp so the inclusive [fromIdx..toIdx] range never indexes past the last child.
    const toIdx = Math.min($to.index(d), parent.childCount - 1);
    // Position just inside `parent`, where its child 0 begins. For the doc that's 0; otherwise it's
    // one past the parent's own opening token.
    const parentContentStart = d === 0 ? 0 : $from.before(d) + 1;

    // At the doc level the selection often spans whole list blocks, not their items. Find every list
    // among the touched top-level blocks and decide between the `descend` (one list) and `multi`
    // (several adjacent same-type lists) shapes.
    if (isDoc) {
      const lo = Math.min(fromIdx, toIdx);
      const hi = Math.min(Math.max(fromIdx, toIdx), parent.childCount - 1);
      // Walk the touched blocks, tracking each list's doc position.
      let pos = parentContentStart;
      for (let i = 0; i < lo; i++) pos += parent.child(i).nodeSize;
      const lists: { node: any; start: number }[] = [];
      let nonListBlocks = 0;
      for (let i = lo; i <= hi; i++) {
        const child = parent.child(i);
        if (LIST_NAMES.has(child.type.name)) lists.push({ node: child, start: pos + 1 }); // +1: into the list
        else if (child.textContent.trim()) nonListBlocks++; // ignore blank spacer paragraphs
        pos += child.nodeSize;
      }
      const totalItems = lists.reduce((n, l) => n + l.node.childCount, 0);

      // One list brushed → sort its items in place.
      if (lists.length === 1 && lists[0].node.childCount >= 2) {
        const list = lists[0].node;
        return { kind: "single", parent: list, fromIdx: 0, toIdx: list.childCount - 1, contentStart: lists[0].start };
      }
      // Several adjacent lists of the SAME type → sort their items as one sequence. (Mixed list types
      // can't merge cleanly — fall through and sort the blocks, which at least stays well-formed.)
      if (lists.length >= 2 && totalItems >= 2) {
        const type0 = lists[0].node.type.name;
        if (lists.every((l) => l.node.type.name === type0)) {
          return { kind: "multi", lists };
        }
      }
      if (nonListBlocks + lists.length < 2) return null;
    }

    if (toIdx <= fromIdx) return null; // selection within a single sibling — nothing to sort
    return { kind: "single", parent, fromIdx, toIdx, contentStart: parentContentStart };
  }
  return null;
}

/**
 * The sibling "lines" the current selection spans (for inspecting them, e.g. counting tasks), or
 * null when sorting wouldn't apply. Thin wrapper over `sortScope` so gating and mutation never drift.
 * For the `multi` shape it returns the union of all items across the spanned lists.
 */
function selectedSiblings(state: any): { siblings: any[] } | null {
  const scope = sortScope(state);
  if (!scope) return null;
  const siblings: any[] = [];
  if (scope.kind === "multi") {
    for (const l of scope.lists) l.node.forEach((it: any) => siblings.push(it));
  } else {
    for (let i = scope.fromIdx; i <= scope.toIdx; i++) siblings.push(scope.parent.child(i));
  }
  return { siblings };
}

/**
 * Does the selection cover at least two task items (so "Sort by done" is meaningful)? Reads the same
 * selected-sibling set, so it only fires when those highlighted lines are to-dos.
 */
function selectionHasTasks(state: any): boolean {
  const sel = selectedSiblings(state);
  if (!sel) return false;
  let count = 0;
  for (const node of sel.siblings) {
    if (node.type.name === "taskItem") count++;
    else node.descendants?.((c: any) => {
      if (c.type.name === "taskItem") { count++; return false; }
      return true;
    });
    if (count >= 2) return true;
  }
  return count >= 2;
}

/**
 * Is the caret/selection in or on at least ONE task? True when either endpoint sits inside a
 * `taskItem`, or the selection spans one or more task items. Unlike `selectionHasTasks` (which needs
 * ≥2 siblings for "Sort by done"), this powers the per-task actions — Priority / Due date / Send to —
 * that are meaningful on a single task under the caret.
 */
function selectionTouchesTask(state: any): boolean {
  const { $from, $to } = state.selection;
  for (const $pos of [$from, $to]) {
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).type.name === "taskItem") return true;
    }
  }
  // A wider selection that contains task items even if its endpoints aren't inside one.
  let found = false;
  state.doc.nodesBetween($from.pos, $to.pos, (node: any) => {
    if (found) return false;
    if (node.type.name === "taskItem") { found = true; return false; }
    return true;
  });
  return found;
}

/**
 * Reorder ONLY the sibling items/blocks the selection actually spans, in one transaction (single
 * undo). Two rules make this match what the user highlighted:
 *  - Scope = exactly the selected siblings. We sort the items from the one the selection starts in
 *    to the one it ends in — never the whole list/document. Highlight three of ten bullets and only
 *    those three move; the rest stay put.
 *  - Indentation is respected. We reorder siblings at a SINGLE depth, and each item keeps its own
 *    nested sub-list attached (it rides along inside the item's node), so a parent never jumps below
 *    its own children and items at different indent levels never interleave.
 * Returns false (a no-op) when fewer than two siblings are selected or they're already in order.
 */
// Stable sort of a set of "line" nodes by `mode`. Each entry pairs the node with its original index
// `i` (the comparator's tie-breaker keeps equal lines in place). Returns the nodes in sorted order,
// or null when the order is unchanged (so callers can no-op).
function sortNodes(nodes: any[], mode: SortMode): any[] | null {
  const entries = nodes.map((node, i) => ({ node, text: node.textContent, i }));
  const sorted = [...entries].sort(lineComparator(mode));
  if (sorted.every((s, idx) => s.i === entries[idx].i)) return null; // already ordered
  return sorted.map((s) => s.node);
}

function sortSelectedLines(editor: any, mode: SortMode): boolean {
  const { state } = editor;
  const scope = sortScope(state);
  if (!scope) return false;

  // MULTI: the selection spans several adjacent same-type lists (a task list broken by blank lines
  // parses into separate `taskList` nodes). Sort every item across them as one sequence, then write
  // the items back into the SAME list nodes, each keeping its original item count — so the visual
  // grouping (the blank-line breaks) is preserved while the items sort globally. Replace the lists
  // last-to-first so each replacement leaves earlier list positions valid.
  if (scope.kind === "multi") {
    const allItems: any[] = [];
    for (const l of scope.lists) l.node.forEach((it: any) => allItems.push(it));
    const sorted = sortNodes(allItems, mode);
    if (!sorted) return false;

    const tr = state.tr;
    let cursor = 0;
    const slices = scope.lists.map((l) => {
      const slice = sorted.slice(cursor, cursor + l.node.childCount);
      cursor += l.node.childCount;
      return slice;
    });
    for (let k = scope.lists.length - 1; k >= 0; k--) {
      const l = scope.lists[k];
      const from = l.start;
      const to = from + l.node.content.size;
      tr.replaceWith(from, to, Fragment.fromArray(slices[k]));
    }
    // Re-select the whole spanned run (first list's start to last list's end), which keeps the same
    // rows highlighted. Total size is unchanged, so the original end position still holds.
    const first = scope.lists[0];
    const last = scope.lists[scope.lists.length - 1];
    const runStart = first.start;
    const runEnd = last.start + last.node.content.size;
    tr.setSelection(TextSelection.between(tr.doc.resolve(runStart + 1), tr.doc.resolve(runEnd - 1)));
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
    return true;
  }

  // SINGLE: reorder the selected children of one container in place.
  const { parent, fromIdx, toIdx, contentStart } = scope;
  const slice: any[] = [];
  for (let i = fromIdx; i <= toIdx; i++) slice.push(parent.child(i));
  if (slice.length < 2) return false;
  const sorted = sortNodes(slice, mode);
  if (!sorted) return false;

  // Doc position of the selected run: `contentStart` is where the parent's child 0 begins, so add the
  // sizes of the children before `fromIdx` to reach the first selected sibling.
  let startPos = contentStart;
  for (let i = 0; i < fromIdx; i++) startPos += parent.child(i).nodeSize;
  const endPos = startPos + slice.reduce((sum, n) => sum + n.nodeSize, 0);

  const tr = state.tr;
  tr.replaceWith(startPos, endPos, Fragment.fromArray(sorted));
  // Keep the same lines highlighted after the sort: the run occupies the same [startPos, endPos]
  // span (total node size is unchanged), so re-select it. We anchor just inside the first sibling and
  // the last (startPos+1 / endPos-1) so the selection lands on text, not block boundaries —
  // TextSelection.between snaps to the nearest valid text positions.
  tr.setSelection(
    TextSelection.between(tr.doc.resolve(startPos + 1), tr.doc.resolve(endPos - 1)),
  );
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

export default function Editor({
  value,
  onChange,
  reloadKey,
  pages = [],
  tags = [],
  templates = [],
  onInsertTemplate,
  onCreatePage,
  onCreateDatabase,
  onOpenPage,
  onOpenPath,
  onOpenTag,
  onAddAttachment,
  onAttachmentRemoved,
  onTaskToggled,
  onSendTask,
  dateFormat = "YYYY-MM-DD",
  timeFormat = "HH:mm",
  taskDateFormat = "YYYY-MM-DD",
  pageWidth = 820,
  onPageWidthChange,
  headerSlot,
  insertText,
  smartReplacements,
  snippets,
  snippetDelimiter = "_",
  showToolbar = true,
}: Props) {
  // The page-width ruler is toggled with Ctrl+R; hidden by default so it never crowds the toolbar.
  const [rulerOpen, setRulerOpen] = useState(false);
  // Live smart-replace config in a ref, so editing symbols/snippets in Settings takes effect on the
  // next keystroke without re-creating the editor (the input-rule handlers read through this).
  const smartCfgRef = useRef<SmartReplaceConfig>({ replacements: {}, snippets: {}, delimiter: "_" });
  smartCfgRef.current = {
    replacements: smartReplacements ?? {},
    snippets: snippets ?? {},
    delimiter: snippetDelimiter || "_",
  };
  // Keep the open-page handlers in refs so node views always call the latest one without forcing
  // the editor to be re-created.
  const onOpenPageRef = useRef(onOpenPage);
  onOpenPageRef.current = onOpenPage;
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
  const onOpenTagRef = useRef(onOpenTag);
  onOpenTagRef.current = onOpenTag;
  const onAddAttachmentRef = useRef(onAddAttachment);
  onAddAttachmentRef.current = onAddAttachment;
  const onAttachmentRemovedRef = useRef(onAttachmentRemoved);
  onAttachmentRemovedRef.current = onAttachmentRemoved;
  const onTaskToggledRef = useRef(onTaskToggled);
  onTaskToggledRef.current = onTaskToggled;
  const onSendTaskRef = useRef(onSendTask);
  onSendTaskRef.current = onSendTask;
  const lastEmitted = useRef<string>(value);
  const [slash, setSlash] = useState<{ query: string; left: number; top: number } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  // `[[wikilink]]` autocomplete: triggered when the caret sits in an open `[[query`.
  const [link, setLink] = useState<{ query: string; left: number; top: number } | null>(null);
  const [linkIndex, setLinkIndex] = useState(0);
  // `#tag` autocomplete (Obsidian-style): triggered when the caret sits in a `#partial` token.
  const [tag, setTag] = useState<{ query: string; left: number; top: number } | null>(null);
  const [tagIndex, setTagIndex] = useState(0);
  // Inline date picker (the `/due` command). Open when non-null; `resolve` feeds the picked
  // ISO date back to the awaiting command.
  const [datePicker, setDatePicker] = useState<{ left: number; top: number } | null>(null);
  const datePickerResolve = useRef<((iso: string | null) => void) | null>(null);
  // Inline query-helper popup (the `/query` command, and the edit button on a query block).
  // `getPos` is set when editing an existing block (the position to replace); null on a fresh
  // insert. `dsl` pre-populates the builder when editing.
  const [queryHelper, setQueryHelper] = useState<
    { top: number; getPos: (() => number) | null; dsl: string } | null
  >(null);
  // "+ add task property" affordance: shown to the left of the current task line. `open` toggles
  // its little properties menu (Due date / Recurrence).
  const [taskHint, setTaskHint] = useState<{ left: number; top: number } | null>(null);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  // Right-click context menu (text formatting + sort lines). Open when non-null; positioned at the
  // pointer in viewport coords (ContextMenu clamps to the viewport itself).
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: MenuEntry[]; formatRow?: MenuFormatButton[] } | null>(null);

  // Caret position in editor-wrap-relative coords, for anchoring popups (mirrors detectSlash).
  const caretCoords = useCallback((ed: any): { left: number; top: number } => {
    const { from } = ed.state.selection;
    const coords = ed.view.coordsAtPos(from);
    const wrap = ed.view.dom.closest(".editor-wrap") as HTMLElement | null;
    const rect = wrap?.getBoundingClientRect();
    return { left: coords.left - (rect?.left ?? 0), top: coords.bottom - (rect?.top ?? 0) + 4 };
  }, []);

  // The editor instance, mirrored in a ref so callbacks defined before `useEditor` (requestDate,
  // runTaskProp) can reach the live editor without a use-before-declaration cycle.
  const editorRef = useRef<any>(null);

  // Save each pasted/dropped image to the vault (via onAddAttachment) and insert it as a block
  // image at `at` (a doc position; the drop point) or at the caret when omitted. The work is async
  // but the ProseMirror paste/drop handler must answer synchronously, so this is fire-and-forget.
  const insertImagesFromFiles = useCallback((files: File[], at?: number) => {
    const save = onAddAttachmentRef.current;
    if (!save) return;
    void (async () => {
      let pos = at;
      for (const f of files) {
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const rel = await save({ bytes, mime: f.type, name: f.name });
          if (!rel) continue;
          const ed = editorRef.current;
          if (!ed) return;
          const content = { type: "image", attrs: { src: rel, alt: "" } };
          if (pos != null) ed.chain().focus().insertContentAt(pos, content).run();
          else ed.chain().focus().insertContent(content).run();
          // Subsequent images in the same batch follow the caret rather than stacking at `at`.
          pos = undefined;
        } catch (e) {
          console.error("Failed to attach pasted image:", e);
        }
      }
    })();
  }, []);

  // Open the date picker at the caret and return a promise that resolves to the chosen date
  // (or null if dismissed). Used by the `/due` slash command.
  const requestDate = useCallback((): Promise<string | null> => {
    const ed = editorRef.current;
    if (!ed) return Promise.resolve(null);
    setDatePicker(caretCoords(ed));
    return new Promise<string | null>((resolve) => {
      datePickerResolve.current = resolve;
    });
  }, [caretCoords]);

  // Settle the date picker once: resolve the pending promise and close the popup.
  const closeDatePicker = useCallback((iso: string | null) => {
    datePickerResolve.current?.(iso);
    datePickerResolve.current = null;
    setDatePicker(null);
  }, []);

  // Vertical anchor (editor-wrap-relative `top`) for a popup pinned to the right edge. The helper
  // is docked to the right so it never sits over the line you're composing.
  const rightAnchorTop = useCallback((ed: any, pos: number): number => {
    try {
      const coords = ed.view.coordsAtPos(pos);
      const wrap = ed.view.dom.closest(".editor-wrap") as HTMLElement | null;
      const rect = wrap?.getBoundingClientRect();
      return coords.top - (rect?.top ?? 0);
    } catch {
      return 56; // position lookup can fail mid-transaction; fall back near the top
    }
  }, []);

  // Open the query-helper for a fresh `/query` insert, anchored to the right at the caret's height.
  const requestQuery = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    setQueryHelper({ top: rightAnchorTop(ed, ed.state.selection.from), getPos: null, dsl: "" });
  }, [rightAnchorTop]);

  // Open the query-helper to edit an existing block, pre-filled with its DSL (the block's edit
  // button routes here via the QueryBlock node's `onEdit` option).
  const editQuery = useCallback((getPos: () => number, dsl: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    setQueryHelper({ top: rightAnchorTop(ed, getPos()), getPos, dsl });
  }, [rightAnchorTop]);

  // Commit the helper's DSL: replace the edited block, or insert a new one at the caret.
  const commitQuery = useCallback((dsl: string) => {
    const ed = editorRef.current;
    if (!ed) return setQueryHelper(null);
    setQueryHelper((hp) => {
      if (hp?.getPos) {
        const pos = hp.getPos();
        const node = ed.state.doc.nodeAt(pos);
        if (node?.type.name === "queryBlock") {
          ed.chain().focus().command(({ tr }: any) => {
            tr.setNodeAttribute(pos, "dsl", dsl);
            return true;
          }).run();
        }
      } else {
        ed.chain().focus().insertQueryBlock(dsl).run();
      }
      return null;
    });
  }, []);

  // Keep ctx in a ref so command closures always see current props without re-creating the editor.
  const ctxRef = useRef<SlashContext>({ pages, onCreatePage, onCreateDatabase, dateFormat, timeFormat, requestDate, requestQuery, templates, onInsertTemplate });
  ctxRef.current = { pages, onCreatePage, onCreateDatabase, dateFormat, timeFormat, requestDate, requestQuery, templates, onInsertTemplate };

  // The query block's edit button calls the latest handler through this ref (the QueryBlock
  // extension is configured once, so it can't close over a fresh `editQuery`).
  const editQueryRef = useRef(editQuery);
  editQueryRef.current = editQuery;

  // ProseMirror-level keydown handler for the popups. Lives in a ref because the editor is created
  // once; it must run before ProseMirror's own handling so it can swallow Enter (no newline) when a
  // menu is open. Returns true when it handled the key.
  const handlePopupKeyRef = useRef<(e: KeyboardEvent) => boolean>(() => false);

  // Intercept Delete/Backspace on a *selected* image so we can offer to clean up its `.attachments`
  // file. Returns true when it handled the key (the node is deleted here); false to fall through to
  // ProseMirror's default deletion (non-image selections, non-attachment images, no host handler).
  const handleImageDeleteKey = useCallback((e: KeyboardEvent): boolean => {
    if (e.key !== "Backspace" && e.key !== "Delete") return false;
    const ed = editorRef.current;
    if (!ed) return false;
    const node = (ed.state.selection as any).node; // set only on a NodeSelection
    if (!node || node.type.name !== "image") return false;
    const src: string = node.attrs?.src ?? "";
    // Only manage files we own (pasted into `.attachments`) and only when a host handler exists;
    // otherwise let ProseMirror delete the node normally.
    if (!onAttachmentRemovedRef.current || !src.startsWith(".attachments/")) return false;
    ed.chain().focus().deleteSelection().run();
    // Prompt only when this was the last reference to the file in the document.
    if (!docReferencesImage(ed, src)) onAttachmentRemovedRef.current(src);
    return true;
  }, []);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
        // `autolink: false` — tags are literal `#tag` text styled by the TagPill decoration overlay
        // (never a link). TipTap's autolinker would treat `#tattoo-off` as a `#fragment` link and
        // rewrite it to `[#tattoo-off](#tattoo-off)`, corrupting the markdown source. Links are made
        // explicitly via the toolbar / markdown `[text](url)` / wikilinks, so autolink isn't needed.
        Link.configure({ openOnClick: false, autolink: false }),
        TaskList,
        TaskItem.configure({ nested: true }),
        TableExt.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        SubtaskRollup,
        TagPill.configure({ onOpenTag: (tag) => onOpenTagRef.current?.(tag) }),
        PriorityPill,
        ImageNode,
        WikiLink.configure({ onOpen: (name) => onOpenPageRef.current?.(name) }),
        QueryBlock.configure({
          onEdit: (getPos, dsl) => editQueryRef.current(getPos, dsl),
          onOpenPath: (relPath) => onOpenPathRef.current?.(relPath),
          onTaskToggled: (relPath) => onTaskToggledRef.current?.(relPath),
          dateFormat: taskDateFormat,
        }),
        MoveBlock,
        BlockDragHandle,
        SmartReplace.configure({ getConfig: () => smartCfgRef.current }),
      ],
      content: markdownToHtml(value),
      editorProps: {
        handleTextInput: (view, from, to, text) =>
          handleAutoClose(view, from, to, text, () => smartCfgRef.current.replacements),
        handleKeyDown: (_view, e) => handleImageDeleteKey(e) || handlePopupKeyRef.current(e),
        // Paste an image (screenshot, copied image) → save it to `.attachments` and insert it.
        // Only intercept when there's actually an image and a handler; otherwise let the default
        // text/html paste run.
        handlePaste: (view, event) => {
          const data = event.clipboardData;
          if (onAddAttachmentRef.current) {
            const files = imageFilesFromDataTransfer(data);
            if (files.length) {
              event.preventDefault();
              insertImagesFromFiles(files);
              return true;
            }
          }
          // Pasting the *text* of a .md file (or any raw markdown) arrives as text/plain. The
          // browser would drop it in verbatim, leaving `# Heading` as literal characters. When the
          // clipboard has no rich text/html (so we're not stomping on a real rich-text copy) but
          // the plain text contains markdown syntax, parse it through our md→HTML bridge and let
          // ProseMirror render real headings, lists, bold, etc.
          if (data) {
            const html = data.getData("text/html");
            const text = data.getData("text/plain");
            if (text && !html && looksLikeMarkdown(text)) {
              event.preventDefault();
              editorRef.current
                ?.chain()
                .focus()
                .insertContent(markdownToHtml(text))
                .run();
              return true;
            }
          }
          return false;
        },
        // Drop image files from the OS → same handling, inserted at the drop point. Internal
        // drags (`moved`) fall through to ProseMirror's own node move.
        handleDrop: (view, event, _slice, moved) => {
          if (moved || !onAddAttachmentRef.current) return false;
          const files = imageFilesFromDataTransfer(event.dataTransfer);
          if (!files.length) return false;
          event.preventDefault();
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          insertImagesFromFiles(files, at);
          return true;
        },
      },
      onUpdate: ({ editor }) => {
        const md = docToMarkdown(editor.getJSON() as any);
        lastEmitted.current = md;
        onChange(md);
        detectSlash(editor);
        detectLink(editor);
        detectTag(editor);
        detectTaskHint(editor);
      },
      onSelectionUpdate: ({ editor }) => {
        detectTag(editor);
        detectTaskHint(editor);
      },
    },
    [reloadKey]
  );
  editorRef.current = editor;

  // Detect a `/query` token at the caret on the current line and position the menu under it.
  const detectSlash = useCallback((ed: any) => {
    const { state } = ed;
    const { from, empty } = state.selection;
    if (!empty) return setSlash(null);
    const lineStart = state.doc.resolve(from).start();
    const textBefore = state.doc.textBetween(lineStart, from, "\n", "\n");
    const m = textBefore.match(/(?:^|\s)\/([\w]*)$/);
    if (!m) return setSlash(null);
    const coords = ed.view.coordsAtPos(from);
    const wrap = ed.view.dom.closest(".editor-wrap") as HTMLElement | null;
    const rect = wrap?.getBoundingClientRect();
    setSlash({
      query: m[1],
      left: coords.left - (rect?.left ?? 0),
      top: coords.bottom - (rect?.top ?? 0) + 4,
    });
    setSlashIndex(0);
  }, []);

  // Detect an open `[[query` at the caret (no closing `]]` between it and the caret) and position
  // the autocomplete under it. The query runs up to the caret on the current line.
  const detectLink = useCallback((ed: any) => {
    const { state } = ed;
    const { from, empty } = state.selection;
    if (!empty) return setLink(null);
    const lineStart = state.doc.resolve(from).start();
    const textBefore = state.doc.textBetween(lineStart, from, "\n", "\n");
    // Match the last `[[` that hasn't been closed: capture everything after it that isn't `]` or `[`.
    const m = textBefore.match(/\[\[([^\[\]]*)$/);
    if (!m) return setLink(null);
    const coords = ed.view.coordsAtPos(from);
    const wrap = ed.view.dom.closest(".editor-wrap") as HTMLElement | null;
    const rect = wrap?.getBoundingClientRect();
    setLink({
      query: m[1],
      left: coords.left - (rect?.left ?? 0),
      top: coords.bottom - (rect?.top ?? 0) + 4,
    });
    setLinkIndex(0);
  }, []);

  // Detect a `#partial` tag token at the caret and position the suggestion menu under it. Mirrors
  // the index's tag rule (alphanumerics, `-`, `_`, `/`); the `#` must start the line or follow
  // whitespace so we never fire inside `a#b`, a heading `# `, or a `#rrggbb` colour.
  const detectTag = useCallback((ed: any) => {
    const { state } = ed;
    const { from, empty } = state.selection;
    if (!empty) return setTag(null);
    const lineStart = state.doc.resolve(from).start();
    const textBefore = state.doc.textBetween(lineStart, from, "\n", "\n");
    const m = textBefore.match(/(?:^|\s)#([A-Za-z0-9_/.!?-]*)$/);
    // Require a letter to have been typed before suggesting, so a lone `#` (e.g. starting a heading
    // in plain markdown) doesn't pop the menu until it's clearly a tag.
    if (!m || m[1] === "") return setTag(null);
    const coords = ed.view.coordsAtPos(from);
    const wrap = ed.view.dom.closest(".editor-wrap") as HTMLElement | null;
    const rect = wrap?.getBoundingClientRect();
    setTag({
      query: m[1],
      left: coords.left - (rect?.left ?? 0),
      top: coords.bottom - (rect?.top ?? 0) + 4,
    });
    setTagIndex(0);
  }, []);

  // Show the "+ add task property" affordance when the caret sits inside a task-list item, anchored
  // just left of that line. Cleared otherwise (and the little menu collapses with it).
  const detectTaskHint = useCallback((ed: any) => {
    const { state } = ed;
    const { $from, empty } = state.selection;
    // Walk up the node ancestry looking for a taskItem, noting its depth so we can find its DOM.
    let taskDepth = -1;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "taskItem") {
        taskDepth = d;
        break;
      }
    }
    if (taskDepth < 0 || !empty) {
      setTaskHint(null);
      setTaskMenuOpen(false);
      setPriorityOpen(false);
      return;
    }
    // Anchor the `+` exactly where the caret sits at the END of the task's text — i.e. right after
    // the last typed character (the gap of "one character" is the CSS margin-left). coordsAtPos is
    // the SAME measurement ProseMirror uses to place its own caret, so the `+` tracks the text end
    // precisely and stays glued to it under any browser/webview zoom (it scales with the caret).
    //
    // We align the button's TOP to the caret's top (top: coords.top, no translate) so it sits on the
    // text baseline like a trailing character, rather than centered on the whole (possibly wrapped)
    // block. The position recomputes on every selection/content change, so as you type it follows
    // the last character along.
    const itemPos = $from.before(taskDepth);
    const item = $from.node(taskDepth);
    const wrap = ed.view.dom.closest(".editor-wrap") as HTMLElement | null;
    const rect = wrap?.getBoundingClientRect();
    const baseLeft = rect?.left ?? 0;
    const baseTop = rect?.top ?? 0;
    // End of the task item's first text block (its paragraph) = position just past the last char.
    const textEnd = itemPos + 1 + (item.firstChild?.nodeSize ?? 2) - 1;
    let left: number;
    let top: number;
    try {
      const coords = ed.view.coordsAtPos(textEnd);
      left = coords.left - baseLeft;
      top = coords.top - baseTop;
    } catch {
      // Fallback: trail the line's DOM right edge if the position can't be resolved.
      const li = ed.view.nodeDOM(itemPos) as HTMLElement | null;
      const box = li?.getBoundingClientRect?.();
      left = (box?.right ?? 0) - baseLeft;
      top = (box?.top ?? 0) - baseTop;
    }
    setTaskHint({ left, top });
  }, []);

  // Run a task-property action (the same handlers the slash commands use) from the + menu.
  const runTaskProp = useCallback((id: "due" | "repeat") => {
    setTaskMenuOpen(false);
    setPriorityOpen(false);
    const ed = editorRef.current;
    const cmd = COMMANDS.find((c) => c.id === id);
    if (cmd && ed) cmd.run(ed, ctxRef.current);
  }, []);

  // Set/clear the priority of the task under the caret from the + menu's Priority submenu.
  const runPriority = useCallback((level: string | null) => {
    setTaskMenuOpen(false);
    setPriorityOpen(false);
    const ed = editorRef.current;
    if (ed) setPriorityInEditor(ed, level);
  }, []);

  const filtered = slash
    ? COMMANDS.filter(
        (c) =>
          // Hide `/template` until the vault has templates and a host handler is wired.
          (c.id !== "template" || (templates.length > 0 && !!onInsertTemplate)) &&
          (!slash.query ||
            c.keywords.includes(slash.query.toLowerCase()) ||
            c.id.startsWith(slash.query.toLowerCase()))
      )
    : [];

  // Group the filtered commands for display while preserving each command's flat index in
  // `filtered` (which is what keyboard nav and `slashIndex` operate on).
  const groupedCommands: { group: SlashGroup; items: { cmd: SlashCommand; index: number }[] }[] =
    GROUP_ORDER.map((group) => ({
      group,
      items: filtered
        .map((cmd, index) => ({ cmd, index }))
        .filter((x) => x.cmd.group === group),
    })).filter((g) => g.items.length > 0);

  // Remove the typed `/query` and run the chosen command.
  const runCommand = useCallback(
    (cmd: SlashCommand) => {
      if (!editor) return;
      const { state } = editor;
      const { from } = state.selection;
      const len = (slash?.query.length ?? 0) + 1; // include the slash itself
      editor.chain().focus().deleteRange({ from: from - len, to: from }).run();
      cmd.run(editor, ctxRef.current);
      setSlash(null);
    },
    [editor, slash]
  );

  // Ranked page matches for the `[[` autocomplete. When the query doesn't exactly name an existing
  // page, offer a "Create new page" item as the last entry.
  const linkQuery = link?.query.trim() ?? "";
  const linkMatches = link ? rankPages(pages, linkQuery) : [];
  const hasExact = linkMatches.some((p) => p.name.toLowerCase() === linkQuery.toLowerCase());
  const linkItems: Array<{ name: string; create?: boolean }> = link
    ? [
        ...linkMatches.map((p) => ({ name: p.name })),
        ...(linkQuery && !hasExact ? [{ name: linkQuery, create: true }] : []),
      ]
    : [];

  // Replace the open `[[query` with a finished `[[Name]]` wikilink, creating the page first when
  // the chosen item is the "Create new page" option.
  const runLink = useCallback(
    async (item: { name: string; create?: boolean }) => {
      if (!editor) return;
      const { state } = editor;
      const { from } = state.selection;
      const start = from - ((link?.query.length ?? 0) + 2); // back up over `[[query`
      // Auto-close may have inserted a trailing `]]` right after the caret; swallow it too so we
      // don't end up with `[[name]]]]`.
      const after = state.doc.textBetween(from, Math.min(from + 2, state.doc.content.size));
      const end = from + (after === "]]" ? 2 : after.startsWith("]") ? 1 : 0);
      let name = item.name;
      if (item.create) {
        const created = await ctxRef.current.onCreatePage?.(name);
        name = (created as string) || name.replace(/\.md$/i, "").split("/").pop() || name;
      }
      editor
        .chain()
        .focus()
        .deleteRange({ from: start, to: end })
        // Insert the actual wikiLink node so it renders as a styled link immediately, rather than
        // raw `[[name]]` text that only converts on the next file reload.
        .insertContent({ type: "wikiLink", attrs: { name } })
        .run();
      setLink(null);
    },
    [editor, link]
  );

  // Ranked tag matches for the `#` autocomplete. When the query isn't already an exact tag, offer it
  // as a "new tag" so the user can coin one on the spot (tags are just text — no node type needed).
  const tagQuery = tag?.query.trim() ?? "";
  const tagMatches = tag
    ? tags
        .map((t) => ({ t, s: fuzzyScore(tagQuery, t) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 20)
        .map((x) => x.t)
    : [];
  const tagHasExact = tagMatches.some((t) => t.toLowerCase() === tagQuery.toLowerCase());
  const tagItems: Array<{ name: string; create?: boolean }> = tag
    ? [
        ...tagMatches.map((t) => ({ name: t })),
        ...(tagQuery && !tagHasExact ? [{ name: tagQuery, create: true }] : []),
      ]
    : [];

  // Replace the open `#query` with the chosen `#tag` as plain text (plus a trailing space so typing
  // continues naturally). Unlike wikilinks, tags aren't a node — they're matched from the body text.
  const runTag = useCallback(
    (item: { name: string }) => {
      if (!editor) return;
      const { state } = editor;
      const { from } = state.selection;
      const start = from - ((tag?.query.length ?? 0) + 1); // back up over `#query`
      editor
        .chain()
        .focus()
        .deleteRange({ from: start, to: from })
        .insertContent(`#${item.name} `)
        .run();
      setTag(null);
    },
    [editor, tag]
  );

  // Close the slash / link popups when clicking anywhere outside them. The menu items run on
  // `onMouseDown` and stop here via the `.slash-menu` ancestor check, so picking an item still works.
  useEffect(() => {
    if (!slash && !link && !tag) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest(".slash-menu")) return;
      setSlash(null);
      setLink(null);
      setTag(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [slash, link, tag]);

  // Keep the keyboard-highlighted slash item scrolled into view (groups add headers, so the active
  // row can fall outside the visible area).
  useEffect(() => {
    if (!slash) return;
    document
      .querySelector<HTMLElement>(`.slash-menu [data-slash-idx="${slashIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [slashIndex, slash]);

  // When the file changes externally (reloadKey), reset content.
  useEffect(() => {
    if (editor && value !== lastEmitted.current) {
      editor.commands.setContent(markdownToHtml(value), false);
      lastEmitted.current = value;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // Insert plain text at the caret when the template builder bumps `insertText.n`. Seed the
  // last-handled counter to the *current* n so a fresh mount (the Editor remounts on every page
  // switch — its key includes the active path) never replays the last signal; we only insert when
  // n genuinely advances past what this instance already applied. We focus first so the text lands
  // where the user last was, even if focus is on a chip button.
  const lastInsertN = useRef(insertText?.n ?? 0);
  useEffect(() => {
    const n = insertText?.n ?? 0;
    if (n <= lastInsertN.current) return;
    lastInsertN.current = n;
    editorRef.current?.chain().focus().insertContent(insertText!.text).run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertText?.n]);

  // Menu key handling at the ProseMirror level so it runs before the editor inserts a newline on
  // Enter. Returns true when a popup consumed the key (suppressing the default editor behaviour).
  const handlePopupKey = (e: KeyboardEvent): boolean => {
    // The `#` tag autocomplete takes priority when open.
    if (tag && tagItems.length) {
      if (e.key === "ArrowDown") {
        setTagIndex((i) => (i + 1) % tagItems.length);
      } else if (e.key === "ArrowUp") {
        setTagIndex((i) => (i - 1 + tagItems.length) % tagItems.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        runTag(tagItems[Math.min(tagIndex, tagItems.length - 1)]);
      } else if (e.key === "Escape") {
        setTag(null);
      } else {
        return false;
      }
      return true;
    }
    if (tag && e.key === "Escape") {
      setTag(null);
      return true;
    }

    // The `[[` autocomplete takes priority when open.
    if (link && linkItems.length) {
      if (e.key === "ArrowDown") {
        setLinkIndex((i) => (i + 1) % linkItems.length);
      } else if (e.key === "ArrowUp") {
        setLinkIndex((i) => (i - 1 + linkItems.length) % linkItems.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        runLink(linkItems[Math.min(linkIndex, linkItems.length - 1)]);
      } else if (e.key === "Escape") {
        setLink(null);
      } else {
        return false;
      }
      return true;
    }
    if (link && e.key === "Escape") {
      setLink(null);
      return true;
    }

    // Typing a space dismisses the slash menu (the query can't contain spaces) — but let the space
    // itself fall through so it's inserted into the text normally.
    if (slash && e.key === " ") {
      setSlash(null);
      return false;
    }

    if (slash && filtered.length) {
      if (e.key === "ArrowDown") {
        setSlashIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        setSlashIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter") {
        runCommand(filtered[Math.min(slashIndex, filtered.length - 1)]);
      } else if (e.key === "Escape") {
        setSlash(null);
      } else {
        return false;
      }
      return true;
    }
    if (slash && e.key === "Escape") {
      setSlash(null);
      return true;
    }
    return false;
  };
  handlePopupKeyRef.current = handlePopupKey;

  // Ctrl+R (Cmd+R on macOS) toggles the page-width ruler. Only when the ruler can actually do
  // something (a width-change handler is wired). We preventDefault so the webview doesn't reload.
  useEffect(() => {
    if (!onPageWidthChange) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        setRulerOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPageWidthChange]);

  // Build and open the right-click menu at the pointer. Items adapt to the selection: the text
  // toggles always show (with their on/off state); the sort actions appear only when the selection
  // spans more than one block (sorting a single line is meaningless). We never preventDefault on a
  // right-click over a link/image so their own affordances aren't shadowed.
  const onEditorContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const ed = editorRef.current;
      if (!ed) return;
      // Let the native menu through on media/links so "Save image", "Open link" etc. stay available.
      const target = e.target as HTMLElement;
      if (target.closest("img, a, .wikilink, .query-block")) return;
      e.preventDefault();

      // Right-click outside the current selection moves the caret there first, so toggles act where
      // the user clicked (matches every native editor).
      const posInfo = ed.view.posAtCoords({ left: e.clientX, top: e.clientY });
      const { from, to } = ed.state.selection;
      const clickedInside = posInfo && posInfo.pos >= from && posInfo.pos <= to;
      if (posInfo && !clickedInside) {
        ed.chain().focus().setTextSelection(posInfo.pos).run();
      } else {
        ed.view.focus();
      }

      // Enabled only when the selection spans ≥2 sibling lines at one level — exactly the scope
      // sortSelectedLines will reorder, so the affordance never promises more than it delivers.
      const canSort = !!selectedSiblings(ed.state);

      // Two task signals: `onTask` (caret in / selection on ≥1 task) gates the per-task actions;
      // `multiTasks` (≥2 task siblings) gates the done-sorts, which need more than one row to reorder.
      const onTask = selectionTouchesTask(ed.state);
      const multiTasks = selectionHasTasks(ed.state);

      // Top formatting cluster: compact B / I / S / code / link buttons (each shows its on-state).
      const formatRow: MenuFormatButton[] = [
        { label: "Bold", icon: <TextB size={16} weight="bold" />, active: ed.isActive("bold"), shortcut: "Ctrl+B",
          onClick: () => ed.chain().focus().toggleBold().run() },
        { label: "Italic", icon: <TextItalic size={16} />, active: ed.isActive("italic"), shortcut: "Ctrl+I",
          onClick: () => ed.chain().focus().toggleItalic().run() },
        { label: "Strikethrough", icon: <TextStrikethrough size={16} />, active: ed.isActive("strike"), shortcut: "Ctrl+Shift+S",
          onClick: () => ed.chain().focus().toggleStrike().run() },
        { label: "Inline code", icon: <Code size={16} />, active: ed.isActive("code"), shortcut: "Ctrl+E",
          onClick: () => ed.chain().focus().toggleCode().run() },
        { label: "Link", icon: <LinkSimpleHorizontal size={16} />, active: ed.isActive("link"),
          onClick: async () => {
            const prev = ed.getAttributes("link").href ?? "";
            const href = await dialogs.prompt({ title: "Link", placeholder: "https://…", defaultValue: prev });
            if (href === null) return;
            if (href === "") ed.chain().focus().unsetLink().run();
            else ed.chain().focus().setLink({ href }).run();
          } },
      ];

      // Sort — only shown when the selection spans ≥2 sibling lines (sorting one line is a no-op), so
      // the entry never appears disabled. The two done-sorts only make sense over multiple tasks.
      const items: MenuEntry[] = [];
      if (canSort) {
        const sortItem = (label: string, icon: React.ReactNode, mode: SortMode): MenuItem => ({
          label, icon, onClick: () => sortSelectedLines(ed, mode),
        });
        const sortSubmenu: MenuEntry[] = [
          sortItem("A → Z", <SortAscending size={16} />, "asc"),
          sortItem("Z → A", <SortDescending size={16} />, "desc"),
          sortItem("By date", <CalendarCheck size={16} />, "date"),
          sortItem("By length", <Minus size={16} />, "length"),
        ];
        if (multiTasks) {
          sortSubmenu.push(
            { label: "Priority — high first", icon: <Flag size={16} weight="fill" />, separator: true,
              onClick: () => sortSelectedLines(ed, "priority") },
            { label: "Priority — low first", icon: <Flag size={16} />,
              onClick: () => sortSelectedLines(ed, "priority-desc") },
            { label: "Done — to-do first", icon: <Circle size={16} />, separator: true,
              onClick: () => sortSelectedLines(ed, "done") },
            { label: "Done — done first", icon: <CheckCircle size={16} />,
              onClick: () => sortSelectedLines(ed, "done-desc") },
          );
        }
        items.push({ label: "Sort", icon: <SortAscending size={16} />, submenu: sortSubmenu });
      }

      // Tasks section — whenever the caret is in (or the selection touches) a task. Priority, Due
      // date, Recurrence, and Send to mutate the task line in place via the same markers the slash
      // commands write, so behavior matches `/due`, `/repeat`, and the + menu's priority picker.
      if (onTask) {
        const prio = (level: string | null, label: string): MenuItem => ({
          label, icon: <Flag size={15} weight={level ? "fill" : "regular"} />,
          className: level ? `prio-${level}` : undefined,
          onClick: () => setPriorityInEditor(ed, level),
        });
        const due = (label: string, offsetDays: number): MenuItem => ({
          label, icon: <CalendarBlank size={15} />,
          onClick: () => setMarkerInEditor(ed, "📅", isoFromOffset(offsetDays)),
        });
        // "Send to" MOVES the task into a daily note (unlike "Due date", which just stamps 📅).
        // We resolve the destination date, then hand the host the task's markdown line index — the
        // line is read off the live editor at click time so it survives any edits made meanwhile.
        const sendToDay = (date: Date) => {
          const line = taskLineIndexInMarkdown(ed);
          if (line == null) return;
          onSendTaskRef.current?.(line, { period: "daily", date });
        };
        const send = (label: string, offsetDays: number): MenuItem => ({
          label, icon: <CalendarBlank size={15} />,
          onClick: () => sendToDay(dayFromOffset(offsetDays)),
        });

        items.push(
          { section: "Tasks" },
          {
            label: "Priority", icon: <Flag size={16} />,
            submenu: [prio("high", "High"), prio("medium", "Medium"), prio("low", "Low"), prio(null, "None")],
          },
          {
            label: "Due date", icon: <CalendarPlus size={16} />,
            submenu: [
              due("Today", 0),
              due("Tomorrow", 1),
              due("In 2 days", 2),
              due("Next week", 7),
              { label: "Pick a date…", icon: <CalendarBlank size={15} />, separator: true,
                onClick: async () => { const iso = await requestDate(); if (iso) setMarkerInEditor(ed, "📅", iso); } },
              { label: "Clear due date", icon: <Minus size={15} />,
                onClick: () => setMarkerInEditor(ed, "📅", "") },
            ],
          },
          {
            label: "Recurrence", icon: <Repeat size={16} />,
            onClick: async () => {
              const rule = await dialogs.prompt({
                title: "Recurrence",
                message: "e.g. “every week”, “every 2 days”, or an RRULE like FREQ=WEEKLY",
                placeholder: "every week",
              });
              if (rule !== null) setMarkerInEditor(ed, "🔁", rule);
            },
          },
        );

        // "Send to" relocates the task into a daily note. Only offered when the host wired a mover.
        if (onSendTaskRef.current) {
          items.push({
            label: "Send to", icon: <ArrowBendUpRight size={16} />,
            submenu: [
              send("Today", 0),
              send("Tomorrow", 1),
              send("This weekend", isoOffsetToWeekend()),
              send("Next week", 7),
              send("In 2 weeks", 14),
              { label: "Pick a date…", icon: <CalendarBlank size={15} />, separator: true,
                onClick: async () => {
                  const iso = await requestDate();
                  if (!iso) return;
                  const [yy, mm, dd] = iso.split("-").map(Number);
                  sendToDay(new Date(yy, mm - 1, dd));
                } },
            ],
          });
        }
      }

      setCtxMenu({ x: e.clientX, y: e.clientY, items, formatRow });
    },
    [requestDate]
  );

  if (!editor) return null;

  return (
    <div className="editor-wrap" onContextMenu={onEditorContextMenu}>
      {showToolbar && <Toolbar editor={editor} />}
      {rulerOpen && onPageWidthChange && (
        <PageRuler width={pageWidth} onCommit={onPageWidthChange} />
      )}
      {headerSlot && <div className="editor-header-slot">{headerSlot}</div>}
      <EditorContent editor={editor} className="editor-content" />
      {slash && filtered.length > 0 && (
        <div className="slash-menu" style={{ left: slash.left, top: slash.top }}>
          {groupedCommands.map((g) => (
            <div key={g.group} className="slash-group">
              <div className="slash-group-label">{g.group}</div>
              {g.items.map(({ cmd, index }) => {
                const Ico = cmd.icon;
                return (
                  <button
                    key={cmd.id}
                    data-slash-idx={index}
                    className={`slash-item${index === slashIndex ? " active" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      runCommand(cmd);
                    }}
                    onMouseEnter={() => setSlashIndex(index)}
                  >
                    <span className="slash-icon">
                      <Ico size={17} weight="regular" />
                    </span>
                    <span className="slash-text">
                      <span className="slash-label">{cmd.label}</span>
                      <span className="slash-hint">{cmd.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {link && linkItems.length > 0 && (
        <div className="slash-menu" style={{ left: link.left, top: link.top }}>
          {linkItems.map((it, i) => (
            <button
              key={(it.create ? "+" : "") + it.name}
              className={`slash-item${i === linkIndex ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                runLink(it);
              }}
              onMouseEnter={() => setLinkIndex(i)}
            >
              <span className="slash-label">{it.create ? `Create “${it.name}”` : it.name}</span>
              <span className="slash-hint">{it.create ? "New page" : "Link to page"}</span>
            </button>
          ))}
        </div>
      )}
      {tag && tagItems.length > 0 && (
        <div className="slash-menu" style={{ left: tag.left, top: tag.top }}>
          {tagItems.map((it, i) => (
            <button
              key={(it.create ? "+" : "") + it.name}
              className={`slash-item${i === tagIndex ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                runTag(it);
              }}
              onMouseEnter={() => setTagIndex(i)}
            >
              <span className="slash-label">#{it.name}</span>
              <span className="slash-hint">{it.create ? "New tag" : "Tag"}</span>
            </button>
          ))}
        </div>
      )}
      {datePicker && (
        <DatePicker
          left={datePicker.left}
          top={datePicker.top}
          onPick={(iso) => closeDatePicker(iso)}
          onClose={() => closeDatePicker(null)}
        />
      )}
      {queryHelper && (
        <QueryHelper
          top={queryHelper.top}
          initialDsl={queryHelper.dsl}
          onInsert={commitQuery}
          onClose={() => setQueryHelper(null)}
        />
      )}
      {taskHint && !datePicker && (
        <div className="task-hint" style={{ left: taskHint.left, top: taskHint.top }}>
          <button
            className="task-hint-btn"
            title="Add task property"
            onMouseDown={(e) => {
              e.preventDefault();
              setTaskMenuOpen((o) => !o);
            }}
          >
            <Plus size={13} weight="bold" />
          </button>
          {taskMenuOpen && (
            <div className="task-hint-menu">
              <button
                className="slash-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  runTaskProp("due");
                }}
              >
                <span className="slash-icon"><CalendarPlus size={16} /></span>
                <span className="slash-text">
                  <span className="slash-label">Due date</span>
                  <span className="slash-hint">📅 Set a due date</span>
                </span>
              </button>
              <button
                className="slash-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  runTaskProp("repeat");
                }}
              >
                <span className="slash-icon"><Repeat size={16} /></span>
                <span className="slash-text">
                  <span className="slash-label">Recurrence</span>
                  <span className="slash-hint">🔁 Repeat this task</span>
                </span>
              </button>
              <button
                className={`slash-item${priorityOpen ? " expanded" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setPriorityOpen((o) => !o);
                }}
                aria-expanded={priorityOpen}
              >
                <span className="slash-icon"><Flag size={16} /></span>
                <span className="slash-text">
                  <span className="slash-label">Priority</span>
                  <span className="slash-hint">Flag importance</span>
                </span>
                <CaretRight size={13} className={`slash-caret${priorityOpen ? " open" : ""}`} />
              </button>
              {priorityOpen && (
                <div className="task-hint-submenu" role="group" aria-label="Set priority">
                  {[
                    { level: "high", label: "High", cls: "prio-high" },
                    { level: "medium", label: "Medium", cls: "prio-medium" },
                    { level: "low", label: "Low", cls: "prio-low" },
                    { level: null, label: "None", cls: "prio-none" },
                  ].map((p) => (
                    <button
                      key={p.label}
                      className={`slash-item slash-subitem ${p.cls}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        runPriority(p.level);
                      }}
                    >
                      <span className="slash-icon">
                        {p.level ? <Flag size={14} weight="fill" /> : <Flag size={14} />}
                      </span>
                      <span className="slash-text">
                        <span className="slash-label">{p.label}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          formatRow={ctxMenu.formatRow}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

function Toolbar({ editor }: { editor: any }) {
  const btn = (label: React.ReactNode, action: () => void, active?: boolean, title?: string) => (
    <button
      className={`tb-btn${active ? " active" : ""}`}
      onMouseDown={(e) => {
        e.preventDefault();
        action();
      }}
      title={title || (typeof label === "string" ? label : undefined)}
    >
      {label}
    </button>
  );
  return (
    <div className="toolbar">
      {btn("H1", () => editor.chain().focus().toggleHeading({ level: 1 }).run(), editor.isActive("heading", { level: 1 }))}
      {btn("H2", () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive("heading", { level: 2 }))}
      {btn("H3", () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive("heading", { level: 3 }))}
      <span className="tb-sep" />
      {btn("B", () => editor.chain().focus().toggleBold().run(), editor.isActive("bold"), "Bold")}
      {btn("i", () => editor.chain().focus().toggleItalic().run(), editor.isActive("italic"), "Italic")}
      {btn("S", () => editor.chain().focus().toggleStrike().run(), editor.isActive("strike"), "Strikethrough")}
      {btn("</>", () => editor.chain().focus().toggleCode().run(), editor.isActive("code"), "Inline code")}
      <span className="tb-sep" />
      {btn("•", () => editor.chain().focus().toggleBulletList().run(), editor.isActive("bulletList"), "Bullet list")}
      {btn("1.", () => editor.chain().focus().toggleOrderedList().run(), editor.isActive("orderedList"), "Numbered list")}
      {btn(<CheckSquare size={16} />, () => editor.chain().focus().toggleTaskList().run(), editor.isActive("taskList"), "Task list")}
      {btn(<Quotes size={16} />, () => editor.chain().focus().toggleBlockquote().run(), editor.isActive("blockquote"), "Quote")}
      {btn("{}", () => editor.chain().focus().toggleCodeBlock().run(), editor.isActive("codeBlock"), "Code block")}
      {btn("―", () => editor.chain().focus().setHorizontalRule().run(), false, "Divider")}
    </div>
  );
}

/**
 * The page-width ruler: a centered bar spanning the current page width with a drag handle at each
 * end. The column is centered (`margin: 0 auto`), so each handle moves symmetrically — the bar's
 * half-width equals the pointer's horizontal distance from the column's center, and the full page
 * width is twice that. Dragging either side therefore widens/narrows the page evenly.
 *
 * During a drag we only update the `--page-width` CSS variable and the label — directly, no React
 * state — so the page resizes smoothly without re-rendering. Persisting happens once on pointer-up
 * via `onCommit`. (Saving on every move opened a settings.json write per frame, which collided into
 * `AbortError: Failed to create swap file`.) The host clamps the committed value to its own range;
 * we mirror that clamp here so the live preview matches what finally lands.
 */
const RULER_MIN = 480;
const RULER_MAX = 1400;
function PageRuler({ width, onCommit }: { width: number; onCommit: (px: number) => void }) {
  const barRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const bar = barRef.current;
    const track = bar?.parentElement; // the .page-ruler, full editor-column width
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const root = document.documentElement;
    let latest = width;
    const move = (ev: PointerEvent) => {
      // Half-width = distance from center to the pointer; full width is twice that.
      const half = Math.abs(ev.clientX - centerX);
      latest = Math.round(Math.min(RULER_MAX, Math.max(RULER_MIN, half * 2)));
      // Live preview only: drive the CSS variable + label, no state and no disk write.
      root.style.setProperty("--page-width", `${latest}px`);
      if (labelRef.current) labelRef.current.textContent = `${latest}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onCommit(latest); // persist once, at the end of the drag
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="page-ruler" role="slider" aria-label="Page width" aria-valuenow={width}>
      <div className="page-ruler-bar" ref={barRef}>
        <span
          className="page-ruler-handle left"
          onPointerDown={startDrag}
          title="Drag to resize page width"
        />
        <span className="page-ruler-label" ref={labelRef}>{width}px</span>
        <span
          className="page-ruler-handle right"
          onPointerDown={startDrag}
          title="Drag to resize page width"
        />
      </div>
    </div>
  );
}
