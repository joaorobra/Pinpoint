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
  Plus, Table, Kanban, CalendarBlank, Cards, DotsSixVertical, Trash, Database,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type {
  DbColumn, DbColumnType, DbSchema, DbView, DbViewType, NodeIcon, TreeNode,
} from "../types";
import { api } from "../api";
import { dialogs } from "./Dialogs";
import type { DbRow } from "../dblogic";
import { applyFilters, applySorts } from "../dblogic";
import { makeId, safeLeaf, TYPE_META, useDismiss } from "./DbShared";
import { NodeIconView } from "./Icon";
import TemplateMenu from "./TemplateMenu";
import PageTitle from "./PageTitle";
import { stripCursor, type TemplateInfo, type FillContext } from "../templates";
import { CaretDown } from "@phosphor-icons/react";
import DbTableView from "./DbTableView";
import DbBoardView from "./DbBoardView";
import DbCalendarView from "./DbCalendarView";
import DbGalleryView from "./DbGalleryView";
import DbToolbar from "./DbToolbar";
import ViewTabMenu from "./ViewTabMenu";
import { useViewport } from "../hooks/useViewport";

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
  /** Set a row page's custom icon (persists to the global node-icon map). */
  onSetNodeIcon?: (relPath: string, icon: NodeIcon) => void;
  /** Clear a row page's custom icon override. */
  onClearNodeIcon?: (relPath: string) => void;
  /** Templates available for the "+ New ▾" menu (vault Templates folder). */
  templates?: TemplateInfo[];
  /** Read + variable-fill a template; returns its body/frontmatter or null if cancelled. */
  onApplyTemplate?: (relPath: string, extra?: Partial<FillContext>) => Promise<{ body: string; frontmatter: Record<string, unknown> } | null>;
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

