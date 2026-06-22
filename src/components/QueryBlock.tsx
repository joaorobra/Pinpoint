// Inline query block: a TipTap node that renders a live Dataview-like query result inside the
// editor.
//
// Round-trip (the locked markdown constraint): a query block is stored as a fenced code block with
// the `query` language tag —
//   ```query
//   TABLE file.name, status FROM "Projects" WHERE status = "active"
//   ```
// markdownToHtml emits `<div data-query="…">` for that fence, this node parses it, and
// docToMarkdown re-serializes the node back to the same fence. So an inline query is just markdown:
// it survives an external edit and renders as a code block in any other CommonMark viewer.

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { ArrowsClockwise, PencilSimple, Table } from "@phosphor-icons/react";
import { api } from "../api";
import type { QueryResult } from "../types";
import QueryResultView from "./QueryResultView";

export interface QueryBlockOptions {
  /** Open the query-helper popup to edit this block's DSL. Receives the node's screen position. */
  onEdit?: (getPos: () => number, dsl: string) => void;
  /** Open a task's source page (by vault-relative path) when its text is clicked. */
  onOpenPath?: (relPath: string) => void;
  /** Pattern for rendering task due dates (see dateformat.ts). */
  dateFormat?: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    queryBlock: {
      /** Insert an inline query block running `dsl` at the caret. */
      insertQueryBlock: (dsl: string) => ReturnType;
    };
  }
}

function QueryBlockView({ node, editor, getPos, extension }: NodeViewProps) {
  const dsl: string = node.attrs.dsl ?? "";
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!dsl.trim()) {
      setResult(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setResult(await api.runQuery(dsl));
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  // Re-run whenever the DSL changes (initial mount + edits via the helper).
  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsl]);

  const edit = () =>
    extension.options.onEdit?.(() => (typeof getPos === "function" ? getPos() : 0), dsl);

  return (
    <NodeViewWrapper className="query-block" data-query={dsl}>
      <div className="query-block-bar" contentEditable={false}>
        <span className="query-block-label">
          <Table size={14} weight="bold" /> Query
        </span>
        <code className="query-block-dsl">{dsl || "empty query"}</code>
        <span className="query-block-actions">
          <button title="Re-run" onClick={run} disabled={loading}>
            <ArrowsClockwise size={14} weight="bold" />
          </button>
          {editor.isEditable && (
            <button title="Edit query" onClick={edit}>
              <PencilSimple size={14} weight="bold" />
            </button>
          )}
        </span>
      </div>
      <div className="query-block-body" contentEditable={false}>
        {loading && <p className="muted">Running…</p>}
        {error && <pre className="error">{error}</pre>}
        {!loading && !error && result && (
          <QueryResultView
            result={result}
            dateFormat={extension.options.dateFormat}
            onOpen={extension.options.onOpenPath}
            // Toggle a task's done state on disk, then re-run so the block reflects the new state.
            onToggle={(t) =>
              api
                .toggleTask(t.rel_path, t.line, t.occurrence ?? null)
                .then(run)
                .catch((e) => setError(String(e)))
            }
            // TASK blocks expand recurring tasks into upcoming occurrences, matching the Tasks panel.
            expandRecurring={result.kind === "task"}
          />
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const QueryBlock = Node.create<QueryBlockOptions>({
  name: "queryBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { onEdit: undefined, onOpenPath: undefined, dateFormat: "YYYY-MM-DD" };
  },

  addAttributes() {
    return {
      dsl: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-query") ?? "",
        renderHTML: (attrs) => ({ "data-query": attrs.dsl }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-query]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "query-block" })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(QueryBlockView);
  },

  addCommands() {
    return {
      insertQueryBlock:
        (dsl: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { dsl } }),
    };
  },
});
