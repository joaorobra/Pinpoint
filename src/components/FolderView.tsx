import { useMemo } from "react";
import {
  Database,
  File as FileIcon,
  FilePdf,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Paperclip,
  Plus,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { NodeIcon, TreeNode } from "../types";
import { assetKindFor } from "../types";
import { NodeIconView } from "./Icon";
import PathBreadcrumb from "./PathBreadcrumb";

interface Props {
  /** The folder being shown as a page. */
  node: TreeNode;
  /** Per-node custom icons, keyed by rel_path. */
  nodeIcons: Record<string, NodeIcon>;
  /** Open a child node in its natural view (page / asset / database / nested folder). */
  onOpenNode: (node: TreeNode) => void;
  /** Open the icon picker for a node (the folder header, or a card). */
  onPickIcon: (node: TreeNode) => void;
  /** Create a new page / folder / database inside this folder, pre-targeted at it. */
  onCreate: (kind: "page" | "folder" | "database", folderRelPath: string) => void;
  /** Reveal a folder in the file tree (breadcrumb folder crumbs). */
  onRevealInTree: (folderRelPath: string) => void;
  /** Jump to the vault root in the file tree (breadcrumb home crumb). */
  onNavigateRoot: () => void;
}

/** Fallback glyph for a child node, mirroring the file tree's per-type icons. */
function fallbackIcon(node: TreeNode): PhosphorIcon {
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

/** Human-readable subtitle under a card: child count for folders, kind for files. */
function subtitle(node: TreeNode): string {
  if (node.is_dir) {
    if (node.is_database) return "Database";
    const n = node.children.length;
    return n === 0 ? "Empty folder" : `${n} item${n === 1 ? "" : "s"}`;
  }
  if (!node.ext) return "Page";
  return node.ext.toUpperCase();
}

const byName = (a: TreeNode, b: TreeNode) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/**
 * A folder opened "as a page": a Notion-style gallery of its direct children. Folders are listed
 * first (Finder-style), then pages and other files, each alphabetically. The header mirrors a page
 * header — breadcrumb trail + a large icon and the folder's name — so opening a folder feels like
 * opening any other document. Clicking a card opens that child in its own view; "add" cards in each
 * section create a new folder/database/page inside this folder. Empty folders get a real empty state.
 */
export default function FolderView({
  node,
  nodeIcons,
  onOpenNode,
  onPickIcon,
  onCreate,
  onRevealInTree,
  onNavigateRoot,
}: Props) {
  const { folders, files } = useMemo(() => {
    const folders = node.children.filter((c) => c.is_dir).sort(byName);
    const files = node.children.filter((c) => !c.is_dir).sort(byName);
    return { folders, files };
  }, [node.children]);

  const isEmpty = folders.length === 0 && files.length === 0;

  const addCard = (kind: "page" | "folder" | "database", label: string, glyph: PhosphorIcon) => {
    const Glyph = glyph;
    return (
      <button
        className="folder-card folder-card-add"
        onClick={() => onCreate(kind, node.rel_path)}
        title={`${label} in this folder`}
      >
        <span className="folder-card-add-icon">
          <Glyph size={18} weight="regular" />
          <Plus size={11} weight="bold" className="folder-card-add-plus" />
        </span>
        <span className="folder-card-name">{label}</span>
      </button>
    );
  };

  const card = (child: TreeNode) => (
    <button
      key={child.rel_path}
      className="folder-card"
      onClick={() => onOpenNode(child)}
      title={child.name}
    >
      <button
        type="button"
        className="folder-card-icon-btn"
        title="Change icon"
        aria-label={`Change icon for ${child.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onPickIcon(child);
        }}
      >
        <NodeIconView icon={nodeIcons[child.rel_path]} fallback={fallbackIcon(child)} size={22} />
      </button>
      <span className="folder-card-text">
        <span className="folder-card-name">{child.name.replace(/\.md$/i, "")}</span>
        <span className="folder-card-sub">{subtitle(child)}</span>
      </span>
    </button>
  );

  return (
    <div className="folder-view">
      <header className="folder-view-header">
        <PathBreadcrumb
          path={node.rel_path}
          icons={nodeIcons}
          onNavigateFolder={onRevealInTree}
          onNavigateRoot={onNavigateRoot}
        />
        <div className="folder-view-title">
          <button
            type="button"
            className="folder-view-icon"
            title="Change icon"
            aria-label="Change folder icon"
            onClick={() => onPickIcon(node)}
          >
            <NodeIconView icon={nodeIcons[node.rel_path]} fallback={FolderOpen} size={34} />
          </button>
          <h1 className="folder-view-name">{node.name}</h1>
        </div>
      </header>

      {isEmpty ? (
        <div className="folder-empty">
          <FolderOpen size={32} weight="thin" />
          <p>This folder is empty.</p>
          <div className="folder-empty-actions">
            <button className="folder-empty-action" onClick={() => onCreate("page", node.rel_path)}>
              <FileText size={15} weight="bold" /> New page
            </button>
            <button className="folder-empty-action ghost" onClick={() => onCreate("folder", node.rel_path)}>
              <Folder size={15} weight="bold" /> New folder
            </button>
            <button className="folder-empty-action ghost" onClick={() => onCreate("database", node.rel_path)}>
              <Database size={15} weight="bold" /> New database
            </button>
          </div>
        </div>
      ) : (
        <>
          <section className="folder-section">
            <h2 className="folder-section-label">Folders</h2>
            <div className="folder-grid">
              {folders.map(card)}
              {addCard("folder", "New folder", Folder)}
              {addCard("database", "New database", Database)}
            </div>
          </section>
          <section className="folder-section">
            <h2 className="folder-section-label">Pages</h2>
            <div className="folder-grid">
              {files.map(card)}
              {addCard("page", "New page", FileText)}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
