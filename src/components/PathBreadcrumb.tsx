import { Folder, House } from "@phosphor-icons/react";
import type { NodeIcon } from "../types";
import { NodeIconView } from "./Icon";

interface Props {
  /** Rel path of the active doc, e.g. "Notes/Projects/Pinpoint.md". Empty when nothing is open. */
  path: string;
  /** Per-node custom icons (keyed by rel_path), so folder crumbs match the file tree. */
  icons: Record<string, NodeIcon>;
  /** Reveal a folder in the file tree: expand its ancestors and scroll to it. */
  onNavigateFolder: (folderRelPath: string) => void;
  /** Jump to the vault root in the file tree. */
  onNavigateRoot: () => void;
}

/**
 * Desktop-only orientation trail shown above the page title. It renders only the *ancestor* chain
 * (vault root → … → parent folder) — never the leaf, since the open file is already the large
 * PageTitle directly below. Each crumb reveals that level in the file tree (reusing the same
 * tree-reveal path the mobile Breadcrumb uses), so the trail is both a "you are here" cue and a set
 * of one-click jumps up the hierarchy. Root-level files have no ancestors, so nothing renders.
 */
export default function PathBreadcrumb({ path, icons, onNavigateFolder, onNavigateRoot }: Props) {
  // Drop the leaf (the open file/db) — we only show the folders that contain it.
  const folders = path ? path.split("/").filter(Boolean).slice(0, -1) : [];
  if (folders.length === 0) return null;

  return (
    <nav className="path-breadcrumb" aria-label="Breadcrumb">
      <button
        className="path-crumb path-crumb-root"
        onClick={onNavigateRoot}
        title="Vault"
        aria-label="Go to vault root"
      >
        <House size={14} weight="bold" />
      </button>
      {folders.map((seg, i) => {
        // Cumulative rel path of this folder crumb, used to reveal it in the tree.
        const folderPath = folders.slice(0, i + 1).join("/");
        return (
          <span className="path-crumb-seg" key={folderPath}>
            <span className="path-crumb-sep" aria-hidden>
              /
            </span>
            <button
              className="path-crumb"
              onClick={() => onNavigateFolder(folderPath)}
              title={`Open ${seg} in sidebar`}
            >
              <NodeIconView icon={icons[folderPath]} fallback={Folder} size={14} />
              <span className="path-crumb-label">{seg}</span>
            </button>
          </span>
        );
      })}
    </nav>
  );
}
