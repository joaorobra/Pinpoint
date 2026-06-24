import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CaretRight,
  File as FileIcon,
  FileText,
  FilePdf,
  Image as ImageIcon,
  Paperclip,
  Folder,
  Database,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { NodeIcon, TreeNode } from "../types";
import { assetKindFor } from "../types";
import { NodeIconView } from "./Icon";

/** Click modifiers that drive multi-selection, normalized across platforms. */
export interface SelectMods {
  /** Ctrl (Win/Linux) or Cmd (macOS) was held: toggle this row in/out of the selection. */
  toggle: boolean;
  /** Shift was held: select the contiguous range from the anchor to this row. */
  range: boolean;
}

interface Props {
  node: TreeNode;
  activePath: string | null;
  /** rel_paths currently selected (multi-selection). Always includes activePath after a plain click. */
  selected: Set<string>;
  /**
   * A row was clicked. `mods` says whether ctrl/shift were held; `range` is the list of
   * rel_paths the click resolves to in visible order (a single path for plain/ctrl clicks,
   * the spanned rows for a shift-click). A plain click (no mods) also opens the node.
   */
  onSelect: (node: TreeNode, mods: SelectMods, range: string[]) => void;
  /** Per-node icon overrides, keyed by rel_path. */
  nodeIcons: Record<string, NodeIcon>;
  /** Open a markdown page in the editor. */
  onOpen: (relPath: string) => void;
  /** Open a non-markdown file (PDF, image, …) in the asset viewer. */
  onOpenAsset?: (node: TreeNode) => void;
  /** Open a database folder (is_database) in the table view. */
  onOpenDatabase?: (node: TreeNode) => void;
  /** Open a plain folder (not a database) as a gallery page. */
  onOpenFolder?: (node: TreeNode) => void;
  /** Right-click on a tree row: hand the node and pointer coords to the host for a context menu. */
  onContextMenu?: (node: TreeNode, x: number, y: number) => void;
  /** Click on a node's icon: open the icon picker for that node. */
  onPickIcon?: (node: TreeNode) => void;
  /**
   * Drag-and-drop reorganize: move `paths` into the folder `destDir` (the empty string is the vault
   * root). The host renames each node to its new parent; the tree refreshes from the result.
   */
  onMove?: (paths: string[], destDir: string) => void;
  /**
   * Current multi-selection (rel_paths). When the user drags a row that's part of the selection,
   * the whole selection moves together; dragging an unselected row moves just that row.
   */
  selectedSnapshot?: Set<string>;
  /** rel_path of the row currently being renamed inline, or null. */
  renamingPath?: string | null;
  /** Commit an inline rename with the edited (display) name. */
  onRenameCommit?: (node: TreeNode, newName: string) => void;
  /** Cancel the inline rename without changes. */
  onRenameCancel?: () => void;
  /**
   * The host populates this ref with a `reveal(relPath)` function it can call to expand a folder's
   * ancestors and scroll it into view (used by the mobile breadcrumb's folder crumbs).
   */
  revealRef?: React.MutableRefObject<((relPath: string) => void) | null>;
  /**
   * The host populates this ref with commands that drive folder open/closed state, so the
   * right-click menu can offer "Expand all" / "Collapse all" scoped to a single folder's subtree
   * (or, with no relPath, the whole tree).
   */
  cmdRef?: React.MutableRefObject<TreeCommands | null>;
}

/** Imperative handle exposed via {@link Props.cmdRef} for driving folder collapse state. */
export interface TreeCommands {
  /** Open `relPath` and every descendant folder; with no arg, expand the whole tree. */
  expand: (relPath?: string) => void;
  /** Collapse `relPath` and every descendant folder; with no arg, collapse the whole tree. */
  collapse: (relPath?: string) => void;
}

/**
 * Drag-and-drop context threaded down to every row. `destDir` is a folder's rel_path, or "" for the
 * vault root. `dropTarget` is the folder currently highlighted as the drop destination (or null).
 */
