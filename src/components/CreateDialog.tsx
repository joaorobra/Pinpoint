// A Mac-inspired "save panel": name a new page/folder/database AND pick where it goes.
//
// Usage (App.tsx owns the open/close state):
//   const [create, setCreate] = useState<CreateRequest | null>(null);
//   ...
//   setCreate({ kind: "page", tree });
//   {create && <CreateDialog req={create} onSubmit={...} onCancel={() => setCreate(null)} />}
//
// The folder column is a navigable, collapsible tree of the vault's directories — the user clicks a
// row to choose the destination, and a live breadcrumb shows exactly where the item will land.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  Folder,
  FolderOpen,
  Database,
  House,
  CaretRight,
} from "@phosphor-icons/react";
import type { TreeNode } from "../types";

export type CreateKind = "page" | "folder" | "database";

export interface CreateRequest {
  kind: CreateKind;
  tree: TreeNode;
  /** Pre-select this folder rel_path (e.g. the right-clicked node). "" = vault root. */
  initialParent?: string;
}

const KIND_META: Record<CreateKind, { title: string; Icon: typeof FileText; placeholder: string; allowDbParent: boolean }> = {
  page: { title: "New Page", Icon: FileText, placeholder: "Untitled", allowDbParent: true },
  folder: { title: "New Folder", Icon: Folder, placeholder: "Untitled", allowDbParent: false },
  database: { title: "New Database", Icon: Database, placeholder: "Untitled", allowDbParent: false },
};

interface Props {
  req: CreateRequest;
  /** Resolves with the chosen leaf name and the parent folder rel_path ("" = root). */
  onSubmit: (name: string, parentRel: string) => void;
  onCancel: () => void;
}

/** Collect a node's child *directories* in alphabetical order. Files are never shown here. */
function childDirs(node: TreeNode): TreeNode[] {
  return node.children
    .filter((c) => c.is_dir)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export default function CreateDialog({ req, onSubmit, onCancel }: Props) {
  const meta = KIND_META[req.kind];
  const [name, setName] = useState("");
  const [parent, setParent] = useState(req.initialParent ?? "");
  // Folders open in the picker. Ancestors of the initial selection start expanded so it's visible.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const out = new Set<string>([""]);
    const init = req.initialParent ?? "";
    let acc = "";
    for (const part of init.split("/").filter(Boolean)) {
      acc = acc ? `${acc}/${part}` : part;
      out.add(acc);
    }
    return out;
  });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const toggle = (rel: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(rel) ? next.delete(rel) : next.add(rel);
      return next;
    });

  // Human-readable destination breadcrumb: Vault / Projects / <name>.
  const crumbs = useMemo(() => {
    const parts = parent ? parent.split("/") : [];
    return ["Vault", ...parts];
  }, [parent]);

  const trimmed = name.trim();
  const canCreate = trimmed.length > 0;

  const submit = () => {
    if (!canCreate) return;
    onSubmit(trimmed, parent);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  // One row in the folder picker. Recurses through child directories.
  const renderRow = (node: TreeNode, depth: number) => {
    // A DB folder can't hold sub-folders/sub-DBs, and shouldn't be navigated into for those kinds.
    const isDb = node.is_database;
    const selectable = meta.allowDbParent || !isDb;
    const dirs = isDb ? [] : childDirs(node);
    const hasChildren = dirs.length > 0;
    const isOpen = expanded.has(node.rel_path);
    const isSelected = parent === node.rel_path;
    const RowIcon = depth === 0 ? House : isDb ? Database : isOpen && hasChildren ? FolderOpen : Folder;

    return (
      <div key={node.rel_path || "::root"}>
        <button
          type="button"
          className={`cd-row${isSelected ? " is-selected" : ""}${selectable ? "" : " is-disabled"}`}
          style={{ paddingLeft: `calc(${depth} * var(--sp-4) + var(--sp-2))` }}
          disabled={!selectable}
          onClick={() => selectable && setParent(node.rel_path)}
          onDoubleClick={() => hasChildren && toggle(node.rel_path)}
        >
          <span
            className={`cd-caret${hasChildren ? "" : " is-empty"}${isOpen ? " is-open" : ""}`}
            onClick={(e) => {
              if (!hasChildren) return;
              e.stopPropagation();
              toggle(node.rel_path);
            }}
          >
            {hasChildren && <CaretRight size={12} weight="bold" />}
          </span>
          <RowIcon size={16} weight={depth === 0 ? "fill" : "regular"} className="cd-row-icon" />
          <span className="cd-row-name">{depth === 0 ? "Vault" : node.name}</span>
        </button>
        {isOpen && dirs.map((c) => renderRow(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel} onKeyDown={onKeyDown}>
      <div
        className="modal create-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={meta.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header cd-header">
          <span className="cd-title-icon"><meta.Icon size={20} weight="duotone" /></span>
          <h2>{meta.title}</h2>
        </div>

        <label className="cd-field-label" htmlFor="cd-name">Name</label>
        <input
          id="cd-name"
          ref={inputRef}
          className="dialog-input cd-name"
          value={name}
          placeholder={meta.placeholder}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="cd-where-label">Where</div>
        <div className="cd-tree" role="tree">
          {renderRow(req.tree, 0)}
        </div>

        <div className="cd-path" aria-hidden>
          {crumbs.map((c, i) => (
            <span className="cd-crumb" key={i}>
              {i > 0 && <CaretRight size={10} weight="bold" className="cd-path-sep" />}
              {c}
            </span>
          ))}
          <CaretRight size={10} weight="bold" className="cd-path-sep" />
          <span className="cd-crumb cd-crumb-leaf">{trimmed || meta.placeholder}</span>
        </div>

        <div className="dialog-actions cd-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!canCreate}>Create</button>
        </div>
      </div>
    </div>
  );
}
