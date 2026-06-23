// Lightweight transient toasts with an optional inline action (e.g. "Moved to Trash · Undo").
//
// Mirrors the module-store pattern of Dialogs so any component can fire a toast without
// prop-drilling. Mount <ToastHost/> once near the app root.
//
//   toast.show({ message: "Moved to Trash", action: { label: "Undo", run: () => restore() } });

import { useEffect, useSyncExternalStore } from "react";
import { ArrowUUpLeft } from "@phosphor-icons/react";

export type ToastAction = { label: string; run: () => void };
export type ToastOpts = {
  message: string;
  action?: ToastAction;
  /** Auto-dismiss after this many ms (default 5000). Pass 0 to keep until dismissed. */
  durationMs?: number;
};
type Toast = ToastOpts & { id: number };

let items: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function dismiss(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  show(opts: ToastOpts): () => void {
    const id = nextId++;
    items = [...items, { ...opts, id }];
    emit();
    return () => dismiss(id);
  },
};

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function ToastHost() {
  const list = useSyncExternalStore(
    subscribe,
    () => items,
    () => items
  );
  if (list.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {list.map((t) => (
        <ToastView key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastView({ toast: t }: { toast: Toast }) {
  useEffect(() => {
    const ms = t.durationMs ?? 5000;
    if (ms <= 0) return;
    const timer = setTimeout(() => dismiss(t.id), ms);
    return () => clearTimeout(timer);
  }, [t.id, t.durationMs]);

  return (
    <div className="toast">
      <span className="toast-message">{t.message}</span>
      {t.action && (
        <button
          className="toast-action"
          onClick={() => {
            t.action!.run();
            dismiss(t.id);
          }}
        >
          <ArrowUUpLeft size={14} weight="bold" />
          {t.action.label}
        </button>
      )}
    </div>
  );
}
