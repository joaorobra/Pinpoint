// Lightweight transient toasts with an optional inline action (e.g. "Moved to Trash · Undo").
//
// Mirrors the module-store pattern of Dialogs so any component can fire a toast without
// prop-drilling. Mount <ToastHost/> once near the app root.
//
//   toast.show({ message: "Moved to Trash", action: { label: "Undo", run: () => restore() } });

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  // The live region stays mounted even when empty: screen readers only announce content that is
  // added to a region that already existed, so mounting it together with its first toast is missed.
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {list.map((t) => (
        <ToastView key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastView({ toast: t }: { toast: Toast }) {
  // Pause the countdown while the pointer or keyboard focus is on the toast, so there's time to
  // reach its action (e.g. Undo). Toasts with an action also get a longer default.
  const [paused, setPaused] = useState(false);
  const remaining = useRef(t.durationMs ?? (t.action ? 8000 : 5000));
  useEffect(() => {
    if (paused || remaining.current <= 0) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss(t.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [t.id, paused]);

  return (
    <div
      className="toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast-message">{t.message}</span>
      {t.action && (
        <button
          className="toast-action"
          onClick={() => {
            t.action!.run();
            dismiss(t.id);
          }}
        >
          {/^undo\b/i.test(t.action.label) && <ArrowUUpLeft size={14} weight="bold" />}
          {t.action.label}
        </button>
      )}
    </div>
  );
}
