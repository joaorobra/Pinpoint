import { useEffect, useState } from "react";
import { CaretLeft, FolderOpen, Folder, ArrowUUpLeft, CircleNotch, Check } from "@phosphor-icons/react";
import { storageHomeDir, listSubdirs, type DirEntry } from "../api";

interface Props {
  /** Open the folder at `path` as a vault. */
  onPick: (path: string) => void;
  /** Dismiss the browser without picking. */
  onClose: () => void;
  /** True while the chosen folder is being opened (locks the UI, shows a spinner). */
  busy?: boolean;
}

/** The parent directory of `path`, or null if already at a filesystem root. */
function parentOf(path: string): string | null {
  // Normalize trailing slash, then strip the last segment. Works for the POSIX
  // paths Android shared storage uses (/storage/emulated/0/...).
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return null; // "/foo" -> root; "" / "/" -> no parent
  return trimmed.slice(0, idx);
}

/** Last path segment, for the header. */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) || "/" : trimmed;
}

/**
 * A full-screen directory browser for opening an *existing* folder as a vault.
 * Navigate into folders by tapping; go up with the back affordance; tap "Open this
 * folder" to choose the current directory. Backed by the Rust `list_subdirs` command,
 * which can see the device's shared storage because "All files access" is granted.
 */
export default function FolderBrowser({ onPick, onClose, busy = false }: Props) {
  const [cwd, setCwd] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Resolve the starting directory once.
  useEffect(() => {
    storageHomeDir()
      .then(setCwd)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Load the listing whenever the current directory changes.
  useEffect(() => {
    if (cwd === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listSubdirs(cwd)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((e) => {
        if (!cancelled) {
          setEntries([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const parent = cwd ? parentOf(cwd) : null;

  return (
    <div className="folderbrowser">
      <div className="fb-head">
        <button className="fb-back" onClick={onClose} disabled={busy} aria-label="Cancel">
          <CaretLeft size={18} weight="bold" />
        </button>
        <div className="fb-title" title={cwd ?? ""}>
          <FolderOpen size={16} weight="fill" />
          <span className="fb-cwd">{cwd ? baseName(cwd) : "…"}</span>
        </div>
        <button
          className="primary fb-pick"
          onClick={() => cwd && onPick(cwd)}
          disabled={busy || !cwd}
          aria-busy={busy}
        >
          {busy ? <CircleNotch size={15} weight="bold" className="spin" /> : <Check size={15} weight="bold" />}
          Open
        </button>
      </div>

      <div className="fb-path">{cwd ?? ""}</div>

      <div className="fb-list">
        {parent && (
          <button className="fb-row fb-up" onClick={() => setCwd(parent)} disabled={busy}>
            <ArrowUUpLeft size={18} weight="bold" />
            <span>Up a level</span>
          </button>
        )}

        {loading ? (
          <div className="fb-empty">
            <CircleNotch size={20} weight="bold" className="spin" /> Loading…
          </div>
        ) : error ? (
          <div className="fb-empty fb-error">{error}</div>
        ) : entries.length === 0 ? (
          <div className="fb-empty">No sub-folders here. Tap “Open” to use this folder.</div>
        ) : (
          entries.map((d) => (
            <button
              key={d.path}
              className="fb-row"
              onClick={() => setCwd(d.path)}
              disabled={busy}
            >
              <Folder size={18} weight="fill" />
              <span className="fb-name">{d.name}</span>
            </button>
          ))
        )}
      </div>

      <p className="fb-hint muted small">
        Navigate to a folder, then tap <strong>Open</strong> to use it as a vault.
      </p>
    </div>
  );
}