interface DragCtx {
  start: (relPath: string) => void;
  end: () => void;
  over: (destDir: string) => void;
  leave: (destDir: string) => void;
  drop: (destDir: string) => void;
  dropTarget: string | null;
}

/**
 * Whether moving `dragged` (rel_paths) into folder `destDir` ("" = root) is a legal, non-trivial
 * move: no node may land in its own current parent, and a folder can't move into itself or a
 * descendant. At least one node must actually change parent for the drop to be meaningful.
 */
function canDropInto(dragged: string[], destDir: string): boolean {
  if (!dragged.length) return false;
  let moves = false;
  for (const from of dragged) {
    const parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    // A folder can't be dropped into itself or its own subtree.
    if (destDir === from || destDir.startsWith(from + "/")) return false;
    if (parent !== destDir) moves = true;
  }
  return moves;
}

/** The default Phosphor icon for a node when the user hasn't chosen one. */
function defaultIcon(node: TreeNode): PhosphorIcon {
  if (node.is_dir) return node.is_database ? Database : Folder;
  if (!node.ext) return FileText; // markdown page
  switch (assetKindFor(node.ext)) {
    case "image":
      return ImageIcon;
    case "pdf":
      return FilePdf;
    case "text":
      return FileText;
    default:
      return node.ext ? Paperclip : FileIcon;
  }
}

/**
 * The vault file tree. Folder open/closed state is owned here (a Set of collapsed paths) so the
 * header's expand-all / collapse-all controls can drive every folder at once — Obsidian-style.
 */
