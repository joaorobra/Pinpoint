import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, MagnifyingGlass, FileText, Graph, ListMagnifyingGlass, X, CaretRight } from "@phosphor-icons/react";
import { api } from "../api";
import type { TagConnection, TagInfo, TagPage } from "../types";

interface Props {
  /** Navigate to a page by its rel_path (click a tagged page). */
  onOpen: (relPath: string) => void;
  /** Open the Query panel pre-seeded to `FROM #tag` (the "Query this tag" action). */
  onQueryTag?: (tag: string) => void;
  /**
   * A tag to select on arrival, set when the user clicks an inline `#tag` pill in the editor. `n`
   * bumps on every request so clicking the same pill twice re-focuses it. Null = keep current.
   */
  focusTag?: { tag: string; n: number } | null;
  /** Bumped by the host to force a reload after the vault changes. */
  refreshKey: number;
}

/**
 * Obsidian-style Tags view. The left rail lists every tag in the vault with its page count; picking
 * one shows, on the right, the pages carrying it and the *other* tags those pages also carry — i.e.
 * how pages connect to each other through shared tags. From here a tag can be sent straight to the
 * Query panel as `FROM #tag`.
 */
export default function TagsView({ onOpen, onQueryTag, focusTag, refreshKey }: Props) {
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pages, setPages] = useState<TagPage[]>([]);
  const [connections, setConnections] = useState<TagConnection[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRowRef = useRef<HTMLButtonElement>(null);

  // Load every tag whenever the vault changes. Keep the current selection if it still exists.
  useEffect(() => {
    api
      .listTags()
      .then((all) => {
        setTags(all);
        setSelected((cur) => (cur && all.some((t) => t.tag === cur) ? cur : all[0]?.tag ?? null));
      })
      .catch(console.error);
  }, [refreshKey]);

  // A pill clicked in the editor: select that tag (clearing any filter so it's visible in the rail).
  useEffect(() => {
    if (!focusTag) return;
    setSelected(focusTag.tag);
    setFilter("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTag?.tag, focusTag?.n]);

  // Load the selected tag's pages + connected tags.
  useEffect(() => {
    if (!selected) {
      setPages([]);
      setConnections([]);
      return;
    }
    let alive = true;
    setLoading(true);
    Promise.all([api.tagPages(selected), api.tagConnections(selected)])
      .then(([p, c]) => {
        if (!alive) return;
        setPages(p);
        setConnections(c);
      })
      .catch(console.error)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selected, refreshKey]);

  // Focus the filter on arrival so the user can start typing immediately.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Keep the selected tag in view when it changes (e.g. clicking an editor pill scrolls it into the rail).
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? tags.filter((t) => t.tag.toLowerCase().includes(q)) : tags;
  }, [tags, filter]);

  // Arrow-key navigation over the (filtered) tag rail; Home/End jump to the ends.
  function onListKeyDown(e: React.KeyboardEvent) {
    if (!shown.length) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const i = shown.findIndex((t) => t.tag === selected);
    let next = i;
    if (e.key === "ArrowDown") next = i < 0 ? 0 : Math.min(i + 1, shown.length - 1);
    else if (e.key === "ArrowUp") next = i < 0 ? shown.length - 1 : Math.max(i - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = shown.length - 1;
    setSelected(shown[next].tag);
  }

  return (
    <div className="panel tags-view">
      <div className="panel-header">
        <h2>Tags</h2>
        <span className="muted tags-count">{tags.length} tag{tags.length === 1 ? "" : "s"}</span>
      </div>

      {tags.length === 0 ? (
        <p className="muted">
          No tags yet. Add <code>#a-tag</code> anywhere in a page, or a <code>tags:</code> list in its
          frontmatter.
        </p>
      ) : (
        <div className="tags-body">
          {/* Left rail: searchable list of every tag. */}
          <aside className="tags-list">
            <div className="tags-search">
              <MagnifyingGlass size={14} />
              <input
                ref={searchRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={onListKeyDown}
                placeholder="Filter tags…"
                spellCheck={false}
                aria-label="Filter tags"
              />
              {filter && (
                <button
                  className="tags-search-clear"
                  onClick={() => {
                    setFilter("");
                    searchRef.current?.focus();
                  }}
                  title="Clear filter"
                  aria-label="Clear filter"
                >
                  <X size={12} weight="bold" />
                </button>
              )}
            </div>
            {filter.trim() && (
              <p className="muted tags-filter-count">
                {shown.length} of {tags.length}
              </p>
            )}
            <ul onKeyDown={onListKeyDown}>
              {shown.map((t) => (
                <li key={t.tag}>
                  <button
                    ref={t.tag === selected ? activeRowRef : undefined}
                    className={`tag-row${t.tag === selected ? " active" : ""}`}
                    onClick={() => setSelected(t.tag)}
                    aria-current={t.tag === selected ? "true" : undefined}
                    title={`#${t.tag} — ${t.count} page${t.count === 1 ? "" : "s"}`}
                  >
                    <Hash size={13} weight="bold" />
                    <span className="tag-name">{t.tag}</span>
                    <span className="tag-count">{t.count}</span>
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="muted tags-empty">No tags match.</li>}
            </ul>
          </aside>

          {/* Right pane: the selected tag's connections + pages. */}
          <section className="tags-detail">
            {selected && (
              <>
                <div className="tags-detail-header">
                  <h3>
                    <Hash size={16} weight="bold" />
                    {selected}
                  </h3>
                  {onQueryTag && (
                    <button className="tag-query-btn" onClick={() => onQueryTag(selected)} title="Open this tag in the Query panel">
                      <ListMagnifyingGlass size={14} /> Query this tag
                    </button>
                  )}
                </div>

                <div className="tags-section">
                  <h4>
                    <Graph size={14} /> Connected tags
                  </h4>
                  {loading ? (
                    <div className="tag-chips" aria-hidden="true">
                      <span className="tag-chip skeleton" style={{ width: 72 }} />
                      <span className="tag-chip skeleton" style={{ width: 96 }} />
                      <span className="tag-chip skeleton" style={{ width: 60 }} />
                    </div>
                  ) : connections.length === 0 ? (
                    <p className="muted">No other tags share these pages yet — connections appear when pages share tags.</p>
                  ) : (
                    <div className="tag-chips">
                      {connections.map((c) => (
                        <button
                          key={c.tag}
                          className="tag-chip"
                          onClick={() => setSelected(c.tag)}
                          title={`#${c.tag} shares ${c.shared} page${c.shared === 1 ? "" : "s"} with #${selected}`}
                        >
                          <Hash size={11} weight="bold" />
                          {c.tag}
                          <span className="tag-chip-count">{c.shared}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="tags-section">
                  <h4>
                    <FileText size={14} /> Pages{loading ? "" : ` (${pages.length})`}
                  </h4>
                  {loading ? (
                    <ul className="tag-pages" aria-hidden="true">
                      {[0, 1, 2].map((i) => (
                        <li key={i}>
                          <span className="tag-page skeleton" />
                        </li>
                      ))}
                    </ul>
                  ) : pages.length === 0 ? (
                    <p className="muted">No pages carry this tag.</p>
                  ) : (
                    <ul className="tag-pages">
                      {pages.map((p) => (
                        <li key={p.rel_path}>
                          <button className="tag-page" onClick={() => onOpen(p.rel_path)} title={p.rel_path}>
                            <FileText size={14} />
                            <span className="tag-page-title">{p.title}</span>
                            <CaretRight size={13} className="tag-page-go" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
