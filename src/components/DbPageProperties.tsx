// Properties panel shown at the top of the markdown editor when the open page is a row of a
// database (i.e. a `.md` file living inside a `.pinpoint-db.json` folder).
//
// It mirrors Notion: a page inside a database carries the database's columns as structured
// properties, editable inline right above the document body. The cell editors are the exact same
// ones the table view uses (DbShared's `DbCell`), so editing behaves identically everywhere.
//
// The panel is self-loading: given the DB folder path it reads the schema once, then renders one
// labelled row per (non-title) column. Edits persist via the parent (which owns the page's
// frontmatter + save loop), so a property change and a body change never clobber each other.

import { useEffect, useMemo, useState } from "react";
import type { DbColumn, DbSchema } from "../types";
import type { DbRow } from "../dblogic";
import { api } from "../api";
import { DbCell, typeIcon } from "./DbShared";
import { NodeIconView } from "./Icon";

interface Props {
  /** The parent database folder's vault-relative path (where `.pinpoint-db.json` lives). */
  dbPath: string;
  /** The open page's vault-relative path (a row file inside `dbPath`). */
  pagePath: string;
  /** The page's current frontmatter (keyed by column id), owned by the parent. */
  frontmatter: Record<string, unknown>;
  /** Persist a changed frontmatter map for this page (parent updates its state + writes to disk). */
  onChange: (fields: Record<string, unknown>) => void;
  /** Pattern for rendering date values (mirrors the table view). */
  dateFormat: string;
  /** Rename the page file to a new title (the title "property" is the file name, not frontmatter). */
  onRenameTitle?: (title: string) => void;
}

export default function DbPageProperties({
  dbPath,
  pagePath,
  frontmatter,
  onChange,
  dateFormat,
  onRenameTitle,
}: Props) {
  const [schema, setSchema] = useState<DbSchema | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Load the parent database's schema once per database folder. The frontmatter itself comes from
  // the parent (already loaded with the page), so we never re-read the page here.
  useEffect(() => {
    let cancelled = false;
    setSchema(null);
    api
      .readDbSchema(dbPath)
      .then((s) => {
        if (cancelled) return;
        // Legacy databases may lack an explicit title column; the table view synthesizes one too.
        if (!s.columns.some((c) => c.type === "title")) {
          s.columns = [{ id: "name", name: "Name", type: "title" }, ...s.columns];
        }
        setSchema(s);
      })
      .catch(() => {
        if (!cancelled) setSchema({ name: "", columns: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [dbPath]);

  // The row shape the cell editors expect: title is the file leaf, fields are the frontmatter.
  const title = useMemo(
    () => (pagePath.split("/").pop() ?? pagePath).replace(/\.md$/i, ""),
    [pagePath]
  );
  const row: DbRow = useMemo(
    () => ({ rel_path: pagePath, title, fields: frontmatter }),
    [pagePath, title, frontmatter]
  );

  // Editable, non-title columns. The title is the page's H1/file name and is edited in the doc, so
  // we don't repeat it as a property row.
  const propColumns = useMemo<DbColumn[]>(
    () => (schema?.columns ?? []).filter((c) => c.type !== "title"),
    [schema]
  );

  // Apply a single cell edit to the frontmatter map, dropping keys that become empty (matching the
  // table view's `setCell`), then hand the whole map back to the parent to persist.
  const setCell = (colId: string, value: unknown) => {
    const fields = { ...frontmatter };
    if (
      value === "" ||
      value === null ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0)
    ) {
      delete fields[colId];
    } else {
      fields[colId] = value;
    }
    onChange(fields);
  };

  // Nothing to show until the schema resolves, or when the database has no editable properties yet.
  if (!schema) return null;
  if (propColumns.length === 0) return null;

  return (
    <div className="db-props">
      <button
        className="db-props-toggle"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className={`db-props-caret${collapsed ? " collapsed" : ""}`}>▾</span>
        {collapsed ? `${propColumns.length} properties` : "Properties"}
      </button>
      {!collapsed && (
        <div className="db-props-grid">
          {propColumns.map((col) => {
            const Ico = typeIcon(col.type);
            return (
              <div className="db-props-row" key={col.id}>
                <span className="db-props-label" title={col.name}>
                  <span className="db-props-label-icon">
                    {col.icon ? <NodeIconView icon={col.icon} fallback={Ico} size={15} /> : <Ico size={15} />}
                  </span>
                  <span className="db-props-label-text">{col.name}</span>
                </span>
                <span className="db-props-value">
                  <DbCell
                    col={col}
                    row={row}
                    dateFormat={dateFormat}
                    onChange={(v) => setCell(col.id, v)}
                    onRenameTitle={(t) => onRenameTitle?.(t)}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