export default function FileTree({ node, activePath, selected, onSelect, nodeIcons, onOpen, onOpenAsset, onOpenDatabase, onOpenFolder, onContextMenu, onPickIcon, onMove, selectedSnapshot, renamingPath, onRenameCommit, onRenameCancel, revealRef, cmdRef }: Props) {
  // We track which folders are *collapsed*; everything else is open by default at depth 0,
  // and a bumped signal lets the toolbar collapse/expand the whole tree at once.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  // rel_path of the folder currently hovered as a drop target ("" = the vault root), or null. Drives
  // the drop-target highlight. The set of rel_paths being dragged lives in a ref so the handlers in
  // every row can read it without re-rendering the whole tree on dragstart.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const draggingRef = useRef<string[]>([]);

  // Resolve which rows a drag carries: the whole selection if the dragged row is part of it,
  // otherwise just that row.
  const dragSetFor = (relPath: string): string[] =>
    selectedSnapshot?.has(relPath) ? Array.from(selectedSnapshot) : [relPath];

  const drag: DragCtx | undefined = onMove
    ? {
        start: (relPath) => {
          draggingRef.current = dragSetFor(relPath);
        },
        end: () => {
          draggingRef.current = [];
          setDropTarget(null);
        },
        over: (destDir) => {
          if (canDropInto(draggingRef.current, destDir)) setDropTarget(destDir);
        },
        leave: (destDir) => {
          setDropTarget((cur) => (cur === destDir ? null : cur));
        },
        drop: (destDir) => {
          const dragged = draggingRef.current;
          draggingRef.current = [];
          setDropTarget(null);
          if (canDropInto(dragged, destDir)) onMove(dragged, destDir);
        },
        dropTarget,
      }
    : undefined;

  const allDirPaths = useMemo(() => {
    const paths: string[] = [];
    const visit = (n: TreeNode) => {
      if (n.is_dir && n.rel_path) paths.push(n.rel_path);
      n.children.forEach(visit);
    };
    node.children.forEach(visit);
    return paths;
  }, [node]);

  const toggle = (relPath: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(relPath) ? next.delete(relPath) : next.add(relPath);
      return next;
    });

  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(new Set(allDirPaths));

  // The folder paths inside (and including) `relPath`'s subtree. Used to scope expand/collapse to
  // a single folder from its context menu.
  const subtreeDirPaths = (relPath: string): string[] => {
    const found: string[] = [];
    const visit = (n: TreeNode, inside: boolean) => {
      const here = inside || n.rel_path === relPath;
      if (here && n.is_dir && n.rel_path) found.push(n.rel_path);
      n.children.forEach((c) => visit(c, here));
    };
    node.children.forEach((c) => visit(c, false));
    return found;
  };

  // Expose expand/collapse commands to the host (drives the right-click menu). With a relPath the
  // command is scoped to that folder's subtree; without one it acts on the whole tree.
  useEffect(() => {
    if (!cmdRef) return;
    cmdRef.current = {
      expand: (relPath) =>
        setCollapsed((prev) => {
          if (!relPath) return new Set();
          const next = new Set(prev);
          subtreeDirPaths(relPath).forEach((p) => next.delete(p));
          return next;
        }),
      collapse: (relPath) =>
        setCollapsed((prev) => {
          if (!relPath) return new Set(allDirPaths);
          const next = new Set(prev);
          subtreeDirPaths(relPath).forEach((p) => next.add(p));
          return next;
        }),
    };
    return () => {
      if (cmdRef) cmdRef.current = null;
    };
  }, [cmdRef, node, allDirPaths]);

  // Expose a reveal(relPath) to the host: expand the folder and every ancestor so it's visible,
  // then scroll its row into view. Drives the mobile breadcrumb's folder crumbs.
  useEffect(() => {
    if (!revealRef) return;
    revealRef.current = (relPath: string) => {
      const parts = relPath.split("/").filter(Boolean);
      // Ancestor paths + the folder itself must all be un-collapsed.
      const open = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
      setCollapsed((prev) => {
        if (!open.some((p) => prev.has(p))) return prev;
        const next = new Set(prev);
        open.forEach((p) => next.delete(p));
        return next;
      });
      // Defer the scroll a frame so the newly-expanded rows have mounted.
      requestAnimationFrame(() => {
        const row = rootRef.current?.querySelector<HTMLElement>(
          `[data-rel="${CSS.escape(relPath)}"]`
        );
        row?.scrollIntoView({ block: "nearest" });
      });
    };
    return () => {
      if (revealRef) revealRef.current = null;
    };
  }, [revealRef]);

  // Flat, top-to-bottom order of the rows the user can currently see (collapsed folders hide
  // their children). Shift-click ranges are resolved against this order, mirroring how
  // Explorer/Finder treat a range as "everything between the two clicks as displayed".
  const visibleOrder = useMemo(() => {
    const order: string[] = [];
    const visit = (n: TreeNode) => {
      order.push(n.rel_path);
      if (n.is_dir && !collapsed.has(n.rel_path)) n.children.forEach(visit);
    };
    node.children.forEach(visit);
    return order;
  }, [node, collapsed]);

  // The last row that was selected with a plain or ctrl click. Shift-click extends from here.
  const anchorRef = useRef<string | null>(null);

  const handleSelect = (target: TreeNode, mods: SelectMods) => {
    if (mods.range && anchorRef.current) {
      const a = visibleOrder.indexOf(anchorRef.current);
      const b = visibleOrder.indexOf(target.rel_path);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        onSelect(target, mods, visibleOrder.slice(lo, hi + 1));
        return; // anchor stays put across a range selection
      }
    }
    anchorRef.current = target.rel_path;
    onSelect(target, mods, [target.rel_path]);
  };

  return (
    <>
      <div className="tree-toolbar">
        <button onClick={expandAll} title="Expand all folders">
          <CaretDown size={12} weight="bold" /> Expand
        </button>
        <button onClick={collapseAll} title="Collapse all folders">
          <CaretRight size={12} weight="bold" /> Collapse
        </button>
      </div>
      <div
        className={`tree-body${drag?.dropTarget === "" ? " drop-root" : ""}`}
        ref={rootRef}
        // Dropping onto blank space in the tree (not on a folder row) moves items to the vault root.
        onDragOver={
          drag
            ? (e) => {
                if (e.target === e.currentTarget && canDropInto(draggingRef.current, "")) {
                  e.preventDefault();
                  drag.over("");
                }
              }
            : undefined
        }
        onDragLeave={drag ? (e) => { if (e.target === e.currentTarget) drag.leave(""); } : undefined}
        onDrop={
          drag
            ? (e) => {
                if (e.target === e.currentTarget) {
                  e.preventDefault();
                  drag.drop("");
                }
              }
            : undefined
        }
      >
        {node.children.map((c) => (
          <TreeRow
            key={c.rel_path}
            node={c}
            depth={0}
            drag={drag}
            activePath={activePath}
            selected={selected}
            onSelect={handleSelect}
            nodeIcons={nodeIcons}
            collapsed={collapsed}
            onToggle={toggle}
            onOpen={onOpen}
            onOpenAsset={onOpenAsset}
            onOpenDatabase={onOpenDatabase}
            onOpenFolder={onOpenFolder}
            onContextMenu={onContextMenu}
            onPickIcon={onPickIcon}
            renamingPath={renamingPath}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
          />
        ))}
      </div>
    </>
  );
}

