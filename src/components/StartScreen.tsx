import { useEffect, useState } from "react";
import { FolderOpen, Plus, ArrowRight, Clock, CircleNotch, LockKey, MagnifyingGlass } from "@phosphor-icons/react";
import {
  canOpenVault,
  isAndroid,
  listRecentVaults,
  listAppVaults,
  externalStorageGranted,
  requestExternalStorage,
} from "../api";
import FolderBrowser from "./FolderBrowser";
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
  /** Open a brand-new vault via the folder picker (desktop / web). */
  onOpenNew: () => void;
  /** Re-open a previously-used vault by its id (path on desktop, handle key on web, name on Android). */
  onOpenRecent: (id: string) => void;
  /** Create + open a named app-owned vault (Android only — no folder picker exists there). */
  onCreateMobileVault?: (name: string) => void;
  /** Open an existing folder (by absolute path) as a vault — Android folder browser. */
  onOpenExisting?: (path: string) => void;
  /** The id currently being opened ("new" for the folder picker), or null when idle. */
  openingId?: string | null;
  /** Bumped by the parent to force a re-fetch of the recent list (e.g. after pruning a dead one). */
  refreshKey?: number;
}

/**
 * The Start screen shown when no vault is open. Minimalist, with a subtle animated
 * gradient mesh in the background (pure CSS, Framer-style).
 *
 * Two modes share this screen:
 *  - Desktop / web: a folder picker ("Open a vault folder") + recent vaults.
 *  - Android: there is no OS folder picker, so vaults are app-owned folders under the
 *    public Documents dir. We first ensure the "All files access" grant, then offer a
 *    "New vault" name prompt and a list of existing app vaults.
 */
export default function StartScreen({
  onOpenNew,
  onOpenRecent,
  onCreateMobileVault,
  onOpenExisting,
  openingId = null,
  refreshKey = 0,
}: Props) {
  const android = isAndroid();
  // Android-only: when true, the full-screen folder browser is shown over the card.
  const [browsing, setBrowsing] = useState(false);
  const [recents, setRecents] = useState<RecentVault[]>([]);
  const supported = canOpenVault();
  // Any vault currently opening locks the whole screen so a second click can't race the first.
  const busy = openingId !== null;

  // Android-only: whether we hold the "All files access" grant needed to write to Documents.
  // null = still checking; true/false once known. Desktop/web stay null and ignore this.
  const [granted, setGranted] = useState<boolean | null>(android ? null : true);
  // Android-only: the new-vault name prompt state.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (android) {
      // List app-owned vaults instead of the recents store; (re-)check the storage grant.
      listAppVaults().then(setRecents).catch(() => setRecents([]));
      externalStorageGranted().then(setGranted).catch(() => setGranted(false));
    } else {
      listRecentVaults().then(setRecents).catch(() => setRecents([]));
    }
    // refreshKey re-runs this so a pruned (dead) recent disappears from the list immediately.
  }, [refreshKey, android]);

  // Re-check the grant when the app regains focus (the user toggles it on a system screen,
  // then swipes back into PINPOINT — there's no callback, so we poll on resume).
  useEffect(() => {
    if (!android) return;
    const recheck = () => externalStorageGranted().then(setGranted).catch(() => {});
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [android]);

  function submitNewVault() {
    const name = newName.trim();
    if (!name) return;
    onCreateMobileVault?.(name);
    setNewName("");
    setCreating(false);
  }

  // Android folder browser takes over the whole screen when active.
  if (android && browsing) {
    return (
      <div className="start">
        <FolderBrowser
          busy={busy}
          onClose={() => setBrowsing(false)}
          onPick={(path) => onOpenExisting?.(path)}
        />
      </div>
    );
  }

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
          <span className="mark"><img src="/logo.png" alt="" width={40} height={40} /></span>
          <span className="wordmark">PINPOINT</span>
        </div>
        <p className="start-tagline">
          A calm, local-first home for your notes. Plain markdown, yours forever.
        </p>

        {android ? (
          // ---- Android: app-owned vaults (no folder picker) ----
          granted === false ? (
            <>
              <p className="notice">
                <LockKey size={15} weight="fill" /> PINPOINT needs “All files access” to store your
                vaults in your phone’s Documents folder, so they survive reinstalls and are visible to
                other apps.
              </p>
              <button
                className="primary big start-open"
                onClick={() => void requestExternalStorage()}
              >
                <LockKey size={18} weight="fill" /> Grant file access
              </button>
              <p className="muted small start-foot">
                You’ll be taken to a system settings screen. Toggle it on, then return here.
              </p>
            </>
          ) : (
            <>
              {creating ? (
                <form
                  className="start-newvault"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitNewVault();
                  }}
                >
                  <input
                    className="start-newvault-input"
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Vault name"
                    aria-label="New vault name"
                    disabled={busy}
                  />
                  <button
                    type="submit"
                    className="primary big start-open"
                    disabled={busy || !newName.trim()}
                    aria-busy={openingId === "new"}
                  >
                    {openingId === "new" ? (
                      <>
                        <CircleNotch size={18} weight="bold" className="spin" /> Creating…
                      </>
                    ) : (
                      <>
                        <Plus size={18} weight="bold" /> Create vault
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    className="link start-newhint"
                    onClick={() => {
                      setCreating(false);
                      setNewName("");
                    }}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  className="primary big start-open"
                  onClick={() => setCreating(true)}
                  disabled={busy || granted === null}
                  aria-busy={openingId === "new"}
                >
                  {openingId === "new" ? (
                    <>
                      <CircleNotch size={18} weight="bold" className="spin" /> Opening…
                    </>
                  ) : (
                    <>
                      <Plus size={18} weight="bold" /> New vault
                    </>
                  )}
                </button>
              )}

              {!creating && (
                <button
                  className="link start-newhint"
                  onClick={() => setBrowsing(true)}
                  disabled={busy || granted === null}
                >
                  <MagnifyingGlass size={13} weight="bold" /> Open an existing folder
                </button>
              )}

              {recents.length > 0 && (
                <div className="start-recents">
                  <div className="start-recents-label">
                    <Clock size={13} /> Your vaults
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
                              <span className="recent-name" title={v.name}>{v.name}</span>
                              <span className="recent-meta">
                                {opening ? "Opening…" : timeAgo(v.last_opened)}
                              </span>
                            </span>
                            <ArrowRight size={15} className="recent-go" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <p className="muted small start-foot">
                Vaults live in <strong>Documents/PINPOINT</strong> on your device.
              </p>
            </>
          )
        ) : supported ? (
          // ---- Desktop / web: folder picker ----
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
