// Gallery (card) view: a responsive grid of cards, one per row. Shows the title plus whichever
// properties are visible for the view; an optional "cover" select column tints the card's top strip.

import { Plus, FileText } from "@phosphor-icons/react";
import type { DbColumn, DbView, NodeIcon } from "../types";
import type { DbRow } from "../dblogic";
import { cellValue } from "../dblogic";
import { CellValueView, chipBg } from "./DbShared";
import { NodeIconView } from "./Icon";

interface Props {
  columns: DbColumn[];   // visible columns
  allColumns: DbColumn[];
  rows: DbRow[];
  view: DbView;
  dateFormat: string;
  /** Whether to show each card's page icon beside its title. */
  showPageIcon: boolean;
  /** Resolve a row's custom page icon by its file path (undefined = use the default page glyph). */
  rowIcon: (relPath: string) => NodeIcon | undefined;
  onOpenRow: (relPath: string) => void;
  onAddRow: () => void;
}

export default function DbGalleryView({ columns, allColumns, rows, view, dateFormat, showPageIcon, rowIcon, onOpenRow, onAddRow }: Props) {
  const bodyCols = columns.filter((c) => c.type !== "title");
  const coverCol = allColumns.find((c) => c.id === view.cardCover && c.type === "select");

  const coverColor = (row: DbRow): string | undefined => {
    if (!coverCol) return undefined;
    const v = cellValue(row, coverCol);
    const opt = (coverCol.options ?? []).find((o) => o.id === v);
    return opt ? chipBg(opt.color) : undefined;
  };

  return (
    <div className="db-gallery">
      {rows.map((row) => (
        <div key={row.rel_path} className="db-gallery-card" onClick={() => onOpenRow(row.rel_path)}>
          {coverCol && <div className="db-gallery-cover" style={{ background: coverColor(row) ?? "var(--bg-3)" }} />}
          <div className="db-gallery-body">
            <div className="db-card-title">
              {showPageIcon && (
                <NodeIconView icon={rowIcon(row.rel_path)} fallback={FileText} size={15} className="db-card-title-icon" />
              )}
              <span>{row.title || "Untitled"}</span>
            </div>
            {bodyCols.map((c) => (
              <div key={c.id} className="db-card-field">
                <span className="db-card-field-label">{c.name}</span>
                <CellValueView col={c} row={row} dateFormat={dateFormat} />
              </div>
            ))}
          </div>
        </div>
      ))}
      <button className="db-gallery-add" onClick={onAddRow}><Plus size={16} /> New card</button>
    </div>
  );
}
