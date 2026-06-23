// The discreet "⌄" affordance on the active database-view tab.
//
// Replaces the old always-visible row of Smiley / Pencil / X buttons with a single caret that opens
// a small popdown — the same density-without-clutter pattern used by the column menu in DbTableView.
// The tab itself stays clean (icon + name); every per-view action lives behind this one control.

import { CaretDown, Smiley, PencilSimple, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { useDismiss } from "./DbShared";

interface Props {
  /** Whether a delete option should be offered (false when this is the only view). */
  canDelete: boolean;
  onSetIcon: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export default function ViewTabMenu({ canDelete, onSetIcon, onRename, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  // Ignore clicks on the tab strip so switching tabs doesn't double-fire the dismiss.
  const ref = useDismiss(open, () => setOpen(false), ".db-view-tabs");

  const run = (fn: () => void) => () => { fn(); setOpen(false); };

  return (
    <span className="db-view-tab-menu" ref={ref}>
      <button
        className="db-view-tab-caret"
        title="View options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        <CaretDown size={12} />
      </button>

      {open && (
        <div className="db-view-tab-pop" role="menu" onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={run(onSetIcon)}><Smiley size={14} /> Set icon</button>
          <button role="menuitem" onClick={run(onRename)}><PencilSimple size={14} /> Rename</button>
          {canDelete && (
            <button role="menuitem" className="db-view-tab-del" onClick={run(onDelete)}><Trash size={14} /> Delete</button>
          )}
        </div>
      )}
    </span>
  );
}
