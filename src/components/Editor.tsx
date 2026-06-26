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
  Folder,
  type Icon,
} from "@phosphor-icons/react";
import ContextMenu, { type MenuItem, type MenuEntry, type MenuFormatButton } from "./ContextMenu";
import DatePicker from "./DatePicker";
import QueryHelper from "./QueryHelper";
import { QueryBlock } from "./QueryBlock";
import { docToMarkdown, markdownToHtml } from "../markdown";
import { formatDate } from "../dateformat";
import { CURSOR_SENTINEL } from "../templates";
import { uiZoom } from "../lib/zoom";
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
  /**
   * Open a page by its vault-relative path (used by inline TASK query results). `line` is the task's
   * source line, letting the host scroll to and flash that row like the calendar agenda does.
   */
  onOpenPath?: (relPath: string, line?: number) => void;
  /**
   * Vault-relative path of the page being edited. Lets inline query blocks resolve the `{{current}}`
   * sentinel (the "Current page" path option) to this page at run time.
   */
  currentPath?: string | null;
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
  /**
   * When true, checking a to-do stamps a `done:: <timestamp>` field onto it (unchecking removes it).
   * Default true. Set false to leave checkboxes untouched.
   */
  stampDoneDate?: boolean;
  /**
   * Pattern (dateformat.ts tokens) for the completion timestamp written by the checkbox stamp. A
   * date-only pattern records just the day; include time tokens for date + time. Default
   * `YYYY-MM-DD HH:mm`.
   */
  doneDateFormat?: string;
  /** Optional cosmetic text before the completion timestamp (e.g. `✅`). Empty for just the time. */
  doneDatePrefix?: string;
  /**
   * Tint inline due-date markers (`📅`/`due::`) by urgency — overdue / today / soon. Default true.
   * Off leaves due dates in the normal text colour.
   */
  highlightDueDates?: boolean;
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

/**
 * An entry in the `[[` autocomplete menu. Exactly one of `folder`/`create` is set, or neither
 * (an existing page to link). `path` is the full slash-path the entry stands for: a page's
 * `rel_path` (without `.md`), a folder prefix ending in `/`, or the to-be-created page path.
 */
export interface LinkItem {
  /** Display label (leaf name for pages/folders, full path for a create). */
  name: string;
  /** Full slash-path this entry represents. */
  path: string;
  /** This is a folder — picking it drills in (rewrites the query) rather than inserting a link. */
  folder?: boolean;
  /** No page matches this path yet — picking it creates one at `path`, then links it. */
  create?: boolean;
}

/**
 * Build the `[[` autocomplete entries for `query`, made folder-aware. The text before the last
 * `/` is a folder *prefix* to scope into; the text after it is the leaf filter. So `Notes/` lists
 * the subfolders and pages directly under `Notes/`, `Notes/ID` filters those to ones matching
 * `ID`, and a bare `Idea` searches every page fuzzily (legacy behaviour). Subfolders are listed
 * first so the user can keep drilling; a "create" entry is appended whenever the leaf names no
 * existing page in that scope.
 */
export function buildLinkItems(pages: PageRef[], rawQuery: string): LinkItem[] {
  const query = rawQuery.trim();
  const slash = query.lastIndexOf("/");

  // No `/` typed yet: legacy flat fuzzy search across all page names, but still surface the
  // top-level folders so the user can discover that they can drill in.
  if (slash === -1) {
    const leaf = query.toLowerCase();
    const folders = new Set<string>();
    for (const p of pages) {
      const seg = p.rel_path.indexOf("/");
      if (seg === -1) continue;
      const top = p.rel_path.slice(0, seg);
      if (!leaf || top.toLowerCase().includes(leaf)) folders.add(top);
    }
    const folderItems: LinkItem[] = [...folders]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 8)
      .map((f) => ({ name: f, path: `${f}/`, folder: true }));
    const pageItems: LinkItem[] = rankPages(pages, query).map((p) => ({
      name: p.name,
      path: p.rel_path.replace(/\.md$/i, ""),
    }));
    const hasExact = pageItems.some((p) => p.name.toLowerCase() === leaf);
    return [
      ...folderItems,
      ...pageItems,
      ...(query && !hasExact ? [{ name: query, path: query, create: true }] : []),
    ];
  }

  // Scoped: `prefix/leaf`. List direct children of `prefix/` whose own leaf matches `leaf`.
  const prefix = query.slice(0, slash); // e.g. "Notes/Sub"
  const leaf = query.slice(slash + 1).toLowerCase(); // e.g. "id"
  const dir = prefix.replace(/\/+$/, "") + "/"; // normalised "Notes/Sub/"
  const dirLc = dir.toLowerCase();
  const folders = new Set<string>();
  const pageItems: LinkItem[] = [];
  for (const p of pages) {
    if (!p.rel_path.toLowerCase().startsWith(dirLc)) continue;
    const rest = p.rel_path.slice(dir.length); // path below the prefix
    const cut = rest.indexOf("/");
    if (cut === -1) {
      // A page directly in this folder.
      const base = rest.replace(/\.md$/i, "");
      if (!leaf || base.toLowerCase().includes(leaf)) {
        pageItems.push({ name: base, path: dir + base });
      }
    } else {
      // A subfolder of this folder.
      const sub = rest.slice(0, cut);
      if (!leaf || sub.toLowerCase().includes(leaf)) folders.add(sub);
    }
  }
  const folderItems: LinkItem[] = [...folders]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 8)
    .map((f) => ({ name: f, path: dir + f + "/", folder: true }));
  pageItems.sort((a, b) => a.name.localeCompare(b.name));
  const hasExact = pageItems.some((p) => p.name.toLowerCase() === leaf);
  return [
    ...folderItems,
    ...pageItems.slice(0, 20),
    // Offer to create `prefix/leaf` when a leaf is typed and names no existing page here.
    ...(leaf && !hasExact ? [{ name: dir + query.slice(slash + 1), path: dir + query.slice(slash + 1), create: true }] : []),
  ];
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

