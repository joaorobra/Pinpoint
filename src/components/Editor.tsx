import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { WikiLink } from "./WikiLink";
import { dialogs } from "./Dialogs";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
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
  LinkSimple,
  Plus,
  Table,
  Database,
  type Icon,
} from "@phosphor-icons/react";
import DatePicker from "./DatePicker";
import QueryHelper from "./QueryHelper";
import { QueryBlock } from "./QueryBlock";
import { docToMarkdown, markdownToHtml } from "../markdown";
import { formatDate } from "../dateformat";

/** A page the `/link` command can reference. */
export interface PageRef {
  name: string;
  rel_path: string;
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
  /** Pattern for /today and the /date default. */
  dateFormat?: string;
  /** Pattern for the /time command. */
  timeFormat?: string;
  /** Pattern for rendering task due-dates in inline TASK query blocks. */
  taskDateFormat?: string;
  /**
   * Optional content rendered at the top of the scrolling editor column, above the document body
   * (used for the database-row properties panel). Scrolls with the doc and shares its width.
   */
  headerSlot?: React.ReactNode;
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
 */
function handleAutoClose(view: any, from: number, to: number, text: string): boolean {
  const { state } = view;
  const close = PAIRS[text];
  const nextChar = state.doc.textBetween(to, Math.min(to + 1, state.doc.content.size));

  // Step over an existing closing char instead of inserting a duplicate.
  if (from === to && CLOSERS.has(text) && nextChar === text) {
    view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(to + 1))));
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
function insertMarker(editor: any, marker: string): void {
  const { state } = editor;
  const { from } = state.selection;
  const prev = from > 0 ? state.doc.textBetween(from - 1, from) : " ";
  const needsSpace = prev !== "" && !/\s/.test(prev);
  editor.chain().focus().insertContent((needsSpace ? " " : "") + marker).run();
}

export default function Editor({
  value,
  onChange,
  reloadKey,
  pages = [],
  onCreatePage,
  onCreateDatabase,
  onOpenPage,
  onOpenPath,
  dateFormat = "YYYY-MM-DD",
  timeFormat = "HH:mm",
  taskDateFormat = "YYYY-MM-DD",
  headerSlot,
}: Props) {
  // Keep the open-page handlers in refs so node views always call the latest one without forcing
  // the editor to be re-created.
  const onOpenPageRef = useRef(onOpenPage);
  onOpenPageRef.current = onOpenPage;
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
  const lastEmitted = useRef<string>(value);
  const [slash, setSlash] = useState<{ query: string; left: number; top: number } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  // `[[wikilink]]` autocomplete: triggered when the caret sits in an open `[[query`.
  const [link, setLink] = useState<{ query: string; left: number; top: number } | null>(null);
  const [linkIndex, setLinkIndex] = useState(0);
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
  const ctxRef = useRef<SlashContext>({ pages, onCreatePage, onCreateDatabase, dateFormat, timeFormat, requestDate, requestQuery });
  ctxRef.current = { pages, onCreatePage, onCreateDatabase, dateFormat, timeFormat, requestDate, requestQuery };

  // The query block's edit button calls the latest handler through this ref (the QueryBlock
  // extension is configured once, so it can't close over a fresh `editQuery`).
  const editQueryRef = useRef(editQuery);
  editQueryRef.current = editQuery;

  // ProseMirror-level keydown handler for the popups. Lives in a ref because the editor is created
  // once; it must run before ProseMirror's own handling so it can swallow Enter (no newline) when a
  // menu is open. Returns true when it handled the key.
  const handlePopupKeyRef = useRef<(e: KeyboardEvent) => boolean>(() => false);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
        Link.configure({ openOnClick: false, autolink: true }),
        TaskList,
        TaskItem.configure({ nested: true }),
        SubtaskRollup,
        WikiLink.configure({ onOpen: (name) => onOpenPageRef.current?.(name) }),
        QueryBlock.configure({
          onEdit: (getPos, dsl) => editQueryRef.current(getPos, dsl),
          onOpenPath: (relPath) => onOpenPathRef.current?.(relPath),
          dateFormat: taskDateFormat,
        }),
        MoveBlock,
      ],
      content: markdownToHtml(value),
      editorProps: {
        handleTextInput: handleAutoClose,
        handleKeyDown: (_view, e) => handlePopupKeyRef.current(e),
      },
      onUpdate: ({ editor }) => {
        const md = docToMarkdown(editor.getJSON() as any);
        lastEmitted.current = md;
        onChange(md);
        detectSlash(editor);
        detectLink(editor);
        detectTaskHint(editor);
      },
      onSelectionUpdate: ({ editor }) => {
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
      return;
    }
    // Anchor just to the RIGHT of the task text. We use the right edge of the line's first text
    // row (coordsAtPos at the end of the item's first paragraph) so the `+` trails the text rather
    // than sitting over the checkbox on the left. Falls back to the item's DOM right edge.
    const itemPos = $from.before(taskDepth);
    const item = $from.node(taskDepth);
    const wrap = ed.view.dom.closest(".editor-wrap") as HTMLElement | null;
    const rect = wrap?.getBoundingClientRect();
    // End of the task item's first text block (its paragraph), where the visible text ends.
    const textEnd = itemPos + 1 + (item.firstChild?.nodeSize ?? 2) - 1;
    let left: number;
    let top: number;
    try {
      const coords = ed.view.coordsAtPos(textEnd);
      left = coords.right - (rect?.left ?? 0);
      top = coords.top - (rect?.top ?? 0);
    } catch {
      const dom = ed.view.nodeDOM(itemPos) as HTMLElement | null;
      const box = dom?.getBoundingClientRect?.();
      left = (box?.right ?? 0) - (rect?.left ?? 0);
      top = (box?.top ?? 0) - (rect?.top ?? 0);
    }
    setTaskHint({ left, top });
  }, []);

  // Run a task-property action (the same handlers the slash commands use) from the + menu.
  const runTaskProp = useCallback((id: "due" | "repeat") => {
    setTaskMenuOpen(false);
    const ed = editorRef.current;
    const cmd = COMMANDS.find((c) => c.id === id);
    if (cmd && ed) cmd.run(ed, ctxRef.current);
  }, []);

  const filtered = slash
    ? COMMANDS.filter(
        (c) =>
          !slash.query ||
          c.keywords.includes(slash.query.toLowerCase()) ||
          c.id.startsWith(slash.query.toLowerCase())
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

  // Close the slash / link popups when clicking anywhere outside them. The menu items run on
  // `onMouseDown` and stop here via the `.slash-menu` ancestor check, so picking an item still works.
  useEffect(() => {
    if (!slash && !link) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest(".slash-menu")) return;
      setSlash(null);
      setLink(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [slash, link]);

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

  // Menu key handling at the ProseMirror level so it runs before the editor inserts a newline on
  // Enter. Returns true when a popup consumed the key (suppressing the default editor behaviour).
  const handlePopupKey = (e: KeyboardEvent): boolean => {
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

  if (!editor) return null;

  return (
    <div className="editor-wrap">
      <Toolbar editor={editor} />
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
            </div>
          )}
        </div>
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
