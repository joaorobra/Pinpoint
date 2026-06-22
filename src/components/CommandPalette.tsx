import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  MagnifyingGlass,
  FileText,
  Plus,
  ArrowsClockwise,
  GearSix,
  FolderOpen,
  ArrowElbowDownLeft,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { fuzzyScore } from "../fuzzy";
import { transition, slideFade } from "../motion";

/** A page the palette can jump to. */
export interface PalettemPage {
  name: string;
  rel_path: string;
}

/** An action the palette can run (new page, settings, …). */
export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  icon: PhosphorIcon;
  run: () => void;
}

interface Props {
  pages: PalettemPage[];
  actions: PaletteAction[];
  /** Open the page at this rel_path. */
  onOpenPage: (relPath: string) => void;
  onClose: () => void;
}

/** A flattened, rankable palette entry — either a page jump or a command. */
type Entry =
  | { kind: "page"; key: string; label: string; sub: string; icon: PhosphorIcon; run: () => void }
  | { kind: "action"; key: string; label: string; sub: string; icon: PhosphorIcon; run: () => void };

/**
 * Cmd/Ctrl+K command palette. Fuzzy-searches the vault's pages and a small set of global actions,
 * keyboard-driven (↑/↓ to move, Enter to run, Esc to close). Reuses the same `fuzzyScore` ranking
 * as the editor's slash/wikilink menus so matching feels consistent across the app.
 */
export default function CommandPalette({ pages, actions, onOpenPage, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const entries = useMemo<Entry[]>(() => {
    const actionEntries: Entry[] = actions.map((a) => ({
      kind: "action",
      key: "a:" + a.id,
      label: a.label,
      sub: a.hint ?? "Command",
      icon: a.icon,
      run: a.run,
    }));
    const pageEntries: Entry[] = pages.map((p) => ({
      kind: "page",
      key: "p:" + p.rel_path,
      label: p.name,
      sub: p.rel_path,
      icon: FileText,
      run: () => onOpenPage(p.rel_path),
    }));

    const q = query.trim();
    if (!q) {
      // Empty query: show actions first, then a slice of pages so the palette is never blank.
      return [...actionEntries, ...pageEntries.slice(0, 50)];
    }
    // Rank everything by the best score across its label and sub-text, drop non-matches.
    return [...actionEntries, ...pageEntries]
      .map((e) => ({ e, s: Math.max(fuzzyScore(q, e.label), fuzzyScore(q, e.sub) - 1) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.e);
  }, [query, pages, actions, onOpenPage]);

  // Keep the selection in range as the result set shrinks.
  useEffect(() => {
    setIndex(0);
  }, [query]);

  // Scroll the active row into view as the user arrows through.
  useEffect(() => {
    const list = listRef.current;
    const el = list?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (entries.length ? (i + 1) % entries.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (entries.length ? (i - 1 + entries.length) % entries.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(entries[Math.min(index, entries.length - 1)]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <motion.div
      className="palette-backdrop"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={transition("fast")}
    >
      <motion.div
        className="palette"
        onClick={(e) => e.stopPropagation()}
        {...slideFade({ axis: "y", distance: -8, scale: 0.98, speed: "fast" })}
      >
        <div className="palette-search">
          <MagnifyingGlass size={18} className="palette-search-icon" />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="Jump to a page or run a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {entries.length === 0 ? (
            <div className="palette-empty">No matches</div>
          ) : (
            entries.map((entry, i) => {
              const Ico = entry.icon;
              return (
                <button
                  key={entry.key}
                  className={`palette-item${i === index ? " active" : ""}`}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => run(entry)}
                >
                  <span className="palette-item-icon"><Ico size={17} /></span>
                  <span className="palette-item-text">
                    <span className="palette-item-label">{entry.label}</span>
                    <span className="palette-item-sub">{entry.sub}</span>
                  </span>
                  {i === index && <ArrowElbowDownLeft size={14} className="palette-item-enter" />}
                </button>
              );
            })
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// Re-exported so the host can build action lists with familiar glyphs without re-importing Phosphor.
export const PaletteIcons = { Plus, ArrowsClockwise, GearSix, FolderOpen };
