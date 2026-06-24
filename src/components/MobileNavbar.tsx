import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  SidebarSimple,
  Plus,
  CheckSquare,
  FileText,
  CaretRight,
  ArrowLeft,
  X,
  Folder,
  House,
} from "@phosphor-icons/react";
import { useFocusTrap } from "../hooks/useFocusTrap";

/** Vault-relative folder paths offered as a new note's destination. "" = vault root. */
export interface FolderOption {
  /** rel_path of the folder ("" for the vault root). */
  path: string;
  /** Indentation depth, so nested folders read as a tree in the picker. */
  depth: number;
}

interface MobileNavbarProps {
  /** Toggle the left (file-tree) drawer. */
  onToggleLeft: () => void;
  /** Toggle the right (outline/calendar) drawer. */
  onToggleRight: () => void;
  leftOpen: boolean;
  rightOpen: boolean;
  /** Append a `- [ ] …` line to today's daily note (created if missing). */
  onAddTask: (text: string) => Promise<void> | void;
  /** Create a new note titled `title` inside `parentRel` ("" = vault root) and open it. */
  onNewNote: (title: string, parentRel: string) => Promise<void> | void;
  /** Every folder in the vault, for the new-note destination picker. */
  folders: FolderOption[];
}

type Mode = "menu" | "task" | "note";

/**
 * Mobile-only bottom navigation bar with one dominant primary action: Quick Capture (＋). It is
 * flanked by the two drawer toggles (Files / Outline) so the bar is also the persistent reach for
 * navigation on a phone, mirroring the top Breadcrumb's toggles within thumb range.
 *
 * Tapping ＋ raises a bottom sheet offering the two fastest capture intents:
 *   • Task for today — one field, Enter to file it under today's daily note (zero folder decisions).
 *   • New note — a title + a folder destination (defaults to the vault root).
 * Both are forgiving: no confirm dialogs, success is acknowledged by the parent's toast.
 */
