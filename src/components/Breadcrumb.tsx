interface BreadcrumbProps {
  /** Rel path of the active doc, e.g. "Notes/Projects/Pinpoint.md". Empty when nothing is open. */
  path: string;
  /** Jump to a folder: open it and reveal/scroll to that folder in the tree. */
  onNavigateFolder?: (folderRelPath: string) => void;
}

/**
 * Mobile-only top bar — a pure orientation cue. With the sidebars collapsed into overlay drawers
 * (toggled from the bottom navbar, which owns all drawer controls), this bar's single job is to show
 * WHERE the open file sits in the vault. The crumb segments are derived from the rel path; the leaf
 * is shown without its `.md` extension. Tapping a folder segment opens that folder and reveals it in
 * the tree, so each crumb is a real jump to that level of the hierarchy.
 */
export default function Breadcrumb({ path, onNavigateFolder }: BreadcrumbProps) {
  const segments = path ? path.split("/").filter(Boolean) : [];
  const lastIdx = segments.length - 1;

  return (
    <nav className="breadcrumb" aria-label="Location">
      <div className="breadcrumb-trail">
        {segments.length === 0 ? (
          <span className="breadcrumb-empty">No file open</span>
        ) : (
          segments.map((seg, i) => {
            const isLeaf = i === lastIdx;
            const label = isLeaf ? seg.replace(/\.md$/i, "") : seg;
            // Cumulative rel path of this folder crumb, used to open + reveal it.
            const folderPath = segments.slice(0, i + 1).join("/");
            return (
              <span className="breadcrumb-seg" key={i}>
                {i > 0 && <span className="breadcrumb-sep" aria-hidden>›</span>}
                <button
                  className={`breadcrumb-crumb${isLeaf ? " leaf" : ""}`}
                  // Folder crumbs jump to that folder; the leaf is the current file (inert).
                  onClick={isLeaf ? undefined : () => onNavigateFolder?.(folderPath)}
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
    </nav>
  );
}