interface RowProps {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  selected: Set<string>;
  onSelect: (node: TreeNode, mods: SelectMods) => void;
  nodeIcons: Record<string, NodeIcon>;
  collapsed: Set<string>;
  onToggle: (relPath: string) => void;
  onOpen: (relPath: string) => void;
  onOpenAsset?: (node: TreeNode) => void;
  onOpenDatabase?: (node: TreeNode) => void;
  onOpenFolder?: (node: TreeNode) => void;
  onContextMenu?: (node: TreeNode, x: number, y: number) => void;
  onPickIcon?: (node: TreeNode) => void;
  drag?: DragCtx;
  renamingPath?: string | null;
  onRenameCommit?: (node: TreeNode, newName: string) => void;
  onRenameCancel?: () => void;
}

function TreeRow({ node, depth, activePath, selected, onSelect, nodeIcons, collapsed, onToggle, onOpen, onOpenAsset, onOpenDatabase, onOpenFolder, onContextMenu, onPickIcon, drag, renamingPath, onRenameCommit, onRenameCancel }: RowProps) {
  const renaming = renamingPath === node.rel_path;
  const isSelected = selected.has(node.rel_path);
  // Normalize the click into selection modifiers. metaKey covers Cmd on macOS.
  const mods = (e: React.MouseEvent): SelectMods => ({
    toggle: e.ctrlKey || e.metaKey,
    range: e.shiftKey,
  });
  // Clicking the icon opens the picker instead of opening/toggling the node.
  const pickIcon = onPickIcon
    ? (e: React.MouseEvent) => {
        e.stopPropagation();
        onPickIcon(node);
      }
    : undefined;
  const icon = nodeIcons[node.rel_path];
  const ctx = onContextMenu
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(node, e.clientX, e.clientY);
      }
    : undefined;
  // Depth-based indent guides: one vertical rule per ancestor level, like Obsidian.
  const guides = (
    <span className="tree-guides" aria-hidden>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="tree-guide" />
      ))}
    </span>
  );

  // Drag-source props shared by file and folder rows: every row can be picked up and dropped onto a
  // folder (or the root) to move it. Renaming a row suppresses dragging so text selection works.
  const dragSrc =
    drag && !renaming
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            drag.start(node.rel_path);
            e.dataTransfer.effectAllowed = "move";
            // Some browsers need data set for the drag to start.
            e.dataTransfer.setData("text/plain", node.rel_path);
          },
          onDragEnd: () => drag.end(),
        }
      : {};

  // Drop-target props for folder rows: highlight while a valid drag hovers, and move on drop.
  const dropProps = (destDir: string) =>
    drag
      ? {
          onDragOver: (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            drag.over(destDir);
          },
          onDragLeave: () => drag.leave(destDir),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            drag.drop(destDir);
          },
        }
      : {};

  if (!node.is_dir) {
    const isMd = node.ext === "";
    const label = isMd ? node.name.replace(/\.md$/i, "") : node.name.replace(new RegExp(`\\.${node.ext}$`, "i"), "");
    return (
      <div
        data-rel={node.rel_path}
        {...dragSrc}
        className={`tree-file${activePath === node.rel_path ? " active" : ""}${isSelected ? " selected" : ""}`}
        onClick={(e) => {
          const m = mods(e);
          onSelect(node, m);
          // Only a plain click opens the file; ctrl/shift are selection-only.
          if (!m.toggle && !m.range) (isMd ? onOpen(node.rel_path) : onOpenAsset?.(node));
        }}
        onContextMenu={ctx}
        title={node.rel_path}
      >
        {guides}
        <span
          className={`tree-icon tree-icon-btn${onPickIcon ? " clickable" : ""}`}
          onClick={pickIcon}
          title={onPickIcon ? "Set icon" : undefined}
        >
          <NodeIconView icon={icon} fallback={defaultIcon(node)} />
        </span>
        {renaming ? (
          <RenameInput
            initial={label}
            onCommit={(v) => onRenameCommit?.(node, v)}
            onCancel={() => onRenameCancel?.()}
          />
        ) : (
          <>
            <span className="tree-label">{label}</span>
            {!isMd && <span className="tree-ext">{node.ext}</span>}
          </>
        )}
      </div>
    );
  }

  const open = !collapsed.has(node.rel_path);
  return (
    <div>
      <div
        data-rel={node.rel_path}
        {...dragSrc}
        {...dropProps(node.rel_path)}
        className={`tree-dir${isSelected ? " selected" : ""}${drag?.dropTarget === node.rel_path ? " drop-target" : ""}`}
        onClick={(e) => {
          const m = mods(e);
          // Ctrl/shift select the folder. A plain click opens/closes it — and also opens its view:
          // the table for a database folder, or the gallery page for a plain folder (Notion-style).
          if (m.toggle || m.range) onSelect(node, m);
          else {
            onToggle(node.rel_path);
            if (node.is_database) onOpenDatabase?.(node);
            else onOpenFolder?.(node);
          }
        }}
        onContextMenu={ctx}
      >
        {guides}
        <span className="tree-icon tree-caret">
          {open ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
        </span>
        <span
          className={`tree-icon tree-icon-btn${onPickIcon ? " clickable" : ""}`}
          onClick={pickIcon}
          title={onPickIcon ? "Set icon" : undefined}
        >
          <NodeIconView icon={icon} fallback={defaultIcon(node)} fallbackColor="var(--accent)" />
        </span>
        {renaming ? (
          <RenameInput
            initial={node.name}
            onCommit={(v) => onRenameCommit?.(node, v)}
            onCancel={() => onRenameCancel?.()}
          />
        ) : (
          <span className="tree-label">{node.name}</span>
        )}
      </div>
      {open &&
        node.children.map((c) => (
          <TreeRow
            key={c.rel_path}
            node={c}
            depth={depth + 1}
            activePath={activePath}
            selected={selected}
            onSelect={onSelect}
            nodeIcons={nodeIcons}
            collapsed={collapsed}
            onToggle={onToggle}
            onOpen={onOpen}
            onOpenAsset={onOpenAsset}
            onOpenDatabase={onOpenDatabase}
            onOpenFolder={onOpenFolder}
            onContextMenu={onContextMenu}
            onPickIcon={onPickIcon}
            drag={drag}
            renamingPath={renamingPath}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
          />
        ))}
    </div>
  );
}

/**
 * Inline rename field for a tree row. Seeds with the display name, selects the basename (the part
 * before any extension dot) on focus, commits on Enter/blur and cancels on Escape — Windows
 * Explorer behaviour.
 */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const committed = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the basename only (everything before the last dot), so an extension stays put.
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(ref.current?.value ?? initial);
  };

  return (
    <input
      ref={ref}
      className="tree-rename-input"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          committed.current = true; // suppress the blur-commit that follows
          onCancel();
        }
      }}
    />
  );
}
