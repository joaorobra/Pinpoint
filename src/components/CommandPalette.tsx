import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  MagnifyingGlass,
  FileText,
  TextAa,
  Plus,
  ArrowsClockwise,
  GearSix,
  FolderOpen,
  ArrowElbowDownLeft,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { fuzzyScore } from "../fuzzy";
import { api } from "../api";
import type { SearchHit } from "../types";
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

/** A flattened, rankable palette entry — a page jump, a command, or a body-content hit. */
type Entry =
  | { kind: "page"; key: string; label: string; sub: string; icon: PhosphorIcon; run: () => void }
  | { kind: "action"; key: string; label: string; sub: string; icon: PhosphorIcon; run: () => void }
  | { kind: "hit"; key: string; label: string; sub: string; snippet: string; icon: PhosphorIcon; run: () => void };

/** Escape a string for safe use inside a RegExp (search terms are arbitrary user text). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wrap each occurrence of the query's terms in a snippet with <mark> so the matched words stand
 * out. Splits the query on whitespace (mirrors the backend's AND-of-terms matching) and matches
 * case-insensitively. Returns an array of strings/elements suitable for rendering inline.
 */
function highlight(text: string, query: string): React.ReactNode {
  const terms = query.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (terms.length === 0) return text;
  // Split on the terms with a capturing group so matches land on odd indices; `split` returns the
  // captured delimiters interleaved with the surrounding text, so we don't need a stateful `.test`.
  const re = new RegExp(`(${terms.join("|")})`, "ig");
  const lc = new Set(terms.map((t) => t.toLowerCase().replace(/\\(.)/g, "$1")));
  return text.split(re).map((part, i) =>
    lc.has(part.toLowerCase()) ? <mark key={i} className="palette-mark">{part}</mark> : part
  );
}

/**
 * Cmd/Ctrl+K command palette. Fuzzy-searches the vault's pages and a small set of global actions,
 * and runs a full-text search across every `.md` body so typed words also surface pages that
 * mention them. Keyboard-driven (↑/↓ to move, Enter to run, Esc to close). Reuses the same
 * `fuzzyScore` ranking as the editor's slash/wikilink menus so matching feels consistent.
 */
export default function CommandPalette({ pages, actions, onOpenPage, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // Body-content matches for the current query, fetched async from the backend (debounced).
  const [hits, setHits] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Full-text search across every `.md` body in the vault. Debounced so each keystroke doesn't hit
  // the index, and guarded so a slow response for a stale query can't overwrite a newer one.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .searchPages(q)
        .then((r) => {
          if (!cancelled) setHits(r);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

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
    // Rank actions + pages by the best fuzzy score across label and sub-text, drop non-matches.
    const ranked = [...actionEntries, ...pageEntries]
      .map((e) => ({ e, s: Math.max(fuzzyScore(q, e.label), fuzzyScore(q, e.sub) - 1) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.e);

    // Append body-content hits below the name/path matches, skipping pages already shown above so
    // the same page isn't listed twice. This is what lets Ctrl+K find text *inside* any `.md` file.
    const shownPaths = new Set(ranked.filter((e) => e.kind === "page").map((e) => e.key));
    const hitEntries: Entry[] = hits
      .filter((h) => !shownPaths.has("p:" + h.rel_path))
      .map((h) => ({
        kind: "hit",
        key: "h:" + h.rel_path,
        label: h.title,
        sub: h.rel_path,
        snippet: h.snippet,
        icon: FileText,
        run: () => onOpenPage(h.rel_path),
      }));

    return [...ranked, ...hitEntries];
  }, [query, pages, actions, hits, onOpenPage]);

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
    } else if (e.key === "Tab") {
      // The palette is fully arrow-driven; trap Tab so focus can't escape to the page behind the
      // modal. Keeping focus on the input means ↑/↓/Enter stay live no matter what.
      e.preventDefault();
      inputRef.current?.focus();
    }
  };

  return (
    <motion.div
      className="palette-backdrop"
      onMouseDown={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={transition("fast")}
    >
      <motion.div
        ref={panelRef}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        {...slideFade({ axis: "y", distance: -8, scale: 0.98, speed: "fast" })}
      >
        <div className="palette-search">
          <MagnifyingGlass size={18} className="palette-search-icon" />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="Search pages and their contents, or run a command…"
            aria-label="Search pages and commands"
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
              // Header above the first content hit, separating "found inside pages" from name matches.
              const firstHit = entry.kind === "hit" && (i === 0 || entries[i - 1].kind !== "hit");
              return (
                <div key={entry.key} className="palette-row">
                  {firstHit && (
                    <div className="palette-section">
                      <TextAa size={12} /> Found in pages
                    </div>
                  )}
                  <button
                    className={`palette-item${i === index ? " active" : ""}`}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => run(entry)}
                  >
                    <span className="palette-item-icon"><Ico size={17} /></span>
                    <span className="palette-item-text">
                      <span className="palette-item-label">{entry.label}</span>
                      {entry.kind === "hit" && entry.snippet ? (
                        <span className="palette-item-snippet">{highlight(entry.snippet, query)}</span>
                      ) : (
                        <span className="palette-item-sub">{entry.sub}</span>
                      )}
                    </span>
                    {i === index && <ArrowElbowDownLeft size={14} className="palette-item-enter" />}
                  </button>
                </div>
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
