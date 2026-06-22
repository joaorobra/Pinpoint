// Database view shell.
//
// A "database" is a folder holding a `.pinpoint-db.json` schema; each row is a `.md` file inside it
// whose frontmatter carries the structured field values (keyed by column id). The `title` column is
// the file's name, not a frontmatter field.
//
// This shell owns the schema + the loaded rows and renders:
//   - a row of saved VIEW tabs (table / board / calendar / gallery), each with its own filters,
//     sorts, grouping and per-property visibility;
//   - a toolbar (Filter / Sort / Layout / Properties) that edits the active view;
//   - the active view component, fed rows already filtered + sorted and columns already pared to the
//     view's visible set.
// All edits persist to disk: cell values via `writePage`, the title via a file rename, schema +
// view config via `writeDbSchema`.

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus, Table, Kanban, CalendarBlank, Cards, DotsSixVertical, X, Trash, PencilSimple, Smiley,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type {
  DbColumn, DbColumnType, DbSchema, DbView, DbViewType, NodeIcon, TreeNode,
} from "../types";
import { api } from "../api";
import { dialogs } from "./Dialogs";
import type { DbRow } from "../dblogic";
import { applyFilters, applySorts } from "../dblogic";
import { makeId, safeLeaf, TYPE_META } from "./DbShared";
import { NodeIconView } from "./Icon";
import DbTableView from "./DbTableView";
import DbBoardView from "./DbBoardView";
import DbCalendarView from "./DbCalendarView";
import DbGalleryView from "./DbGalleryView";
import DbToolbar from "./DbToolbar";

// Lazy so the heavy icon registry only loads when the user actually picks a column/view icon.
const IconPicker = lazy(() => import("./IconPicker"));

interface Props {
  node: TreeNode;
  reloadKey?: string;
  onOpenRow?: (relPath: string) => void;
  onTreeChange?: () => void;
  dateFormat?: string;
  /** Per-node custom page icons, keyed by vault-relative path (so rows can show their icon). */
  nodeIcons?: Record<string, NodeIcon>;
}

const VIEW_TYPE_META: { type: DbViewType; label: string; icon: PhosphorIcon }[] = [
  { type: "table", label: "Table", icon: Table },
  { type: "board", label: "Board", icon: Kanban },
  { type: "calendar", label: "Calendar", icon: CalendarBlank },
  { type: "gallery", label: "Gallery", icon: Cards },
];
const viewIcon = (t: DbViewType): PhosphorIcon => VIEW_TYPE_META.find((v) => v.type === t)?.icon ?? Table;

/** A schema always has at least one view; synthesize a default table view for legacy databases. */
function ensureViews(schema: DbSchema): DbView[] {
  if (schema.views && schema.views.length) return schema.views;
  return [{ id: "view_default", name: "Table", type: "table", filters: [], sorts: [] }];
}

