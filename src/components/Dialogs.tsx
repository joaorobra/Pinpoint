// Promise-based in-app dialogs that replace the native window.prompt/confirm/alert.
//
// Usage:
//   const dialogs = useDialogs();
//   const name = await dialogs.prompt({ title: "New page", placeholder: "Notes/Idea" });
//   if (await dialogs.confirm({ title: "Delete file?", danger: true })) ...
//   await dialogs.alert({ title: "Rename failed", message: String(err) });
//
// Mount <DialogHost/> once near the app root; the hook talks to it via a module-level controller so
// any component can open a dialog without prop-drilling.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

type PromptOpts = {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};
type ConfirmOpts = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};
type AlertOpts = { title: string; message?: string; confirmLabel?: string };

type Request =
  | { id: number; kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void }
  | { id: number; kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { id: number; kind: "alert"; opts: AlertOpts; resolve: () => void };

// ---- Module-level store so the hook and the host share one queue ----

let queue: Request[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function enqueue(req: Omit<Request, "id">): void {
  queue = [...queue, { ...req, id: nextId++ } as Request];
  emit();
}
function dequeue(id: number): void {
  queue = queue.filter((r) => r.id !== id);
  emit();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const dialogs = {
  prompt(opts: PromptOpts): Promise<string | null> {
    return new Promise((resolve) => enqueue({ kind: "prompt", opts, resolve }));
  },
  confirm(opts: ConfirmOpts): Promise<boolean> {
    return new Promise((resolve) => enqueue({ kind: "confirm", opts, resolve }));
  },
  alert(opts: AlertOpts): Promise<void> {
    return new Promise((resolve) => enqueue({ kind: "alert", opts, resolve }));
  },
};

/** Stable accessor for the dialog API. */
export function useDialogs() {
  return dialogs;
}

// ---- Host: renders the current (front-of-queue) dialog ----

export function DialogHost() {
  const current = useSyncExternalStore(
    subscribe,
    () => queue[0],
    () => queue[0]
  );
  if (!current) return null;
  return <DialogView key={current.id} req={current} onDone={() => dequeue(current.id)} />;
}

function DialogView({ req, onDone }: { req: Request; onDone: () => void }) {
  const [value, setValue] = useState(req.kind === "prompt" ? req.opts.defaultValue ?? "" : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (req.kind === "prompt") {
      // Focus + select so the default value can be overtyped immediately.
      const el = inputRef.current;
      el?.focus();
      el?.select();
    }
  }, [req]);

  const close = (action: () => void) => {
    action();
    onDone();
  };
  const cancel = () =>
    close(() => {
      if (req.kind === "prompt") req.resolve(null);
      else if (req.kind === "confirm") req.resolve(false);
      else req.resolve();
    });
  const accept = () =>
    close(() => {
      // Return the raw value; callers trim/validate as they did with the native prompt.
      if (req.kind === "prompt") req.resolve(value);
      else if (req.kind === "confirm") req.resolve(true);
      else req.resolve();
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter" && req.kind !== "prompt") {
      e.preventDefault();
      accept();
    }
  };

  const danger = req.kind === "confirm" && req.opts.danger;
  const confirmLabel =
    ("confirmLabel" in req.opts && req.opts.confirmLabel) ||
    (req.kind === "confirm" ? "Confirm" : "OK");
  const cancelLabel =
    (req.kind !== "alert" && "cancelLabel" in req.opts && req.opts.cancelLabel) || "Cancel";

  return (
    <div className="modal-backdrop" onMouseDown={cancel} onKeyDown={onKeyDown}>
      <div
        className="modal dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{req.opts.title}</h2>
        </div>
        {req.opts.message && <p className="muted dialog-message">{req.opts.message}</p>}

        {req.kind === "prompt" && (
          <input
            ref={inputRef}
            className="dialog-input"
            value={value}
            placeholder={req.opts.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                accept();
              }
            }}
          />
        )}

        <div className="dialog-actions">
          {req.kind !== "alert" && (
            <button onClick={cancel}>{cancelLabel}</button>
          )}
          <button
            className={danger ? "primary danger" : "primary"}
            onClick={accept}
            autoFocus={req.kind !== "prompt"}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
