// Side-by-side resolver for sync-conflict duplicates ("name (1).md" next to "name.md"): both
// versions are shown as an aligned line diff so the user can see exactly what differs before
// choosing Merge / Keep original / Keep duplicate / Keep both.
//
// Mirrors the module-store + promise pattern of Dialogs.tsx: mount <ConflictDialogHost/> once near
// the app root, then `await conflictDialog.show(opts)` from anywhere.

import { Fragment, useMemo, useRef, useSyncExternalStore } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { diffLines } from "../conflicts";

/** What the user picked; null means "Later" (dismissed, will re-alert next launch). */
export type ConflictChoice = "merge" | "trash-dup" | "keep-dup" | "keep-both";

export type ConflictViewOpts = {
  /** Vault-relative paths of the base file and its " (n)" copy. */
  originalPath: string;
  duplicatePath: string;
  originalBody: string;
  duplicateBody: string;
  /** Bodies match after trimming — the dialog collapses to a single pane + delete/keep choice. */
  identical: boolean;
  /** Period word ("daily", "weekly", …) when the original is a periodic note, for the subtitle. */
  periodic: string | null;
};

type Request = { id: number; opts: ConflictViewOpts; resolve: (v: ConflictChoice | null) => void };

let queue: Request[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function dequeue(id: number): void {
  queue = queue.filter((r) => r.id !== id);
  emit();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const conflictDialog = {
  show(opts: ConflictViewOpts): Promise<ConflictChoice | null> {
    return new Promise((resolve) => {
      queue = [...queue, { id: nextId++, opts, resolve }];
      emit();
    });
  },
};

export function ConflictDialogHost() {
  const current = useSyncExternalStore(
    subscribe,
    () => queue[0],
    () => queue[0]
  );
  if (!current) return null;
  return <ConflictView key={current.id} req={current} onDone={() => dequeue(current.id)} />;
}

function baseName(p: string): string {
  return p.split("/").pop() ?? p;
}

function ConflictView({ req, onDone }: { req: Request; onDone: () => void }) {
  const { opts } = req;
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  const rows = useMemo(
    () => diffLines(opts.originalBody, opts.duplicateBody),
    [opts.originalBody, opts.duplicateBody]
  );
  const diffCount = useMemo(() => rows.filter((r) => !r.same).length, [rows]);

  const close = (v: ConflictChoice | null) => {
    req.resolve(v);
    onDone();
  };

  const origName = baseName(opts.originalPath);
  const dupName = baseName(opts.duplicatePath);
  const what = opts.periodic ? `your ${opts.periodic} note “${origName}”` : `“${origName}”`;
  const subtitle = opts.identical
    ? `“${dupName}” is an identical copy of ${what}, likely left behind by your sync service. Safe to delete.`
    : `“${dupName}” looks like a sync-conflict copy of ${what}. ${diffCount} line${diffCount === 1 ? "" : "s"} differ — highlighted below.`;

  // Left-pane-only lines are tinted accent (original), right-pane-only amber (duplicate); a null
  // side renders as a dimmed gap so the two panes stay line-aligned.
  const cellClass = (text: string | null, same: boolean, side: "left" | "right") =>
    "conflict-line" + (same ? "" : text === null ? " gap" : ` diff-${side}`);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => close(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close(null);
        }
      }}
    >
      <div
        ref={panelRef}
        className="modal conflict-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Sync conflict"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Sync conflict</h2>
        </div>
        <p className="muted dialog-message">{subtitle}</p>

        {opts.identical ? (
          <>
            <div className="conflict-cols single">
              <div className="conflict-col-head">
                <span className="conflict-badge original">Both files</span>
                <span className="conflict-file">{opts.originalPath}</span>
              </div>
            </div>
            <div className="conflict-diff identical">
              {rows.map((r, i) => (
                <div key={i} className="conflict-line">
                  {r.left ?? r.right ?? ""}
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="conflict-cols">
              <div className="conflict-col-head">
                <span className="conflict-badge original">Original</span>
                <span className="conflict-file" title={opts.originalPath}>
                  {origName}
                </span>
              </div>
              <div className="conflict-col-head">
                <span className="conflict-badge duplicate">Duplicate</span>
                <span className="conflict-file" title={opts.duplicatePath}>
                  {dupName}
                </span>
              </div>
            </div>
            <div className="conflict-diff">
              {rows.map((r, i) => (
                <Fragment key={i}>
                  <div className={cellClass(r.left, r.same, "left")}>{r.left ?? ""}</div>
                  <div className={cellClass(r.right, r.same, "right")}>{r.right ?? ""}</div>
                </Fragment>
              ))}
            </div>
          </>
        )}

        <div className="conflict-actions">
          <button onClick={() => close(null)}>Later</button>
          <span className="spacer" />
          {opts.identical ? (
            <>
              <button onClick={() => close("keep-both")}>Keep both</button>
              <button className="primary" onClick={() => close("trash-dup")} autoFocus>
                Delete duplicate
              </button>
            </>
          ) : (
            <>
              <button onClick={() => close("keep-both")}>Keep both</button>
              <button className="danger-soft" onClick={() => close("trash-dup")}>
                Keep original
              </button>
              <button className="danger-soft" onClick={() => close("keep-dup")}>
                Keep duplicate
              </button>
              <button className="primary" onClick={() => close("merge")} autoFocus>
                Merge into original
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