export default function DatabaseView({ node, reloadKey, onOpenRow, onTreeChange, dateFormat = "YYYY-MM-DD", nodeIcons, onSetNodeIcon, onClearNodeIcon, templates = [], onApplyTemplate }: Props) {
  const { isMobile } = useViewport();
  const [schema, setSchema] = useState<DbSchema | null>(null);
  const [rows, setRows] = useState<DbRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Set when the schema can't be read/parsed, so we surface a retry instead of hanging on "Loading…".
  const [error, setError] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<string>("");
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  // Icon picker target, disambiguated by `kind`: a column id, the active view, or a row page
  // (where `id` is the page's vault-relative path).
  const [iconTarget, setIconTarget] = useState<{ kind: "col" | "view" | "page" | "db"; id: string; label: string; current?: NodeIcon } | null>(null);
  // Whether the "+ New ▾" template menu is open in the header bar.
  const [newMenu, setNewMenu] = useState(false);

  const dir = node.rel_path;

  // ---- Load --------------------------------------------------------------------------------
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
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
      setError(String(e));
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

  // Rename is edited in place on the tab: the menu just flips the active tab's name into an input.
  const commitRenameView = useCallback((v: DbView, raw: string) => {
    setEditingViewId(null);
    const name = raw.trim();
    if (!schema || !name || name === v.name) return;
    void saveSchema({ ...schema, views: schema.views!.map((x) => (x.id === v.id ? { ...x, name } : x)) });
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

  const addRow = useCallback(async (preset?: Record<string, unknown>, body = "") => {
    const existing = new Set(rows.map((r) => r.title.toLowerCase()));
    let leaf = "Untitled"; let n = 1;
    while (existing.has(leaf.toLowerCase())) leaf = `Untitled ${++n}`;
    const rel = `${dir}/${leaf}.md`;
    try {
      await api.createPage(rel, body);
      if (preset && Object.keys(preset).length) await writeRowFields(rel, preset);
      onTreeChange?.();
      setRows((prev) => [...prev, { rel_path: rel, title: leaf, fields: preset ?? {} }]);
    } catch (e) { console.error(e); }
  }, [rows, dir, onTreeChange, writeRowFields]);

  // Create a row from a template (or blank when templateRel is null), filling {{variables}} against
  // the row's generated title + its destination path. Custom vars prompt the user.
  const addRowFromTemplate = useCallback(async (templateRel: string | null) => {
    if (!templateRel || !onApplyTemplate) return void addRow();
    const existing = new Set(rows.map((r) => r.title.toLowerCase()));
    let leaf = "Untitled"; let n = 1;
    while (existing.has(leaf.toLowerCase())) leaf = `Untitled ${++n}`;
    const rowRel = `${dir}/${leaf}.md`;
    const filled = await onApplyTemplate(templateRel, { title: leaf, relPath: rowRel });
    if (!filled) return; // cancelled
    await addRow(filled.frontmatter, stripCursor(filled.body)); // row create — no live caret
  }, [addRow, onApplyTemplate, rows, dir]);

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
  // Open the icon picker for a row's page, pre-selected with its current icon.
  const openRowIcon = useCallback((row: DbRow) => {
    setIconTarget({ kind: "page", id: row.rel_path, label: row.title || "Untitled", current: nodeIcons?.[row.rel_path] });
  }, [nodeIcons]);
  // Page icons show unless the view has explicitly turned them off.
  const showPageIcon = activeView?.showPageIcon !== false;

  const viewRows = useMemo(() => {
    if (!schema || !activeView) return rows;
    const filtered = applyFilters(rows, activeView.filters, schema.columns, activeView.filterMatch ?? "all");
    return applySorts(filtered, activeView.sorts, schema.columns);
  }, [rows, schema, activeView]);

  if (loading) return <div className="db-view db-loading">Loading database…</div>;
  if (error || !schema || !activeView) {
    return (
      <div className="db-view db-state">
        <div className="db-state-card">
          <Database size={28} weight="duotone" />
          <h2>Couldn’t open this database</h2>
          <p className="muted">{error ?? "Its schema couldn’t be read."}</p>
          <button className="primary" onClick={() => void load()}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="db-view">
      <div className="db-header-bar">
        <PageTitle
          title={schema.name || node.name}
          icon={nodeIcons?.[node.rel_path]}
          fallback={Database}
          placeholder="Untitled database"
          onCommit={(next) => void saveSchema({ ...schema, name: next })}
          onPickIcon={() =>
            setIconTarget({ kind: "db", id: node.rel_path, label: schema.name || node.name, current: nodeIcons?.[node.rel_path] })
          }
        />
        <span className="db-count">{viewRows.length} of {rows.length}</span>
        <div className="db-new-wrap">
          <button className="db-new-split" onClick={() => void addRow()}>
            <Plus size={14} weight="bold" /> New
          </button>
          <button className="db-new-caret" title="New from template" onClick={() => setNewMenu((o) => !o)}>
            <CaretDown size={12} weight="bold" />
          </button>
          {newMenu && (
            <TemplateMenu
              className="db-new-menu"
              templates={templates}
              blankLabel="Blank row"
              onPick={(rel) => void addRowFromTemplate(rel)}
              onClose={() => setNewMenu(false)}
            />
          )}
        </div>
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
              {editingViewId === v.id ? (
                <input
                  className="db-view-tab-rename"
                  defaultValue={v.name}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRenameView(v, (e.target as HTMLInputElement).value);
                    else if (e.key === "Escape") setEditingViewId(null);
                  }}
                  onBlur={(e) => commitRenameView(v, e.target.value)}
                />
              ) : (
                <span
                  className="db-view-tab-name"
                  onDoubleClick={(e) => { if (active) { e.stopPropagation(); setEditingViewId(v.id); } }}
                >
                  {v.name}
                </span>
              )}
              {active && editingViewId !== v.id && (
                <ViewTabMenu
                  canDelete={schema.views!.length > 1}
                  onSetIcon={() => setIconTarget({ kind: "view", id: v.id, label: v.name, current: v.icon })}
                  onRename={() => setEditingViewId(v.id)}
                  onDelete={() => void deleteView(v)}
                />
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
        {rows.length === 0 ? (
          <div className="db-empty-view">
            <Database size={28} weight="duotone" />
            <h2>No rows yet</h2>
            <p className="muted">Create your first row to start filling out this database.</p>
            <button className="primary" onClick={() => void addRow()}>
              <Plus size={14} weight="bold" /> New row
            </button>
          </div>
        ) : viewRows.length === 0 ? (
          <div className="db-empty-view">
            <Table size={26} weight="duotone" />
            <h2>No matching rows</h2>
            <p className="muted">No rows match this view’s filters. Adjust the filters to see more.</p>
          </div>
        ) : (
          <>
        {activeView.type === "table" && (
          <DbTableView
            isMobile={isMobile}
            columns={visibleColumns}
            rows={viewRows}
            view={activeView}
            dateFormat={dateFormat}
            showPageIcon={showPageIcon}
            rowIcon={rowIcon}
            onPickRowIcon={openRowIcon}
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
            showPageIcon={showPageIcon} rowIcon={rowIcon} onPickRowIcon={openRowIcon}
            onOpenRow={(p) => onOpenRow?.(p)} onAddRow={() => addRow()}
          />
        )}
          </>
        )}
      </div>

      {iconTarget && (
        <Suspense fallback={null}>
          <IconPicker
            targetLabel={iconTarget.label}
            current={iconTarget.current}
            onPick={(icon) => {
              if (iconTarget.kind === "col") updateColumn(iconTarget.id, { icon });
              else if (iconTarget.kind === "page" || iconTarget.kind === "db") onSetNodeIcon?.(iconTarget.id, icon);
              else updateView({ icon }); // active view
              setIconTarget(null);
            }}
            onRemove={() => {
              if (iconTarget.kind === "col") updateColumn(iconTarget.id, { icon: undefined });
              else if (iconTarget.kind === "page" || iconTarget.kind === "db") onClearNodeIcon?.(iconTarget.id);
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
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="db-add-view-wrap" ref={ref}>
      <button className="db-add-view" title="Add view" onClick={() => setOpen((o) => !o)}>
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