export default function DatabaseView({ node, reloadKey, onOpenRow, onTreeChange, dateFormat = "YYYY-MM-DD", nodeIcons }: Props) {
  const [schema, setSchema] = useState<DbSchema | null>(null);
  const [rows, setRows] = useState<DbRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeViewId, setActiveViewId] = useState<string>("");
  // Icon picker target: a column id or a view id (disambiguated by `kind`).
  const [iconTarget, setIconTarget] = useState<{ kind: "col" | "view"; id: string; label: string; current?: NodeIcon } | null>(null);

  const dir = node.rel_path;

  // ---- Load --------------------------------------------------------------------------------
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.readDbSchema(dir);
      if (!s.columns.some((c) => c.type === "title")) s.columns.unshift({ id: "name", name: "Name", type: "title" });
      s.views = ensureViews(s);
      setSchema(s);
      setActiveViewId((prev) => (s.views!.some((v) => v.id === prev) ? prev : s.views![0].id));
      const rowNodes = node.children.filter((c) => !c.is_dir && c.ext === "");
      const loaded = await Promise.all(
        rowNodes.map(async (rn): Promise<DbRow> => {
          let fields: Record<string, unknown> = {};
          try {
            const doc = await api.readPage(rn.rel_path);
            fields = (doc.frontmatter as Record<string, unknown>) ?? {};
          } catch { /* unreadable row — show it empty */ }
          return { rel_path: rn.rel_path, title: rn.name.replace(/\.md$/i, ""), fields };
        })
      );
      loaded.sort((a, b) => a.title.localeCompare(b.title));
      setRows(loaded);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [dir, node.children]);

  useEffect(() => { void load(); }, [load, reloadKey]);

  // ---- Schema persistence ------------------------------------------------------------------
  const saveSchema = useCallback(async (next: DbSchema) => {
    setSchema(next);
    try { await api.writeDbSchema(dir, next); } catch (e) { console.error(e); }
  }, [dir]);

  const activeView = useMemo(
    () => schema?.views?.find((v) => v.id === activeViewId) ?? schema?.views?.[0] ?? null,
    [schema, activeViewId]
  );

  const updateView = useCallback((patch: Partial<DbView>) => {
    if (!schema || !activeView) return;
    void saveSchema({ ...schema, views: schema.views!.map((v) => (v.id === activeView.id ? { ...v, ...patch } : v)) });
  }, [schema, activeView, saveSchema]);

  const addView = useCallback((type: DbViewType) => {
    if (!schema) return;
    const label = VIEW_TYPE_META.find((v) => v.type === type)?.label ?? "View";
    const v: DbView = { id: makeId("view"), name: label, type, filters: [], sorts: [] };
    void saveSchema({ ...schema, views: [...schema.views!, v] });
    setActiveViewId(v.id);
  }, [schema, saveSchema]);

  const renameView = useCallback(async (v: DbView) => {
    const name = await dialogs.prompt({ title: "Rename view", defaultValue: v.name });
    if (!name?.trim() || !schema) return;
    void saveSchema({ ...schema, views: schema.views!.map((x) => (x.id === v.id ? { ...x, name: name.trim() } : x)) });
  }, [schema, saveSchema]);

  const deleteView = useCallback(async (v: DbView) => {
    if (!schema || schema.views!.length <= 1) return;
    const ok = await dialogs.confirm({ title: "Delete view", message: `Delete the “${v.name}” view? Rows are not affected.`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    const views = schema.views!.filter((x) => x.id !== v.id);
    void saveSchema({ ...schema, views });
    if (activeViewId === v.id) setActiveViewId(views[0].id);
  }, [schema, activeViewId, saveSchema]);

  // ---- Column mutations --------------------------------------------------------------------
  const addColumn = useCallback((type: DbColumnType) => {
    if (!schema) return;
    const label =
      type === "title" ? "Name" : TYPE_META.find((t) => t.type === type)?.label ?? type;
    const col: DbColumn = {
      id: makeId("col"), name: label, type,
      ...(type === "select" || type === "multiselect" ? { options: [] } : {}),
      ...(type === "currency" ? { currency: "USD" } : {}),
    };
    void saveSchema({ ...schema, columns: [...schema.columns, col] });
  }, [schema, saveSchema]);

  const updateColumn = useCallback((id: string, patch: Partial<DbColumn>) => {
    if (!schema) return;
    void saveSchema({ ...schema, columns: schema.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  }, [schema, saveSchema]);

  const changeColumnType = useCallback((id: string, type: DbColumnType) => {
    if (!schema) return;
    void saveSchema({
      ...schema,
      columns: schema.columns.map((c) => c.id === id ? {
        ...c, type,
        options: type === "select" || type === "multiselect" ? c.options ?? [] : undefined,
        currency: type === "currency" ? c.currency ?? "USD" : undefined,
      } : c),
    });
  }, [schema, saveSchema]);

  const deleteColumn = useCallback(async (id: string) => {
    if (!schema) return;
    const col = schema.columns.find((c) => c.id === id);
    if (col?.type === "title") return;
    const ok = await dialogs.confirm({ title: "Delete property", message: `Delete the “${col?.name}” property?`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    void saveSchema({ ...schema, columns: schema.columns.filter((c) => c.id !== id) });
  }, [schema, saveSchema]);

  const moveColumn = useCallback((id: string, delta: number) => {
    if (!schema) return;
    const i = schema.columns.findIndex((c) => c.id === id);
    const j = i + delta;
    if (i < 0 || j < 1 || j >= schema.columns.length) return;
    const cols = [...schema.columns];
    [cols[i], cols[j]] = [cols[j], cols[i]];
    void saveSchema({ ...schema, columns: cols });
  }, [schema, saveSchema]);

  // ---- Row mutations -----------------------------------------------------------------------
  const writeRowFields = useCallback(async (rel: string, fields: Record<string, unknown>) => {
    try {
      const doc = await api.readPage(rel);
      await api.writePage(rel, fields, doc.body);
    } catch (e) { console.error(e); }
  }, []);

  const setCell = useCallback((rowPath: string, colId: string, value: unknown) => {
    setRows((prev) => prev.map((r) => {
      if (r.rel_path !== rowPath) return r;
      const fields = { ...r.fields };
      if (value === "" || value === null || value === undefined || (Array.isArray(value) && value.length === 0)) delete fields[colId];
      else fields[colId] = value;
      void writeRowFields(rowPath, fields);
      return { ...r, fields };
    }));
  }, [writeRowFields]);

  const addRow = useCallback(async (preset?: Record<string, unknown>) => {
    const existing = new Set(rows.map((r) => r.title.toLowerCase()));
    let leaf = "Untitled"; let n = 1;
    while (existing.has(leaf.toLowerCase())) leaf = `Untitled ${++n}`;
    const rel = `${dir}/${leaf}.md`;
    try {
      await api.createPage(rel, "");
      if (preset && Object.keys(preset).length) await writeRowFields(rel, preset);
      onTreeChange?.();
      setRows((prev) => [...prev, { rel_path: rel, title: leaf, fields: preset ?? {} }]);
    } catch (e) { console.error(e); }
  }, [rows, dir, onTreeChange, writeRowFields]);

  const deleteRow = useCallback(async (row: DbRow) => {
    const ok = await dialogs.confirm({ title: "Delete row", message: `Move “${row.title}” to trash?`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await api.trashPage(row.rel_path);
      onTreeChange?.();
      setRows((prev) => prev.filter((r) => r.rel_path !== row.rel_path));
    } catch (e) { console.error(e); }
  }, [onTreeChange]);

  const renameRow = useCallback(async (row: DbRow, rawTitle: string) => {
    const title = safeLeaf(rawTitle);
    if (!title || title === row.title) return;
    const slash = row.rel_path.lastIndexOf("/");
    const parent = slash >= 0 ? row.rel_path.slice(0, slash) : "";
    const toRel = `${parent ? parent + "/" : ""}${title}.md`;
    if (rows.some((r) => r.rel_path !== row.rel_path && r.rel_path === toRel)) return;
    try {
      await api.renamePath(row.rel_path, toRel);
      onTreeChange?.();
      setRows((prev) => prev.map((r) => (r.rel_path === row.rel_path ? { ...r, rel_path: toRel, title } : r)));
    } catch (e) { console.error(e); }
  }, [rows, onTreeChange]);

  // ---- Derived: visible columns + filtered/sorted rows for the active view -----------------
  const visibleColumns = useMemo(() => {
    if (!schema || !activeView) return [];
    const hidden = new Set((activeView.properties ?? []).filter((p) => p.hidden).map((p) => p.columnId));
    // Title is always visible. Preserve schema column order.
    return schema.columns.filter((c) => c.type === "title" || !hidden.has(c.id));
  }, [schema, activeView]);

  // Resolve a row's custom page icon (from the global node-icon map) by its file path.
  const rowIcon = useCallback((relPath: string): NodeIcon | undefined => nodeIcons?.[relPath], [nodeIcons]);
  // Page icons show unless the view has explicitly turned them off.
  const showPageIcon = activeView?.showPageIcon !== false;

  const viewRows = useMemo(() => {
    if (!schema || !activeView) return rows;
    const filtered = applyFilters(rows, activeView.filters, schema.columns, activeView.filterMatch ?? "all");
    return applySorts(filtered, activeView.sorts, schema.columns);
  }, [rows, schema, activeView]);

  if (loading || !schema || !activeView) return <div className="db-view db-loading">Loading database…</div>;

  return (
    <div className="db-view">
      <div className="db-header-bar">
        <h1 className="db-title">{schema.name || node.name}</h1>
        <span className="db-count">{viewRows.length} of {rows.length}</span>
      </div>

      {/* View tabs */}
      <div className="db-view-tabs">
        {schema.views!.map((v) => {
          const Ico = viewIcon(v.type);
          const active = v.id === activeView.id;
          return (
            <div key={v.id} className={`db-view-tab${active ? " active" : ""}`} onClick={() => setActiveViewId(v.id)}>
              <span className="db-view-tab-icon">
                {v.icon ? <NodeIconView icon={v.icon} fallback={Ico} size={14} /> : <Ico size={14} />}
              </span>
              <span className="db-view-tab-name">{v.name}</span>
              {active && (
                <span className="db-view-tab-actions">
                  <button title="Set view icon" onClick={(e) => { e.stopPropagation(); setIconTarget({ kind: "view", id: v.id, label: v.name, current: v.icon }); }}><Smiley size={13} /></button>
                  <button title="Rename view" onClick={(e) => { e.stopPropagation(); void renameView(v); }}><PencilSimple size={13} /></button>
                  {schema.views!.length > 1 && (
                    <button title="Delete view" onClick={(e) => { e.stopPropagation(); void deleteView(v); }}><X size={13} /></button>
                  )}
                </span>
              )}
            </div>
          );
        })}
        <AddViewButton onAdd={addView} />
      </div>

      {/* Toolbar */}
      <DbToolbar view={activeView} columns={schema.columns} onUpdateView={updateView} />

      {/* Active view */}
      <div className="db-view-body">
        {activeView.type === "table" && (
          <DbTableView
            columns={visibleColumns}
            rows={viewRows}
            view={activeView}
            dateFormat={dateFormat}
            showPageIcon={showPageIcon}
            rowIcon={rowIcon}
            onUpdateView={updateView}
            onSetCell={setCell}
            onRenameRow={renameRow}
            onOpenRow={(p) => onOpenRow?.(p)}
            onDeleteRow={deleteRow}
            onAddRow={() => addRow()}
            onUpdateColumn={updateColumn}
            onChangeColumnType={changeColumnType}
            onDeleteColumn={deleteColumn}
            onMoveColumn={moveColumn}
            onAddColumn={addColumn}
            onPickColumnIcon={(col) => setIconTarget({ kind: "col", id: col.id, label: col.name, current: col.icon })}
          />
        )}
        {activeView.type === "board" && (
          <DbBoardView
            columns={visibleColumns} allColumns={schema.columns} rows={viewRows} view={activeView} dateFormat={dateFormat}
            onSetCell={setCell} onOpenRow={(p) => onOpenRow?.(p)} onAddRow={addRow}
          />
        )}
        {activeView.type === "calendar" && (
          <DbCalendarView
            allColumns={schema.columns} rows={viewRows} view={activeView}
            onOpenRow={(p) => onOpenRow?.(p)} onAddRow={addRow}
          />
        )}
        {activeView.type === "gallery" && (
          <DbGalleryView
            columns={visibleColumns} allColumns={schema.columns} rows={viewRows} view={activeView} dateFormat={dateFormat}
            showPageIcon={showPageIcon} rowIcon={rowIcon}
            onOpenRow={(p) => onOpenRow?.(p)} onAddRow={() => addRow()}
          />
        )}
      </div>

      {iconTarget && (
        <Suspense fallback={null}>
          <IconPicker
            targetLabel={iconTarget.label}
            current={iconTarget.current}
            onPick={(icon) => {
              if (iconTarget.kind === "col") updateColumn(iconTarget.id, { icon });
              else updateView({ icon }); // active view
              setIconTarget(null);
            }}
            onRemove={() => {
              if (iconTarget.kind === "col") updateColumn(iconTarget.id, { icon: undefined });
              else updateView({ icon: undefined });
              setIconTarget(null);
            }}
            onClose={() => setIconTarget(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

function AddViewButton({ onAdd }: { onAdd: (t: DbViewType) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="db-add-view-wrap">
      <button className="db-add-view" title="Add view" onClick={() => setOpen((o) => !o)} onBlur={() => setTimeout(() => setOpen(false), 150)}>
        <Plus size={14} weight="bold" />
      </button>
      {open && (
        <div className="db-add-view-menu">
          {VIEW_TYPE_META.map((v) => {
            const Ico = v.icon;
            return (
              <button key={v.type} onMouseDown={(e) => { e.preventDefault(); onAdd(v.type); setOpen(false); }}>
                <Ico size={15} /> {v.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Keep the grip glyph exported for a future drag-reorder of views/columns.
export const DbIcons = { DotsSixVertical, Trash };
