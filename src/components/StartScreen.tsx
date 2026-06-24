import { useEffect, useState } from "react";
import { PushPin, FolderOpen, Plus, ArrowRight, Clock, CircleNotch } from "@phosphor-icons/react";
import { canOpenVault, listRecentVaults } from "../api";
import type { RecentVault } from "../types";

// A relative "time ago" label for the recent list — keeps the screen calm, no absolute dates.
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`;
}

interface Props {
  /** Open a brand-new vault via the folder picker. */
  onOpenNew: () => void;
  /** Re-open a previously-used vault by its id (path on desktop, handle key on web). */
  onOpenRecent: (id: string) => void;
  /** The id currently being opened ("new" for the folder picker), or null when idle. */
  openingId?: string | null;
  /** Bumped by the parent to force a re-fetch of the recent list (e.g. after pruning a dead one). */
  refreshKey?: number;
}

/**
 * The Start screen shown when no vault is open. Minimalist, with a subtle animated
 * gradient mesh in the background (pure CSS, Framer-style). Lists recent vaults so the
 * user can hop between them, plus a primary action to connect a new folder.
 */
export default function StartScreen({ onOpenNew, onOpenRecent, openingId = null, refreshKey = 0 }: Props) {
  const [recents, setRecents] = useState<RecentVault[]>([]);
  const supported = canOpenVault();
  // Any vault currently opening locks the whole screen so a second click can't race the first.
  const busy = openingId !== null;

  useEffect(() => {
    listRecentVaults()
      .then(setRecents)
      .catch(() => setRecents([]));
    // refreshKey re-runs this so a pruned (dead) recent disappears from the list immediately.
  }, [refreshKey]);

  return (
    <div className="start">
      {/* Animated gradient mesh — three drifting accent-tinted blobs behind a blur. */}
      <div className="start-mesh" aria-hidden="true">
        <span className="blob b1" />
        <span className="blob b2" />
        <span className="blob b3" />
      </div>

      <div className="start-card">
        <div className="start-logo">
          <span className="mark"><PushPin size={26} weight="fill" /></span>
          <span className="wordmark">PINPOINT</span>
        </div>
        <p className="start-tagline">
          A calm, local-first home for your notes. Plain markdown, yours forever.
        </p>

        {supported ? (
          <>
            <button
              className="primary big start-open"
              onClick={onOpenNew}
              disabled={busy}
              aria-busy={openingId === "new"}
            >
              {openingId === "new" ? (
                <>
                  <CircleNotch size={18} weight="bold" className="spin" /> Opening…
                </>
              ) : (
                <>
                  <FolderOpen size={18} weight="fill" /> Open a vault folder
                </>
              )}
            </button>

            {recents.length > 0 && (
              <div className="start-recents">
                <div className="start-recents-label">
                  <Clock size={13} /> Recent vaults
                </div>
                <ul>
                  {recents.map((v) => {
                    const opening = openingId === v.id;
                    return (
                      <li key={v.id}>
                        <button
                          className="recent-row"
                          onClick={() => onOpenRecent(v.id)}
                          disabled={busy}
                          aria-busy={opening}
                        >
                          <span className="recent-icon">
                            {opening ? (
                              <CircleNotch size={17} weight="bold" className="spin" />
                            ) : (
                              <FolderOpen size={17} weight="fill" />
                            )}
                          </span>
                          <span className="recent-text">
                            <span className="recent-name" title={v.id}>{v.name}</span>
                            <span className="recent-meta">{opening ? "Opening…" : timeAgo(v.last_opened)}</span>
                          </span>
                          <ArrowRight size={15} className="recent-go" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <button className="link start-newhint" onClick={onOpenNew} disabled={busy}>
              <Plus size={13} weight="bold" /> Connect a new folder
            </button>
            <p className="muted small start-foot">
              Point it at any folder — including one synced by Google Drive, OneDrive, or Dropbox.
            </p>
          </>
        ) : (
          <p className="notice">
            Your browser can't open local folders. Use a Chromium browser (Chrome, Edge, or Opera),
            or download the desktop app.
          </p>
        )}
      </div>
    </div>
  );
}
