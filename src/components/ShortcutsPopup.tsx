import { useEffect } from "react";
import { motion } from "framer-motion";
import { Keyboard, X } from "@phosphor-icons/react";
import { transition, slideFade } from "../motion";

// ⚠️ SOURCE OF TRUTH FOR KEYBOARD SHORTCUTS ⚠️
// This list is the user-facing mirror of the global key handler in App.tsx
// (the `onKey` effect, "Keyboard shortcuts" block). Whenever you add, remove,
// or change a binding there, update the matching row here so the popup stays
// accurate. The popup does not read bindings dynamically — it is hand-kept in
// sync on purpose, so each entry can carry a human-friendly description.
//
// `mod` renders as ⌘ on macOS and Ctrl elsewhere.

type Shortcut = { keys: string[]; label: string };
type Group = { title: string; items: Shortcut[] };

const GROUPS: Group[] = [
  {
    title: "General",
    items: [
      { keys: ["mod", "K"], label: "Open command palette" },
      { keys: ["mod", "J"], label: "Toggle AI chat panel" },
      { keys: ["?"], label: "Show keyboard shortcuts" },
    ],
  },
  {
    title: "Pages & tabs",
    items: [
      { keys: ["mod", "N"], label: "New page" },
      { keys: ["mod", "W"], label: "Close current tab" },
      { keys: ["Alt", "←"], label: "Go back" },
      { keys: ["Alt", "→"], label: "Go forward" },
    ],
  },
  {
    title: "Editing & selection",
    items: [
      { keys: ["Delete"], label: "Move selection to trash" },
      { keys: ["Shift", "Delete"], label: "Delete permanently" },
    ],
  },
  {
    title: "Appearance",
    items: [
      { keys: ["mod", "Shift", "L"], label: "Toggle dark / light" },
    ],
  },
  {
    title: "Zoom",
    items: [
      { keys: ["mod", "+"], label: "Zoom in" },
      { keys: ["mod", "-"], label: "Zoom out" },
      { keys: ["mod", "0"], label: "Reset zoom" },
    ],
  },
];

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);

/** Render a raw key token into its platform-friendly display label. */
function keyLabel(key: string): string {
  if (key === "mod") return IS_MAC ? "⌘" : "Ctrl";
  if (key === "Alt") return IS_MAC ? "⌥" : "Alt";
  if (key === "Shift") return IS_MAC ? "⇧" : "Shift";
  return key;
}

export default function ShortcutsPopup({ onClose }: { onClose: () => void }) {
  // Esc closes; mirrors the dismiss behaviour of the other overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      className="modal-backdrop"
      onMouseDown={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={transition("fast")}
    >
      <motion.div
        className="modal shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
        {...slideFade({ axis: "y", distance: -8, scale: 0.98, speed: "fast" })}
      >
        <div className="modal-header">
          <h2>
            <Keyboard size={20} weight="duotone" /> Keyboard shortcuts
          </h2>
          <button onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="shortcuts-grid">
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcuts-group">
              <h3 className="shortcuts-group-title">{group.title}</h3>
              {group.items.map((sc) => (
                <div key={sc.label} className="shortcut-row">
                  <span className="shortcut-label">{sc.label}</span>
                  <span className="shortcut-keys">
                    {sc.keys.map((k, i) => (
                      <kbd key={i}>{keyLabel(k)}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}
