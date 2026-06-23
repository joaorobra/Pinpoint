// A small dropdown listing the vault's templates, plus a "Blank" option.
//
// Reused by the database view's "+ New ▾" split button and the sidebar's create menu. The caller
// owns where the menu anchors and what happens on pick; this component only renders the list and
// reports the chosen template (or null for "Blank").

import { useEffect, useRef } from "react";
import { FileText, FilePlus } from "@phosphor-icons/react";
import type { TemplateInfo } from "../templates";

interface Props {
  templates: TemplateInfo[];
  /** Picked a template (its rel_path), or null for the "Blank" entry. */
  onPick: (relPath: string | null) => void;
  onClose: () => void;
  /** Extra className for positioning (the anchor decides absolute placement). */
  className?: string;
  /** Label for the blank entry. Defaults to "Blank page". */
  blankLabel?: string;
}

export default function TemplateMenu({ templates, onPick, onClose, className, blankLabel = "Blank page" }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className={`template-menu${className ? " " + className : ""}`} role="menu">
      <button className="template-menu-item" role="menuitem" onClick={() => { onPick(null); onClose(); }}>
        <FilePlus size={15} />
        <span>{blankLabel}</span>
      </button>
      {templates.length > 0 && <div className="template-menu-sep" />}
      {templates.map((t) => (
        <button
          key={t.rel_path}
          className="template-menu-item"
          role="menuitem"
          onClick={() => { onPick(t.rel_path); onClose(); }}
        >
          <FileText size={15} />
          <span>{t.name}</span>
        </button>
      ))}
      {templates.length === 0 && (
        <div className="template-menu-empty">No templates yet — add <code>.md</code> files to your Templates folder.</div>
      )}
    </div>
  );
}
