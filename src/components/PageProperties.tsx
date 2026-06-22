// A small "page info" popover available for every open page — a database row or a plain note.
// It surfaces the page's intrinsic metadata: its vault path, when it was created, and when it was
// last edited. Those timestamps live in the page's frontmatter (`created` / `updated`), stamped
// automatically on create + every save by the shared API layer (see api.ts), so they exist for all
// pages regardless of whether any database column shows them.

import { useState } from "react";
import { Info, Path, ClockClockwise, ClockCounterClockwise, Copy } from "@phosphor-icons/react";
import { motion, AnimatePresence } from "framer-motion";
import { slideFade } from "../motion";
import { CREATED_KEY, UPDATED_KEY } from "../api";
import { formatDateTime } from "./DbShared";
import { useDismiss } from "./DbShared";

interface Props {
  /** The open page's vault-relative path. */
  path: string;
  /** The page's frontmatter (where `created` / `updated` live). */
  frontmatter: Record<string, unknown>;
  /** Date pattern for formatting the timestamps (mirrors the rest of the app). */
  dateFormat: string;
}

export default function PageProperties({ path, frontmatter, dateFormat }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  const created = formatDateTime(frontmatter[CREATED_KEY], dateFormat);
  const updated = formatDateTime(frontmatter[UPDATED_KEY], dateFormat);

  return (
    <div className="page-props" ref={ref}>
      <button
        className={`page-props-btn${open ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Page info"
        aria-label="Page info"
        aria-expanded={open}
      >
        <Info size={24} weight={open ? "fill" : "bold"} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="page-props-popover"
            {...slideFade({ axis: "y", distance: -6, scale: 0.98, speed: "fast" })}
          >
            <div className="page-props-title">Page info</div>

            <div className="page-props-item">
              <span className="page-props-item-label"><Path size={14} /> Path</span>
              <button
                className="page-props-path"
                title={`${path} — click to copy`}
                onClick={() => navigator.clipboard?.writeText(path)}
              >
                <span className="page-props-path-text">{path}</span>
                <Copy size={12} />
              </button>
            </div>

            <div className="page-props-item">
              <span className="page-props-item-label"><ClockClockwise size={14} /> Created</span>
              <span className="page-props-item-value">{created}</span>
            </div>

            <div className="page-props-item">
              <span className="page-props-item-label"><ClockCounterClockwise size={14} /> Last edited</span>
              <span className="page-props-item-value">{updated}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