type DragLine = {
  pos: number; nodeSize: number; depth: number; parentPos: number;
  index: number; typeName: string; dom: HTMLElement;
};

/**
 * Every draggable "line" in the document, in visual (top-to-bottom) order: each top-level block,
 * plus each list item, recursing through nested sub-lists. For each we keep its document position,
 * size, nesting depth (0 = top level), index among its siblings, type name, and DOM element —
 * everything the drag needs to find a drop gap and re-nest a moved line anywhere in the document.
 */
function collectLines(view: any): DragLine[] {
  const { doc } = view.state;
  const lines: DragLine[] = [];
  const walk = (node: any, pos: number, depth: number, parentPos: number, index: number) => {
    const name = node.type.name;
    if (LIST_NAMES.has(name)) {
      // A list is a container, not a line of its own — recurse into its items at the same depth.
      let at = pos + 1;
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i), at, depth, pos, i);
        at += node.child(i).nodeSize;
      }
      return;
    }
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    if (dom && dom.nodeType === 1)
      lines.push({ pos, nodeSize: node.nodeSize, depth, parentPos, index, typeName: name, dom });
    // Descend into any sub-lists nested inside this item, one level deeper.
    if (name === "listItem" || name === "taskItem") {
      let at = pos + 1;
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (LIST_NAMES.has(child.type.name)) walk(child, at, depth + 1, parentPos, index);
        at += child.nodeSize;
      }
    }
  };
  let at = 0;
  for (let i = 0; i < doc.childCount; i++) {
    walk(doc.child(i), at, 0, -1, i);
    at += doc.child(i).nodeSize;
  }
  return lines;
}

// Re-type a list item to the other kind (listItem⇄taskItem) while keeping its content, so a row can
// move between a bullet/numbered list and a task list. Task items gain an unchecked `checked` attr.
function retypeItem(item: any, newType: any): any {
  return newType.create(newType.name === "taskItem" ? { checked: false } : null, item.content);
}

/**
 * Notion-style free move: relocate the line at `srcPos` to sit just before (or `after`) the line at
 * `refPos`, adopting that target's container and nesting level. Re-wraps as the schema requires —
 * a bare paragraph wraps into a list item when dropped into a list; an item's contents lift out when
 * dropped at top level; a bullet item re-types to a task item across list kinds. `deleteRange` clears
 * any list/item left empty by the move. One transaction (single undo). Returns false on a no-op or
 * any move the schema can't represent (validated before dispatch), so the document never corrupts.
 */
