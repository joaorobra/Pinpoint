import { useEffect, useRef, useState } from "react";
import type { NodeIcon } from "../types";
import { NodeIconView } from "./Icon";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

interface Props {
  /** Current display title (no extension). */
  title: string;
  /** The node's custom icon, if any. */
  icon?: NodeIcon;
  /** Fallback glyph when no custom icon is set (page / database). */
  fallback: PhosphorIcon;
  /** Placeholder shown when the title is empty. */
  placeholder?: string;
  /** Commit a renamed title. Only called when the value actually changed. */
  onCommit: (next: string) => void;
  /** Open the icon picker for this node. */
  onPickIcon: () => void;
}

/**
 * Notion-style page header: a large icon button beside an inline-editable "H0" title, shown above
 * the document/database body. Clicking the icon opens the icon picker; clicking the title turns it
 * into a text field. Enter or blur commits; Escape reverts. Keeps the rename in-context so the user
 * never has to go to the file tree to rename the open page.
 */
export default function PageTitle({ title, icon, fallback, placeholder = "Untitled", onCommit, onPickIcon }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the draft in sync when the active page changes underneath us (but not mid-edit).
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  useEffect(() => {
    if (editing) {
      const el = inputRef.current;
      el?.focus();
      el?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) onCommit(trimmed);
    else setDraft(title);
  };

  return (
    <div className="page-title">
      <button
        type="button"
        className="page-title-icon"
        title="Change icon"
        aria-label="Change icon"
        onClick={onPickIcon}
      >
        <NodeIconView icon={icon} fallback={fallback} size={34} />
      </button>
      {editing ? (
        <input
          ref={inputRef}
          className="page-title-input"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <h1
          className={`page-title-text${title ? "" : " placeholder"}`}
          tabIndex={0}
          title="Click to rename"
          onClick={() => setEditing(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setEditing(true);
            }
          }}
        >
          {title || placeholder}
        </h1>
      )}
    </div>
  );
}
