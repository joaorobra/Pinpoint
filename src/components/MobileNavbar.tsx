import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls } from "framer-motion";
import {
  Plus,
  CheckSquare,
  FileText,
  CaretRight,
  ArrowLeft,
  X,
  Folder,
  House,
  MagnifyingGlass,
  SidebarSimple,
} from "@phosphor-icons/react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { haptic } from "../lib/haptics";

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
  /** Open the search & command palette (the persistent search box taps into this). */
  onSearch: () => void;
  /** Append a `- [ ] …` line to today's daily note (created if missing). */
  onAddTask: (text: string) => Promise<void> | void;
  /** Create a new note titled `title` inside `parentRel` ("" = vault root) and open it. */
  onNewNote: (title: string, parentRel: string) => Promise<void> | void;
  /** Every folder in the vault, for the new-note destination picker. */
  folders: FolderOption[];
}

type Mode = "menu" | "task" | "note";

/**
 * Mobile-only floating bottom bar. Its persistent left element is a Search box (tap to open the
 * command palette); the right is the dominant Quick Capture action (＋). The two side panels (Files /
 * Outline) are reached by swiping the editor left/right — the bar shows a chevron hint on each edge
 * that lights up while its drawer is open, and the chevrons remain tappable as a fallback.
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
  onSearch,
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
  // Drag-to-dismiss is initiated only from the grip, so the form's inputs and the scrollable folder
  // list stay fully interactive (a body-wide drag would swallow taps and vertical scrolls).
  const dragControls = useDragControls();
  const taskInputRef = useRef<HTMLInputElement>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(sheetRef, mode !== null);

  const open = mode !== null;

  // Reset the form each time the sheet opens fresh from the bar (not on internal step changes).
  const openSheet = () => {
    haptic("impact");
    setTaskText("");
    setNoteTitle("");
    setNoteParent("");
    setBusy(false);
    setMode("menu");
  };
  const close = () => setMode(null);

  // Drawer toggles (the chevron hints) get a light tick so the bar feels physical under the thumb.
  const handleToggleLeft = () => {
    haptic("tap");
    onToggleLeft();
  };
  const handleToggleRight = () => {
    haptic("tap");
    onToggleRight();
  };
  const handleSearch = () => {
    haptic("tap");
    onSearch();
  };

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
      haptic("success");
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
      haptic("success");
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <nav className="mobile-navbar" aria-label="Quick actions">
        {/* Left edge: swipe-hint chevron for the Files drawer. Lights up while that drawer is open;
            still tappable as a fallback for the swipe gesture. */}
        <button
          className={`mnav-edge mnav-edge-l${leftOpen ? " active" : ""}`}
          onClick={handleToggleLeft}
          aria-label="Files panel"
          aria-expanded={leftOpen}
        >
          <SidebarSimple size={20} weight={leftOpen ? "fill" : "regular"} />
        </button>

        {/* The persistent search box — the bar's primary, always-visible element. Tapping it opens
            the search & command palette. A button (not a real input) so the native palette owns focus
            and the on-screen keyboard, but it reads and behaves as a search field. */}
        <button
          className="mnav-search"
          onClick={handleSearch}
          aria-label="Search"
          aria-keyshortcuts="Control+K"
        >
          <MagnifyingGlass size={18} weight="bold" className="mnav-search-ico" />
          <span className="mnav-search-text">Search…</span>
        </button>

        {/* Right edge: swipe-hint chevron for the Outline drawer. */}
        <button
          className={`mnav-edge mnav-edge-r${rightOpen ? " active" : ""}`}
          onClick={handleToggleRight}
          aria-label="Outline panel"
          aria-expanded={rightOpen}
        >
          <SidebarSimple size={20} weight={rightOpen ? "fill" : "regular"} style={{ transform: "scaleX(-1)" }} />
        </button>

        {/* The dominant Quick Capture action, raised and ringed so it floats above the bar. */}
        <button
          className="mnav-fab"
          onClick={openSheet}
          aria-label="Quick capture"
          aria-haspopup="dialog"
        >
          <Plus size={26} weight="bold" />
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
              // Drag down to dismiss — the native bottom-sheet gesture, started only from the grip
              // (see onPointerDown below) so inputs and the folder list keep their own touch handling.
              // Resists upward pull (constraint top: 0) and snaps back unless flung past a threshold.
              drag="y"
              dragControls={dragControls}
              dragListener={false}
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.6 }}
              onDragEnd={(_, info) => {
                if (info.offset.y > 120 || info.velocity.y > 600) {
                  haptic("tap");
                  close();
                }
              }}
            >
              <div
                className="sheet-grip-zone"
                onPointerDown={(e) => dragControls.start(e)}
              >
                <div className="sheet-grip" aria-hidden />
              </div>

              {mode === "menu" && (
                <div className="capture-menu">
                  <header className="sheet-header">
                    <h2 className="sheet-title">Quick capture</h2>
                    <button className="sheet-close" onClick={close} aria-label="Close">
                      <X size={18} weight="bold" />
                    </button>
                  </header>
                  <button className="capture-option" onClick={() => { haptic("select"); setMode("task"); }}>
                    <span className="capture-icon task">
                      <CheckSquare size={22} weight="fill" />
                    </span>
                    <span className="capture-text">
                      <span className="capture-name">Task for today</span>
                      <span className="capture-desc">Add a to-do to today's note</span>
                    </span>
                    <CaretRight size={16} className="capture-go" />
                  </button>
                  <button className="capture-option" onClick={() => { haptic("select"); setMode("note"); }}>
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
                      onClick={() => { haptic("select"); setNoteParent(""); }}
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
                        onClick={() => { haptic("select"); setNoteParent(f.path); }}
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