function moveLineToTarget(view: any, srcPos: number, refPos: number, after: boolean): boolean {
  const { state } = view;
  const schema = state.schema;
  const srcNode = state.doc.nodeAt(srcPos);
  if (!srcNode) return false;
  // Never drop a line into itself or its own subtree.
  if (refPos >= srcPos && refPos < srcPos + srcNode.nodeSize) return false;

  // Resolve the target's parent container + the index to insert at among its children.
  const $ref = state.doc.resolve(refPos + 1);
  const tDepth = $ref.depth;
  let parent = $ref.node(tDepth - 1);
  let parentStart = tDepth - 1 === 0 ? 0 : $ref.start(tDepth - 1);
  let targetIndex = $ref.index(tDepth - 1) + (after ? 1 : 0);

  const srcIsItem = srcNode.type.name === "listItem" || srcNode.type.name === "taskItem";
  let toInsert: any[] | null = null;

  if (LIST_NAMES.has(parent.type.name)) {
    // Destination is a list → it must hold items of the matching kind.
    const itemTypeName = parent.type.name === "taskList" ? "taskItem" : "listItem";
    const itemType = schema.nodes[itemTypeName];
    if (srcIsItem) {
      toInsert = srcNode.type.name === itemTypeName ? [srcNode] : [retypeItem(srcNode, itemType)];
    } else if (srcNode.type.name === "paragraph") {
      toInsert = [itemType.create(itemTypeName === "taskItem" ? { checked: false } : null, srcNode)];
    } else {
      // A heading/quote/etc. can't lead a list item — drop it beside the WHOLE list instead, at the
      // list's own parent level (the nearest position where the block is valid).
      const listPos = $ref.before(tDepth - 1);
      const $list = state.doc.resolve(listPos);
      parent = $list.parent;
      parentStart = $list.depth === 0 ? 0 : $list.start();
      targetIndex = $list.index() + (after ? 1 : 0);
      toInsert = [srcNode];
    }
  } else if (srcIsItem) {
    // Destination takes blocks (the doc, or a list item's content) → lift the item's blocks out.
    const blocks: any[] = [];
    srcNode.forEach((c: any) => blocks.push(c));
    toInsert = blocks;
  } else {
    toInsert = [srcNode];
  }
  if (!toInsert || !toInsert.length) return false;

  // Flat insertion offset among the parent's children, measured on the CURRENT doc.
  let insertAt = parentStart;
  for (let i = 0; i < targetIndex; i++) insertAt += parent.child(i).nodeSize;

  // No-op: dropping back into the slot the source already occupies.
  const $src = state.doc.resolve(srcPos + 1);
  const srcParentStart = $src.depth - 1 === 0 ? 0 : $src.start($src.depth - 1);
  if (parentStart === srcParentStart) {
    const srcIndex = $src.index($src.depth - 1);
    if (targetIndex === srcIndex || targetIndex === srcIndex + 1) return false;
  }

  const tr = state.tr;
  tr.deleteRange(srcPos, srcPos + srcNode.nodeSize); // also removes any now-empty list/item wrapper
  const mappedInsert = tr.mapping.map(insertAt, -1);
  tr.insert(mappedInsert, Fragment.fromArray(toInsert));

  // Guard against any schema-invalid result rather than corrupting the document.
  try { tr.doc.check(); } catch { return false; }

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
          let dropTarget: { refPos: number; after: boolean } | null = null; // where the line will land

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
            // `getBoundingClientRect` reports OUTER (zoomed) pixels, but inline `left`/`top` are
            // applied in the handle's own LOCAL (unzoomed) space — so the rect-delta must be divided
            // by the whole-UI zoom factor or the grip drifts further off the more you zoom. The `gap`
            // is already a local-space constant, so it's subtracted after the conversion. No-op at 100%.
            const z = uiZoom();
            handle.style.left = `${(box.left - originBox.left) / z - gap}px`;
            handle.style.top = `${(box.top - originBox.top) / z + 1}px`;
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
          // Hide only when the pointer truly leaves the editor column — NOT when it crosses from the
          // text into the left gutter on its way to the grip. (The old check used `view.dom`, so the
          // handle vanished the instant you left the text box, making it nearly impossible to grab.)
          const onLeave = (e: MouseEvent) => {
            if (dragging) return;
            const to = e.relatedTarget as Node | null;
            if (to && wrap.contains(to)) return;
            handle.style.display = "none";
            hoverPos = null;
          };

          // `mousemove` stays on `view.dom` (the editable surface) — the binding that reliably fires
          // and reveals the grip; `mouseleave` watches the whole column so the grip survives the trip
          // across the gutter.
          view.dom.addEventListener("mousemove", onMove);
          wrap.addEventListener("mouseleave", onLeave);

          // From a pointer Y, find the drop gap among ALL lines in the document (any list, any level).
          // The dropped line will land beside the gap's reference line and adopt its nesting, so the
          // indicator is inset to that line's left edge — you see both WHERE and at WHAT LEVEL it
          // lands. Returns the reference line's position + which side, or null when over the dragged
          // line itself (a no-op target).
          const computeDrop = (
            clientY: number
          ): { refPos: number; after: boolean; y: number; left: number; right: number } | null => {
            if (hoverPos == null) return null;
            const lines = collectLines(view);
            if (!lines.length) return null;
            // Same origin the indicator is positioned against (its offsetParent), see `place`.
            const wrapBox = (indicator.offsetParent ?? wrap).getBoundingClientRect();
            let gap = lines.length; // default: below the last line
            for (let i = 0; i < lines.length; i++) {
              const b = lines[i].dom.getBoundingClientRect();
              if (clientY < b.top + b.height / 2) { gap = i; break; }
            }
            const after = gap >= lines.length;
            const ref = after ? lines[lines.length - 1] : lines[gap];
            // Skip drops onto the dragged line or anything inside it — there's no valid landing there.
            const srcNode = view.state.doc.nodeAt(hoverPos);
            if (srcNode && ref.pos >= hoverPos && ref.pos < hoverPos + srcNode.nodeSize) return null;
            const rb = ref.dom.getBoundingClientRect();
            return {
              refPos: ref.pos,
              after,
              y: (after ? rb.bottom : rb.top) - wrapBox.top,
              left: rb.left - wrapBox.left,
              right: wrapBox.right - rb.right,
            };
          };

          // ── Dragging via Pointer Events (not native HTML5 DnD) ─────────────────────────────────
          // Native drag made the tiny grip finicky to grab and gave no feedback about WHAT was
          // moving or WHERE it would land. Pointer capture lets us own the whole gesture: press the
          // grip, move, release — the events keep flowing to the handle even when the pointer roams
          // far from it. A small movement threshold separates a real drag from a plain click.
          let pointerId: number | null = null;
          let startX = 0, startY = 0;
          let pendingPos: number | null = null; // line captured on pointerdown; promoted on first move
          let sourceDom: HTMLElement | null = null; // dragged row, dimmed so it reads as "in flight"

          // Auto-scroll when the pointer nears the top/bottom edge of the scroll container, so a long
          // document can be reordered without ever releasing the grip.
          const scroller = (() => {
            let el: HTMLElement | null = wrap;
            while (el) {
              const oy = getComputedStyle(el).overflowY;
              if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
              el = el.parentElement;
            }
            return null;
          })();
          let scrollVel = 0;
          let rafScroll = 0;
          const stepScroll = () => {
            rafScroll = 0;
            if (!dragging || !scroller || scrollVel === 0) return;
            scroller.scrollTop += scrollVel;
            rafScroll = requestAnimationFrame(stepScroll);
          };

          const showDropAt = (clientY: number) => {
            const drop = computeDrop(clientY);
            if (!drop) { indicator.style.display = "none"; dropTarget = null; return; }
            dropTarget = { refPos: drop.refPos, after: drop.after };
            // `drop.{y,left,right}` are rect-deltas in OUTER (zoomed) pixels; the indicator's inline
            // offsets are LOCAL (unzoomed) — divide by the zoom factor so the drop line tracks the
            // gap exactly at any zoom (no-op at 100%).
            const z = uiZoom();
            indicator.style.top = `${drop.y / z - 1.5}px`;
            indicator.style.left = `${drop.left / z}px`;
            indicator.style.right = `${drop.right / z}px`;
            indicator.style.display = "block";
          };

          const finishDrag = () => {
            dragging = false;
            dropTarget = null;
            scrollVel = 0;
            if (rafScroll) { cancelAnimationFrame(rafScroll); rafScroll = 0; }
            handle.classList.remove("dragging");
            indicator.style.display = "none";
            sourceDom?.classList.remove("block-drag-source");
            sourceDom = null;
          };

          const onPointerDown = (e: PointerEvent) => {
            if (e.button !== 0 || hoverPos == null) return;
            e.preventDefault();
            pointerId = e.pointerId;
            pendingPos = hoverPos;
            startX = e.clientX; startY = e.clientY;
            handle.setPointerCapture(e.pointerId);
          };

          const onPointerMove = (e: PointerEvent) => {
            if (pendingPos == null) return;
            if (!dragging) {
              // Promote to a drag only after the pointer clears a small threshold, so a slightly
              // shaky click still selects the block instead of "moving" it nowhere.
              if (Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
              dragging = true;
              hoverPos = pendingPos;
              handle.classList.add("dragging");
              sourceDom = view.nodeDOM(hoverPos) as HTMLElement | null;
              sourceDom?.classList.add("block-drag-source");
            }
            e.preventDefault();
            showDropAt(e.clientY);
            if (scroller) {
              const box = scroller.getBoundingClientRect();
              const EDGE = 48;
              if (e.clientY < box.top + EDGE) scrollVel = -Math.ceil((box.top + EDGE - e.clientY) / 6);
              else if (e.clientY > box.bottom - EDGE) scrollVel = Math.ceil((e.clientY - (box.bottom - EDGE)) / 6);
              else scrollVel = 0;
              if (scrollVel !== 0 && !rafScroll) rafScroll = requestAnimationFrame(stepScroll);
            }
          };

          const onPointerUp = () => {
            if (pendingPos == null) return;
            if (pointerId != null) { try { handle.releasePointerCapture(pointerId); } catch {} }
            if (dragging) {
              if (hoverPos != null && dropTarget != null)
                moveLineToTarget(view, hoverPos, dropTarget.refPos, dropTarget.after);
              finishDrag();
              handle.style.display = "none";
              hoverPos = null;
            } else {
              // No real movement → treat as a click: select the whole block (handy before
              // formatting/deleting it).
              const pos = pendingPos;
              const node = view.state.doc.nodeAt(pos);
              if (node) {
                view.dispatch(
                  view.state.tr.setSelection(
                    TextSelection.create(view.state.doc, pos + 1, pos + node.nodeSize - 1)
                  )
                );
                view.focus();
              }
            }
            pendingPos = null;
            pointerId = null;
          };

          handle.addEventListener("pointerdown", onPointerDown);
          handle.addEventListener("pointermove", onPointerMove);
          handle.addEventListener("pointerup", onPointerUp);
          // If capture is yanked away (e.g. the browser cancels the gesture), clean up gracefully.
          handle.addEventListener("lostpointercapture", () => {
            if (dragging) finishDrag();
            pendingPos = null;
            pointerId = null;
          });

          return {
            destroy() {
              view.dom.removeEventListener("mousemove", onMove);
              wrap.removeEventListener("mouseleave", onLeave);
              if (rafScroll) cancelAnimationFrame(rafScroll);
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
          // The trigger is the last `hit.back` chars of `match[0]`, which spans the doc range
          // [range.from, range.to] PLUS the just-typed (not-yet-inserted) char at its end. So the
          // trigger's start in the doc is `range.from + (match[0].length - hit.back)`, and we replace
          // up to range.to (the typed char is consumed by the rule). Computing the start from range.to
          // instead would over-count by the un-inserted char's width and eat the preceding character.
          const start = range.from + (tail.length - hit.back);
          state.tr.insertText(hit.output, start, range.to);
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

/**
 * Stamp a `done:: <date> <time>` field onto a to-do the moment its checkbox is ticked, and strip it
 * again when unticked — so every completed task records WHEN it was finished. The field is plain text
 * (the dataview-style `done::`, same family as `due::`/`priority::`), so it round-trips through the
 * markdown source untouched and is rendered as a pretty pill by `DonePill`.
 *
 * Implemented as an `appendTransaction` plugin rather than overriding the checkbox command, so it
 * covers EVERY way a box flips — the click handler, keyboard toggle, paste, undo/redo — uniformly.
 * We diff task items by document order: only a checkbox tick changes a `taskItem`'s `checked` attr
 * without adding/removing items, so the Nth item before and after a toggle is the same task, and we
 * rewrite just the ones whose `checked` actually changed. Editing the `done::` text doesn't touch
 * `checked`, so the appended transaction never re-triggers this (no loop).
 *
 * `getStamp()` returns the formatted "now" string (date + time) from the user's live format
 * settings; a getter so Settings edits apply without re-creating the editor.
 */
const completionStampKey = new PluginKey("completionStamp");
// The `done:: <value>` field for detect/replace/remove. The value (a date+time, never containing
// `::`) runs to the next field — an emoji marker OR another `word::` keyword — or end-of-text, so
// removing the stamp on uncheck never swallows an adjacent `priority::`/`due::` on the same line,
// whatever the field order. `\s*` on the front also eats the separating space so no double-space is
// left behind. Mirrors the bound used by the DonePill decoration.
const DONE_FIELD_RE = /\s*\bdone::\s*(?:(?!\s+\w+::)[^📅🔁⏳✅])*/i;

interface CompletionStampOptions {
  /** Formatted completion timestamp ("now"), e.g. "2026-06-23 14:30". Empty string disables stamping. */
  getStamp: () => string;
}

/** Every taskItem's checked state in document order, with its paragraph's bounds + text. */
function taskItemsInOrder(
  doc: any
): { checked: boolean; paraFrom: number; paraTo: number; text: string }[] {
  const out: { checked: boolean; paraFrom: number; paraTo: number; text: string }[] = [];
  doc.descendants((node: any, pos: number) => {
    if (node.type.name !== "taskItem") return true;
    const para = node.firstChild;
    const paraFrom = pos + 2; // +1 into taskItem, +1 into its first child (the paragraph)
    const size = para?.content.size ?? 0;
    out.push({
      checked: !!node.attrs?.checked,
      paraFrom,
      paraTo: paraFrom + size,
      text: para?.textContent ?? "",
    });
    return true; // keep descending so nested task items are counted too, in their own order
  });
  return out;
}

const CompletionStamp = Extension.create<CompletionStampOptions>({
  name: "completionStamp",
  addOptions() {
    return { getStamp: () => "" };
  },
  addProseMirrorPlugins() {
    const getStamp = this.options.getStamp;
    return [
      new Plugin({
        key: completionStampKey,
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((t) => t.docChanged)) return null;
          const before = taskItemsInOrder(oldState.doc);
          const after = taskItemsInOrder(newState.doc);
          // A pure checkbox toggle keeps the item count stable; if items were added/removed (typing,
          // paste, etc.) the ordinals no longer line up — skip rather than risk stamping a wrong line.
          if (before.length !== after.length) return null;

          const tr = newState.tr;
          let touched = false;
          for (let i = 0; i < after.length; i++) {
            if (before[i].checked === after[i].checked) continue;
            const { paraFrom, paraTo, text } = after[i];
            if (after[i].checked) {
              // Just checked: append a fresh stamp, unless one is somehow already there.
              const stamp = getStamp();
              if (!stamp || DONE_FIELD_RE.test(text)) continue;
              const lead = text.length === 0 || text.endsWith(" ") ? "" : " ";
              tr.insertText(`${lead}done:: ${stamp}`, tr.mapping.map(paraTo));
            } else {
              // Just unchecked: remove the stamp field if there is one.
              const m = DONE_FIELD_RE.exec(text);
              if (!m) continue;
              const from = paraFrom + m.index;
              tr.delete(tr.mapping.map(from), tr.mapping.map(from + m[0].length));
            }
            touched = true;
          }
          return touched ? tr : null;
        },
      }),
    ];
  },
});

// Render the inline `done:: <date time>` field as a green "completed" pill — same decoration-overlay
// approach as PriorityPill, so the document text stays literal `done:: …` (the source of truth is
// untouched). The `done:: ` keyword is visually collapsed; the timestamp becomes the pill, with a
// check glyph added via CSS `::before`.
const donePillKey = new PluginKey("donePill");
// Capture the keyword (incl. trailing space) and the value separately. The value runs to the next
// known field keyword or end-of-text, so a trailing `priority:: …` on the same line isn't eaten.
const DONE_DECO_RE =
  /(done::\s*)([^📅🔁⏳✅\n]+?)(?=\s+(?:priority::|due::|repeat::)|\s*$)/gi;
const DonePill = Extension.create({
  name: "donePill",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: donePillKey,
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              if (node.marks.some((m) => m.type.name === "code")) return;
              const text = node.text;
              DONE_DECO_RE.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = DONE_DECO_RE.exec(text))) {
                const kwStart = pos + m.index;
                const kwEnd = kwStart + m[1].length; // end of "done:: "
                const valEnd = kwEnd + m[2].length; // end of the timestamp value
                decos.push(Decoration.inline(kwStart, kwEnd, { class: "done-kw" }));
                decos.push(Decoration.inline(kwEnd, valEnd, { class: "done-pill" }));
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

/**
 * Tint a task's inline due-date marker by urgency — overdue / due-today / due-soon — without touching
 * the document model (decoration overlay, like the other task pills). Matches `📅 YYYY-MM-DD` and
 * `due:: YYYY-MM-DD`, parses the date as a LOCAL calendar day, and adds a `due-*` class the CSS colours
 * from the urgency tokens. Only past / today / next-two-days get a class; further-out dates stay plain.
 *
 * `getEnabled()` is read live (a getter) so the Settings toggle applies without re-creating the editor.
 * `today0()` recomputes local-midnight on every decoration pass, so an open editor rolls over at
 * midnight without a reload.
 */
const dueHighlightKey = new PluginKey("dueHighlight");
// `📅`/`due::` then a YYYY-MM-DD. Two capture groups: the leading marker (kept plain) and the date
// (pilled). Mirrors the markers the indexer recognises; only an ISO date is tinted (the unambiguous case).
const DUE_DECO_RE = /(📅\s*|due::\s*)(\d{4}-\d{2}-\d{2})/gi;

interface DueHighlightOptions {
  /** Whether due-date tinting is on. Read live so the Settings toggle needs no editor re-create. */
  getEnabled: () => boolean;
}

/** Local-midnight timestamp for today (recomputed per pass so an open doc rolls over at midnight). */
function today0(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local-midnight timestamp for a `YYYY-MM-DD` string, or null if it isn't a real date. */
function isoDay0(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  return Number.isNaN(t) ? null : t;
}

const DueHighlight = Extension.create<DueHighlightOptions>({
  name: "dueHighlight",
  addOptions() {
    return { getEnabled: () => true };
  },
  addProseMirrorPlugins() {
    const getEnabled = this.options.getEnabled;
    return [
      new Plugin({
        key: dueHighlightKey,
        props: {
          decorations(state) {
            if (!getEnabled()) return DecorationSet.empty;
            const decos: Decoration[] = [];
            const base = today0();
            const DAY = 86400000;
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              if (node.marks.some((m) => m.type.name === "code")) return;
              const text = node.text;
              DUE_DECO_RE.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = DUE_DECO_RE.exec(text))) {
                const day = isoDay0(m[2]);
                if (day == null) continue;
                const diff = Math.round((day - base) / DAY);
                const urgency =
                  diff < 0 ? "overdue" : diff === 0 ? "today" : diff <= 2 ? "soon" : null;
                if (!urgency) continue;
                // Tint the date token (after the marker); the marker glyph itself stays plain.
                const dateStart = pos + m.index + m[1].length;
                const dateEnd = dateStart + m[2].length;
                decos.push(Decoration.inline(dateStart, dateEnd, { class: `due-pill due-${urgency}` }));
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

  // Read each marker's current value and the text span it occupies. Marker text (`priority:: …`, the
  // 📅/🔁 emoji + value) is always plain paragraph text — never inside a node like a wikilink — so its
  // character offsets map straight to document positions (start + offset). We delete just those spans
  // and re-append the canonical tail, which keeps the body's formatted nodes intact AND preserves any
  // non-marker trailing text such as a `[[ref]]`. (Replacing everything from the first marker to EOL —
  // the old behavior — would swallow a trailing ref that sits after a 📅/🔁 marker.)
  const values: Record<MarkerKind, string | null> = { priority: null, due: null, repeat: null };
  const spans: { from: number; to: number }[] = [];
  for (const m of MARKERS) {
    const hit = m.re.exec(text);
    if (hit) {
      values[m.kind] = hit[1].trim();
      // Eat one leading space so removal doesn't leave a double gap behind.
      const from = hit.index > 0 && text[hit.index - 1] === " " ? hit.index - 1 : hit.index;
      spans.push({ from: start + from, to: start + hit.index + hit[0].length });
    }
  }
  values[kind] = value && value.trim() ? value.trim() : null;

  // Re-emit present markers in canonical order: priority → due → recurrence.
  const tail = MARKERS
    .filter((m) => values[m.kind])
    .map((m) => m.render(values[m.kind] as string))
    .join(" ");

  // Apply everything in one transaction, highest position first so the earlier (lower) positions we
  // computed against the original doc stay valid: first append the tail at end-of-paragraph, then
  // delete each existing marker span right-to-left. This leaves the body — and any trailing ref —
  // exactly as it was, only swapping the marker text.
  const { state } = editor;
  const tr = state.tr;
  // Does any text/content remain once the marker spans are removed? If not, the tail (if any) becomes
  // the whole body and shouldn't get a leading space.
  const removed = spans.reduce((n, s) => n + (s.to - s.from), 0);
  const hasBody = end - start - removed > 0;
  if (tail) tr.insertText(hasBody ? ` ${tail}` : tail, end);
  for (const s of [...spans].sort((a, b) => b.from - a.from)) {
    tr.delete(s.from, s.to);
  }
  editor.view.dispatch(tr);
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
  currentPath,
  onOpenTag,
  onAddAttachment,
  onAttachmentRemoved,
  onTaskToggled,
  onSendTask,
  dateFormat = "YYYY-MM-DD",
  timeFormat = "HH:mm",
  taskDateFormat = "YYYY-MM-DD",
  stampDoneDate = true,
  doneDateFormat = "YYYY-MM-DD HH:mm",
  doneDatePrefix = "",
  highlightDueDates = true,
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
  // Current page path in a ref so the once-configured QueryBlock reads it fresh on every run.
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
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
  // Builds the `done:: …` completion stamp VALUE on demand (an optional prefix + the formatted
  // timestamp), or "" to disable stamping entirely (CompletionStamp treats an empty value as "skip").
  // A ref so the extension (configured once) always reads the current settings without an editor
  // re-create. The prefix is cosmetic and rides inside the value, so DonePill pills it too.
  const doneStampRef = useRef<() => string>(() => "");
  doneStampRef.current = () => {
    if (!stampDoneDate) return "";
    const stamp = formatDate(new Date(), doneDateFormat).trim();
    // Strip the reserved field markers (📅🔁⏳✅) from the prefix: they delimit OTHER inline fields, so
    // letting one into the value would break the done:: field's own bounds (and ✅ already shows as the
    // pill's own check glyph). Everything else — "Done", 🎉, etc. — is kept.
    const prefix = (doneDatePrefix ?? "").replace(/[📅🔁⏳✅]/g, "").trim();
    return prefix ? `${prefix} ${stamp}` : stamp;
  };
  // Live on/off for due-date tinting, read by the DueHighlight plugin (configured once) per pass.
  const highlightDueRef = useRef(highlightDueDates);
  highlightDueRef.current = highlightDueDates;
  const lastEmitted = useRef<string>(value);
  // Coalesces the per-keystroke markdown serialization (`docToMarkdown` walks the whole doc) out of
  // the typing hot path. Detection (slash/tag/link menus) still runs synchronously in `onUpdate` so
  // menus stay instant; only the expensive serialize + upward `onChange` is debounced. The save in
  // App is itself debounced 600ms, so deferring this ~150ms costs nothing and the flush-on-unmount
  // below guarantees no edit is lost on a fast page switch.
  const serializeTimer = useRef<number | null>(null);
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
    // OUTER-px rect-delta → LOCAL space for the popup's inline left/top; see css-zoom-coordinates.
    const z = uiZoom();
    return { left: (coords.left - (rect?.left ?? 0)) / z, top: (coords.bottom - (rect?.top ?? 0)) / z + 4 };
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
      // OUTER-px delta → LOCAL space for the right-docked popup's inline top; see css-zoom-coordinates.
      return (coords.top - (rect?.top ?? 0)) / uiZoom();
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
        CompletionStamp.configure({ getStamp: () => doneStampRef.current() }),
        TagPill.configure({ onOpenTag: (tag) => onOpenTagRef.current?.(tag) }),
        PriorityPill,
        DonePill,
        DueHighlight.configure({ getEnabled: () => highlightDueRef.current }),
        ImageNode,
        WikiLink.configure({ onOpen: (name) => onOpenPageRef.current?.(name) }),
        QueryBlock.configure({
          onEdit: (getPos, dsl) => editQueryRef.current(getPos, dsl),
          onOpenPath: (relPath, line) => onOpenPathRef.current?.(relPath, line),
          onTaskToggled: (relPath) => onTaskToggledRef.current?.(relPath),
          getCurrentPath: () => currentPathRef.current ?? null,
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
        // Run the cheap, latency-sensitive detection synchronously so the slash/link/tag/task
        // menus react on the same frame as the keystroke.
        detectSlash(editor);
        detectLink(editor);
        detectTag(editor);
        detectTaskHint(editor);
        // Defer the expensive full-document markdown serialization + upward propagation. Rapid
        // typing collapses to a single serialize once the user pauses (~150ms).
        if (serializeTimer.current) window.clearTimeout(serializeTimer.current);
        serializeTimer.current = window.setTimeout(() => {
          serializeTimer.current = null;
          const md = docToMarkdown(editor.getJSON() as any);
          lastEmitted.current = md;
          onChange(md);
        }, 150);
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
    // coordsAtPos/getBoundingClientRect are OUTER (zoomed) px; the menu's inline left/top are read in
    // its own LOCAL (unzoomed) space, so divide the rect-delta by uiZoom() (the +4 gap is a local
    // constant, added after). No-op at 100%. See css-zoom-coordinates.
    const z = uiZoom();
    setSlash({
      query: m[1],
      left: (coords.left - (rect?.left ?? 0)) / z,
      top: (coords.bottom - (rect?.top ?? 0)) / z + 4,
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
    // See detectSlash: divide the OUTER-px rect-delta by uiZoom() so the menu lands under the caret
    // at any UI zoom (no-op at 100%). See css-zoom-coordinates.
    const z = uiZoom();
    setLink({
      query: m[1],
      left: (coords.left - (rect?.left ?? 0)) / z,
      top: (coords.bottom - (rect?.top ?? 0)) / z + 4,
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
    // See detectSlash: divide the OUTER-px rect-delta by uiZoom() so the menu lands under the caret
    // at any UI zoom (no-op at 100%). See css-zoom-coordinates.
    const z = uiZoom();
    setTag({
      query: m[1],
      left: (coords.left - (rect?.left ?? 0)) / z,
      top: (coords.bottom - (rect?.top ?? 0)) / z + 4,
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
    // Measure against `.editor-wrap` — the `.task-hint` div is rendered as a SIBLING of
    // `.editor-content` (both are direct children of `.editor-wrap`), and `.editor-wrap` is the
    // nearest positioned ancestor (position: relative), so it's the button's offset parent.
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
    // coordsAtPos/getBoundingClientRect report OUTER (zoomed) pixels, but the `+` is an inline-styled
    // descendant of the zoomed body, so its left/top are read in LOCAL (unzoomed) pixels. Divide the
    // outer-pixel delta by uiZoom() so the button stays glued to the caret at any UI zoom (see
    // [[css-zoom-coordinates]]). At 100% uiZoom() === 1, so this is a no-op.
    const z = uiZoom();
    setTaskHint({ left: left / z, top: top / z });
  }, []);

  // The `+` task hint is positioned once (on selection/content change) and cached in state. Whole-UI
  // zoom (Ctrl +/-/0) changes `document.body.style.zoom` WITHOUT touching the selection, so without
  // this the cached left/top — computed at the old zoom — drifts until you next type or move the
  // caret. Watch the body's style attribute and re-run the placement when the zoom factor changes.
  useEffect(() => {
    let last = uiZoom();
    const obs = new MutationObserver(() => {
      const z = uiZoom();
      if (z === last) return;
      last = z;
      const ed = editorRef.current;
      if (ed) detectTaskHint(ed);
    });
    obs.observe(document.body, { attributes: true, attributeFilter: ["style"] });
    return () => obs.disconnect();
  }, [detectTaskHint]);

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

  // Folder-aware entries for the `[[` autocomplete: subfolders to drill into, pages to link, and a
  // "create" entry when the query names no existing page. See buildLinkItems.
  const linkItems: LinkItem[] = link ? buildLinkItems(pages, link.query) : [];

  // Replace the open `[[query` with a finished `[[Name]]` wikilink, creating the page first when
  // the chosen item is the "Create new page" option.
  const runLink = useCallback(
    async (item: LinkItem) => {
      if (!editor) return;
      const { state } = editor;
      const { from } = state.selection;
      // Position right after the open `[[`, before the query text.
      const queryStart = from - (link?.query.length ?? 0);

      // Folder pick: don't insert a link — rewrite the query to the folder path (keeping the `[[`)
      // so the menu re-fires scoped one level deeper. The caret lands at the end of the new path.
      if (item.folder) {
        editor
          .chain()
          .focus()
          .insertContentAt({ from: queryStart, to: from }, item.path)
          .run();
        // Re-detect against the rewritten query so the popup repopulates for the new folder.
        detectLink(editor);
        return;
      }

      const start = from - ((link?.query.length ?? 0) + 2); // back up over `[[query`
      // Auto-close may have inserted a trailing `]]` right after the caret; swallow it too so we
      // don't end up with `[[name]]]]`.
      const after = state.doc.textBetween(from, Math.min(from + 2, state.doc.content.size));
      const end = from + (after === "]]" ? 2 : after.startsWith("]") ? 1 : 0);

      // What the wikilink stores (and serializes to `[[…]]`). Default to the page's path so it
      // resolves unambiguously; collapse to the bare leaf when that leaf is unique across all pages,
      // since a short `[[Name]]` reads better and still resolves.
      let name = item.path;
      if (item.create) {
        // Create at the full typed path; onCreatePage returns the display (leaf) name.
        await ctxRef.current.onCreatePage?.(item.path);
        // Keep the path in the link unless the new leaf is already unique.
        name = item.path;
      }
      const leaf = name.replace(/\.md$/i, "").split("/").pop() || name;
      const leafCount = pages.filter(
        (p) => (p.name || "").toLowerCase() === leaf.toLowerCase()
      ).length;
      if (leafCount <= 1) name = leaf;

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
    [editor, link, pages, detectLink]
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

  // Flush any pending debounced serialization immediately (used before a page switch / unmount and
  // before the reloadKey content reset, so the last keystrokes are never lost).
  const flushSerialize = useCallback(() => {
    if (!serializeTimer.current) return;
    window.clearTimeout(serializeTimer.current);
    serializeTimer.current = null;
    const ed = editorRef.current;
    if (!ed) return;
    const md = docToMarkdown(ed.getJSON() as any);
    lastEmitted.current = md;
    onChange(md);
  }, [onChange]);

  // Flush on unmount so a fast page switch (which remounts the Editor) can't drop the final edits
  // that were still sitting in the debounce window.
  useEffect(() => () => flushSerialize(), [flushSerialize]);

  // When the file changes externally (reloadKey), reset content. Flush first so an in-flight edit to
  // the *outgoing* doc is committed before we load the incoming one.
  useEffect(() => {
    flushSerialize();
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
      <EditorContent editor={editor} className="editor-content" data-reload-key={reloadKey} />
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
              key={(it.folder ? "/" : it.create ? "+" : "") + it.path}
              className={`slash-item${i === linkIndex ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                runLink(it);
              }}
              onMouseEnter={() => setLinkIndex(i)}
            >
              <span className="slash-label">
                {it.folder && <Folder size={14} weight="fill" style={{ marginRight: 6, opacity: 0.7, verticalAlign: "-2px" }} />}
                {it.create ? `Create “${it.name}”` : it.name}
              </span>
              <span className="slash-hint">
                {it.folder ? "Open folder" : it.create ? "New page" : "Link to page"}
                {it.folder && <CaretRight size={12} weight="bold" style={{ marginLeft: 4, verticalAlign: "-1px" }} />}
              </span>
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
          currentPath={currentPath}
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
