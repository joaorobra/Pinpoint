import { useEffect, useState } from "react";
import type { Window as TauriWindow } from "@tauri-apps/api/window";

// PINPOINT desktop runs frameless (decorations: false in tauri.conf.json), so we draw our own
// titlebar. Layout follows the Windows convention — minimize / maximize / close on the RIGHT — but
// the buttons are custom-styled flat glyphs (the macOS-clean look), not the OS chrome. On the web
// build there's no native window to drive, so this component renders nothing.

/** Lazily resolve the Tauri window handle; null on the web build (no native window). */
function getWin(): Promise<TauriWindow> | null {
  if (typeof window === "undefined") return null;
  if (!("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) return null;
  // Imported lazily so the web bundle never pulls in the window API.
  return import("@tauri-apps/api/window").then((m) => m.getCurrentWindow());
}

interface Props {
  /** Vault name shown centered in the bar (empty on the Start screen). */
  title?: string;
  /**
   * When true the bar is collapsed to a thin hover strip ("semi-fullscreen"): it slides into view
   * only while the pointer is at the top edge. When false it's a normal persistent titlebar.
   */
  autoHide?: boolean;
}

export default function Titlebar({ title, autoHide = false }: Props) {
  const [isTauri, setIsTauri] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // Whether the auto-hidden bar is currently revealed (pointer near the top edge).
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const win = getWin();
    if (!win) return;
    setIsTauri(true);
    Promise.resolve(win).then(async (w) => {
      setMaximized(await w.isMaximized());
      // Keep the maximize/restore glyph in sync when the user resizes via OS gestures.
      unlisten = await w.onResized(async () => setMaximized(await w.isMaximized()));
    });
    return () => unlisten?.();
  }, []);

  // In auto-hide mode, reveal the bar whenever the pointer is within the top strip of the window.
  useEffect(() => {
    if (!autoHide) return;
    const onMove = (e: MouseEvent) => setRevealed(e.clientY <= 6 || (revealed && e.clientY <= 44));
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [autoHide, revealed]);

  if (!isTauri) return null;

  const act = (fn: (w: TauriWindow) => unknown) => () => {
    getWin()?.then(fn);
  };

  const onMaximize = act(async (w) => {
    await w.toggleMaximize();
    setMaximized(await w.isMaximized());
  });

  return (
    <div
      className={`titlebar${autoHide ? " auto-hide" : ""}${autoHide && revealed ? " revealed" : ""}${
        maximized ? " maximized" : ""
      }`}
    >
      {/* The whole strip is the drag region; buttons below stop the drag via their own handlers. */}
      <div className="titlebar-drag" data-tauri-drag-region onDoubleClick={onMaximize}>
        {title && <span className="titlebar-title">{title}</span>}
      </div>
      <div className="titlebar-controls">
        <button className="tb-btn" aria-label="Minimize" title="Minimize" onClick={act((w) => w.minimize())}>
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
            <rect x="1" y="5" width="9" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className="tb-btn"
          aria-label={maximized ? "Restore" : "Maximize"}
          title={maximized ? "Restore" : "Maximize"}
          onClick={onMaximize}
        >
          {maximized ? (
            <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
              <rect x="2.5" y="0.5" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="0.5" y="2.5" width="8" height="8" fill="var(--titlebar-bg)" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button className="tb-btn tb-close" aria-label="Close" title="Close" onClick={act((w) => w.close())}>
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
            <path d="M1 1 L10 10 M10 1 L1 10" stroke="currentColor" strokeWidth="1.1" fill="none" />
          </svg>
        </button>
      </div>
    </div>
  );
}