export default function MobileNavbar({
  onToggleLeft,
  onToggleRight,
  leftOpen,
  rightOpen,
  onAddTask,
  onNewNote,
  folders,
}: MobileNavbarProps) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [taskText, setTaskText] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteParent, setNoteParent] = useState("");
  // Disable the submit button + guard against a double-tap while the create round-trips.
  const [busy, setBusy] = useState(false);

  const sheetRef = useRef<HTMLDivElement>(null);
  const taskInputRef = useRef<HTMLInputElement>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(sheetRef, mode !== null);

  const open = mode !== null;

  // Reset the form each time the sheet opens fresh from the bar (not on internal step changes).
  const openSheet = () => {
    setTaskText("");
    setNoteTitle("");
    setNoteParent("");
    setBusy(false);
    setMode("menu");
  };
  const close = () => setMode(null);

  // Escape closes the sheet (matches the app's dialog/palette dismissal).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Autofocus the relevant input when entering a capture step (after the sheet's enter transition).
  useEffect(() => {
    if (mode === "task") setTimeout(() => taskInputRef.current?.focus(), 60);
    if (mode === "note") setTimeout(() => noteInputRef.current?.focus(), 60);
  }, [mode]);

  const folderLabel = useMemo(() => {
    if (!noteParent) return "Vault root";
    return noteParent.split("/").pop() ?? noteParent;
  }, [noteParent]);

  const submitTask = async () => {
    const text = taskText.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onAddTask(text);
      close();
    } finally {
      setBusy(false);
    }
  };

  const submitNote = async () => {
    const title = noteTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await onNewNote(title, noteParent);
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <nav className="mobile-navbar" aria-label="Quick actions">
        <button
          className={`mnav-btn${leftOpen ? " active" : ""}`}
          onClick={onToggleLeft}
          aria-label="Files"
          aria-expanded={leftOpen}
        >
          <SidebarSimple size={22} weight={leftOpen ? "fill" : "regular"} />
          <span className="mnav-label">Files</span>
        </button>

        <button
          className="mnav-fab"
          onClick={openSheet}
          aria-label="Quick capture"
          aria-haspopup="dialog"
        >
          <Plus size={24} weight="bold" />
        </button>

        <button
          className={`mnav-btn${rightOpen ? " active" : ""}`}
          onClick={onToggleRight}
          aria-label="Outline and calendar"
          aria-expanded={rightOpen}
        >
          <SidebarSimple size={22} weight={rightOpen ? "fill" : "regular"} style={{ transform: "scaleX(-1)" }} />
          <span className="mnav-label">Outline</span>
        </button>
      </nav>

      <AnimatePresence>
        {open && (
          <motion.div
            className="sheet-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <motion.div
              ref={sheetRef}
              className="capture-sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Quick capture"
              tabIndex={-1}
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 520, damping: 44 }}
            >
              <div className="sheet-grip" aria-hidden />

              {mode === "menu" && (
                <div className="capture-menu">
                  <header className="sheet-header">
                    <h2 className="sheet-title">Quick capture</h2>
                    <button className="sheet-close" onClick={close} aria-label="Close">
                      <X size={18} weight="bold" />
                    </button>
                  </header>
                  <button className="capture-option" onClick={() => setMode("task")}>
                    <span className="capture-icon task">
                      <CheckSquare size={22} weight="fill" />
                    </span>
                    <span className="capture-text">
                      <span className="capture-name">Task for today</span>
                      <span className="capture-desc">Add a to-do to today's note</span>
                    </span>
                    <CaretRight size={16} className="capture-go" />
                  </button>
                  <button className="capture-option" onClick={() => setMode("note")}>
                    <span className="capture-icon note">
                      <FileText size={22} weight="fill" />
                    </span>
                    <span className="capture-text">
                      <span className="capture-name">New note</span>
                      <span className="capture-desc">Create a page in any folder</span>
                    </span>
                    <CaretRight size={16} className="capture-go" />
                  </button>
                </div>
              )}

              {mode === "task" && (
                <div className="capture-form">
                  <header className="sheet-header">
                    <button className="sheet-back" onClick={() => setMode("menu")} aria-label="Back">
                      <ArrowLeft size={18} weight="bold" />
                    </button>
                    <h2 className="sheet-title">Task for today</h2>
                    <button className="sheet-close" onClick={close} aria-label="Close">
                      <X size={18} weight="bold" />
                    </button>
                  </header>
                  <input
                    ref={taskInputRef}
                    className="capture-input"
                    placeholder="What needs doing?"
                    value={taskText}
                    onChange={(e) => setTaskText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void submitTask();
                      }
                    }}
                  />
                  <button
                    className="capture-submit"
                    onClick={() => void submitTask()}
                    disabled={!taskText.trim() || busy}
                  >
                    <CheckSquare size={18} weight="bold" />
                    Add to Today
                  </button>
                </div>
              )}

              {mode === "note" && (
                <div className="capture-form">
                  <header className="sheet-header">
                    <button className="sheet-back" onClick={() => setMode("menu")} aria-label="Back">
                      <ArrowLeft size={18} weight="bold" />
                    </button>
                    <h2 className="sheet-title">New note</h2>
                    <button className="sheet-close" onClick={close} aria-label="Close">
                      <X size={18} weight="bold" />
                    </button>
                  </header>
                  <input
                    ref={noteInputRef}
                    className="capture-input"
                    placeholder="Note title"
                    value={noteTitle}
                    onChange={(e) => setNoteTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void submitNote();
                      }
                    }}
                  />

                  <label className="capture-field-label">Folder</label>
                  <div className="capture-folders" role="radiogroup" aria-label="Destination folder">
                    <button
                      className={`capture-folder${noteParent === "" ? " selected" : ""}`}
                      role="radio"
                      aria-checked={noteParent === ""}
                      onClick={() => setNoteParent("")}
                    >
                      <House size={16} weight={noteParent === "" ? "fill" : "regular"} />
                      <span>Vault root</span>
                    </button>
                    {folders.map((f) => (
                      <button
                        key={f.path}
                        className={`capture-folder${noteParent === f.path ? " selected" : ""}`}
                        role="radio"
                        aria-checked={noteParent === f.path}
                        style={{ paddingLeft: `calc(var(--sp-3) + ${f.depth * 14}px)` }}
                        onClick={() => setNoteParent(f.path)}
                      >
                        <Folder size={16} weight={noteParent === f.path ? "fill" : "regular"} />
                        <span>{f.path.split("/").pop()}</span>
                      </button>
                    ))}
                  </div>

                  <button
                    className="capture-submit"
                    onClick={() => void submitNote()}
                    disabled={!noteTitle.trim() || busy}
                  >
                    <FileText size={18} weight="bold" />
                    Create in {folderLabel}
                  </button>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
