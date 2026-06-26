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
import { useFocusTrap } from "../hooks/useFocusTrap";

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
/**
 * A password dialog. Renders one or more masked fields and resolves a map of field-key → value, or
 * null if cancelled. Use `requireMatch: [a, b]` to enforce two fields being equal (e.g. new password
 * + confirmation) before accepting. `minLength` guards trivially-short passwords.
 */
type PasswordField = { key: string; label: string; placeholder?: string };
type PasswordOpts = {
  title: string;
  message?: string;
  fields: PasswordField[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Two field keys whose values must match (e.g. ["new", "confirm"]). */
  requireMatch?: [string, string];
  /** Minimum length for every field (default 1). */
  minLength?: number;
};
/** One button in a `choose` dialog. `value` is what the promise resolves to when picked. */
type ChooseOption = { label: string; value: string; danger?: boolean };
type ChooseOpts = {
  title: string;
  message?: string;
  options: ChooseOption[];
  /** Label of the dismiss button (resolves null). Defaults to "Cancel". */
  cancelLabel?: string;
};

type Request =
  | { id: number; kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void }
  | { id: number; kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { id: number; kind: "alert"; opts: AlertOpts; resolve: () => void }
  | { id: number; kind: "choose"; opts: ChooseOpts; resolve: (v: string | null) => void }
  | {
      id: number;
      kind: "password";
      opts: PasswordOpts;
      resolve: (v: Record<string, string> | null) => void;
    };

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
  /** Pick one of several actions. Resolves the chosen option's `value`, or null if dismissed. */
  choose(opts: ChooseOpts): Promise<string | null> {
    return new Promise((resolve) => enqueue({ kind: "choose", opts, resolve }));
  },
  /** Collect one or more masked passwords. Resolves a field-key → value map, or null if cancelled. */
  password(opts: PasswordOpts): Promise<Record<string, string> | null> {
    return new Promise((resolve) => enqueue({ kind: "password", opts, resolve }));
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
  // Per-field values for the password dialog, keyed by field.key.
  const [pw, setPw] = useState<Record<string, string>>({});
  const [pwError, setPwError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  useEffect(() => {
    if (req.kind === "prompt") {
      // Focus + select so the default value can be overtyped immediately.
      const el = inputRef.current;
      el?.focus();
      el?.select();
    } else if (req.kind === "password") {
      inputRef.current?.focus();
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
      else if (req.kind === "choose") req.resolve(null);
      else if (req.kind === "password") req.resolve(null);
      else req.resolve();
    });
  // Pick a specific option in a `choose` dialog.
  const pick = (value: string) => close(() => req.kind === "choose" && req.resolve(value));

  // Validate the password dialog's fields; returns null when valid, else an error to show inline.
  const validatePassword = (): string | null => {
    if (req.kind !== "password") return null;
    const min = req.opts.minLength ?? 1;
    for (const f of req.opts.fields) {
      if ((pw[f.key] ?? "").length < min) {
        return min > 1 ? `${f.label} must be at least ${min} characters.` : `${f.label} is required.`;
      }
    }
    if (req.opts.requireMatch) {
      const [a, b] = req.opts.requireMatch;
      if ((pw[a] ?? "") !== (pw[b] ?? "")) return "Passwords don't match.";
    }
    return null;
  };

  const accept = () => {
    if (req.kind === "password") {
      const error = validatePassword();
      if (error) {
        setPwError(error);
        return; // keep the dialog open so the user can fix it
      }
      close(() => req.resolve({ ...pw }));
      return;
    }
    close(() => {
      // Return the raw value; callers trim/validate as they did with the native prompt.
      // (`choose` has no accept button — it's settled via `pick`/`cancel`.)
      if (req.kind === "prompt") req.resolve(value);
      else if (req.kind === "confirm") req.resolve(true);
      else if (req.kind === "alert") req.resolve();
    });
  };

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
        ref={panelRef}
        className="modal dialog"
        role="dialog"
        aria-modal="true"
        aria-label={req.opts.title}
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

        {req.kind === "password" && (
          <div className="dialog-password-fields">
            {req.opts.fields.map((f, i) => (
              <label key={f.key} className="dialog-password-field">
                <span className="dialog-password-label">{f.label}</span>
                <input
                  ref={i === 0 ? inputRef : undefined}
                  type="password"
                  className="dialog-input"
                  autoComplete="off"
                  placeholder={f.placeholder}
                  value={pw[f.key] ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setPw((prev) => ({ ...prev, [f.key]: v }));
                    if (pwError) setPwError(null); // clear stale error as the user types
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      accept();
                    }
                  }}
                />
              </label>
            ))}
            {pwError && <p className="dialog-password-error">{pwError}</p>}
          </div>
        )}

        {req.kind === "choose" && (
          <div className="dialog-choices">
            {req.opts.options.map((opt, i) => (
              <button
                key={opt.value}
                className={opt.danger ? "primary danger" : "primary"}
                onClick={() => pick(opt.value)}
                autoFocus={i === 0}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        <div className="dialog-actions">
          {req.kind !== "alert" && (
            <button onClick={cancel}>{cancelLabel}</button>
          )}
          {req.kind !== "choose" && (
            <button
              className={danger ? "primary danger" : "primary"}
              onClick={accept}
              autoFocus={req.kind !== "prompt" && req.kind !== "password"}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
