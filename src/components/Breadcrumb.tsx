import { SidebarSimple } from "@phosphor-icons/react";

interface BreadcrumbProps {
  /** Rel path of the active doc, e.g. "Notes/Projects/Pinpoint.md". Empty when nothing is open. */
  path: string;
  /** Toggle the left (file-tree) drawer. */
  onToggleLeft: () => void;
  /** Toggle the right (outline/calendar) drawer. */
  onToggleRight: () => void;
  leftOpen: boolean;
  rightOpen: boolean;
}

/**
 * Mobile-only top bar. With the sidebars collapsed into overlay drawers, this is the persistent
 * orientation cue: it shows where the open file sits in the vault and flanks that path with the two
 * drawer toggles (☰ file tree on the left, outline/calendar on the right). The crumb segments are
 * derived from the rel path; the leaf is shown without its `.md` extension. Tapping any folder
 * segment opens the file tree so the user can navigate from there (deeper folder jumps can come
 * later — for now every folder crumb is an entry point into the tree).
 */
export default function Breadcrumb({
  path,
  onToggleLeft,
  onToggleRight,
  leftOpen,
  rightOpen,
}: BreadcrumbProps) {
  const segments = path ? path.split("/").filter(Boolean) : [];
  const lastIdx = segments.length - 1;

  return (
    <nav className="breadcrumb" aria-label="Location">
      <button
        className={`breadcrumb-toggle${leftOpen ? " active" : ""}`}
        onClick={onToggleLeft}
        title="Files"
        aria-label="Toggle file tree"
        aria-expanded={leftOpen}
      >
        <SidebarSimple size={18} weight="bold" />
      </button>

      <div className="breadcrumb-trail">
        {segments.length === 0 ? (
          <span className="breadcrumb-empty">No file open</span>
        ) : (
          segments.map((seg, i) => {
            const isLeaf = i === lastIdx;
            const label = isLeaf ? seg.replace(/\.md$/i, "") : seg;
            return (
              <span className="breadcrumb-seg" key={i}>
                {i > 0 && <span className="breadcrumb-sep" aria-hidden>›</span>}
                <button
                  className={`breadcrumb-crumb${isLeaf ? " leaf" : ""}`}
                  // Folder crumbs open the tree; the leaf is the current file, so it's inert.
                  onClick={isLeaf ? undefined : onToggleLeft}
                  disabled={isLeaf}
                  title={label}
                >
                  {label}
                </button>
              </span>
            );
          })
        )}
      </div>

      <button
        className={`breadcrumb-toggle${rightOpen ? " active" : ""}`}
        onClick={onToggleRight}
        title="Outline & calendar"
        aria-label="Toggle outline panel"
        aria-expanded={rightOpen}
      >
        <SidebarSimple size={18} weight="bold" style={{ transform: "scaleX(-1)" }} />
      </button>
    </nav>
  );
}
