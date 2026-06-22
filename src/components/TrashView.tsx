import { useEffect, useState } from "react";
import {
  ArrowCounterClockwise,
  TrashSimple,
  Folder,
  FileText,
  File as FileIcon,
} from "@phosphor-icons/react";
import { api } from "../api";
import type { TrashEntry } from "../types";
import { dialogs } from "./Dialogs";

interface Props {
  /** Bumped by the host whenever trash contents change, to trigger a re-fetch. */
  refreshKey: number;
  /** Restore a trashed item by id (handled by the host so it can refresh the tree / open pages). */
  onRestore: (id: string) => void | Promise<void>;
  /** Tell the host the trash changed (after a purge / empty) so other views refresh. */
  onChanged: () => void;
}

/** Human "time ago" from a unix-millis timestamp — good enough for a recycle bin. */
function timeAgo(ms: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** Icon for a trashed entry, mirroring the explorer's defaults. */
function entryIcon(e: TrashEntry) {
  if (e.is_dir) return Folder;
  return e.name.toLowerCase().endsWith(".md") ? FileText : FileIcon;
}

/** The directory the item will be restored back into ("vault root" when it lived at the top). */
function parentLabel(orig: string): string {
  const slash = orig.lastIndexOf("/");
  return slash >= 0 ? orig.slice(0, slash) : "vault root";
}

/**
 * The Trash tab: lists soft-deleted items (most-recent first) with Restore / Delete-forever per
 * row, plus Empty-trash. Reads from `api.listTrash`; all mutations bubble up via onRestore/onChanged
 * so the host can keep the file tree and other views in sync.
 */
export default function TrashView({ refreshKey, onRestore, onChanged }: Props) {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api
      .listTrash()
      .then(setEntries)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(load, [refreshKey]);

  const purge = async (e: TrashEntry) => {
    const ok = await dialogs.confirm({
      title: `Permanently delete “${e.name}”?`,
      message: "This can't be undone.",
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.purgeTrash(e.id);
    } catch (err) {
      await dialogs.alert({ title: "Delete failed", message: String(err) });
      return;
    }
    load();
    onChanged();
  };

  const emptyAll = async () => {
    const ok = await dialogs.confirm({
      title: `Empty Trash?`,
      message: `Permanently delete all ${entries.length} item${entries.length === 1 ? "" : "s"}. This can't be undone.`,
      confirmLabel: "Empty Trash",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.emptyTrash();
    } catch (err) {
      await dialogs.alert({ title: "Empty trash failed", message: String(err) });
      return;
    }
    load();
    onChanged();
  };

  return (
    <div className="panel trash-view">
      <div className="panel-header">
        <h2>Trash</h2>
        {entries.length > 0 && (
          <button className="danger-ghost" onClick={emptyAll}>
            <TrashSimple size={15} /> Empty Trash
          </button>
        )}
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="muted">
          Trash is empty. Deleted files and folders land here and can be restored — until you empty it.
        </p>
      ) : (
        <div className="trash-list">
          {entries.map((e) => {
            const Ico = entryIcon(e);
            return (
              <div key={e.id} className="trash-row">
                <span className="trash-icon"><Ico size={18} /></span>
                <span className="trash-text">
                  <span className="trash-name" title={e.orig_path}>{e.name}</span>
                  <span className="trash-meta">
                    {parentLabel(e.orig_path)} · deleted {timeAgo(e.deleted_at)}
                  </span>
                </span>
                <button className="trash-action" title="Restore to original location" onClick={() => onRestore(e.id)}>
                  <ArrowCounterClockwise size={15} /> Restore
                </button>
                <button className="trash-action danger" title="Delete permanently" onClick={() => purge(e)}>
                  <TrashSimple size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
