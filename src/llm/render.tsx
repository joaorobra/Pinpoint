// Markdown rendering for assistant chat turns.
//
// Two jobs:
//  1. Tool-call cleanup. In agent mode the model often emits its tool calls as inline XML markup
//     (`<function_calls><invoke name="Edit"><parameter name="path">…`). Left raw, that markup leaks
//     into the chat as noisy text — exposing absolute paths and mangling embedded checkboxes. We
//     parse those blocks OUT of the prose and render each as a tidy collapsible pill ("Edited
//     2026-06-26.md"), VS-Code style. Robust to partial/streaming markup (an unterminated block at
//     the tail is hidden rather than shown half-written).
//  2. Markdown. The remaining prose renders through the app's single parser (markdownToHtml) so
//     replies format exactly like the editor, with copy-able code blocks.

import { useEffect, useRef, useState } from "react";
import { CaretRight, PencilSimple, FileText, Terminal, Wrench, MagnifyingGlass } from "@phosphor-icons/react";
import { markdownToHtml } from "../markdown";

/** A tool invocation lifted out of the assistant text. */
interface ToolCall {
  /** Tool name as the model wrote it (e.g. "Edit", "Write", "Bash", "Read"). */
  name: string;
  /** Parsed `<parameter name>` → value pairs. */
  params: Record<string, string>;
}

/** A prose segment or a parsed tool call, in original order. */
type Segment = { kind: "text"; text: string } | { kind: "tool"; call: ToolCall };

// A whole `<function_calls>…</function_calls>` wrapper (the leaked Anthropic tool syntax).
const FN_BLOCK = /<function_calls>([\s\S]*?)<\/function_calls>/g;
// A bare, possibly-unterminated wrapper at the tail (mid-stream): drop it until it closes.
const FN_OPEN_TAIL = /<function_calls>[\s\S]*$/;
const INVOKE = /<invoke\s+name="([^"]*)"\s*>([\s\S]*?)<\/invoke>/g;
const PARAM = /<parameter\s+name="([^"]*)"\s*>([\s\S]*?)<\/parameter>/g;

/** Pull tool calls out of `raw`, returning ordered prose/tool segments. */
function splitSegments(raw: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  FN_BLOCK.lastIndex = 0;
  while ((m = FN_BLOCK.exec(raw))) {
    const before = raw.slice(lastIndex, m.index);
    if (before.trim()) segments.push({ kind: "text", text: before });
    for (const call of parseInvokes(m[1])) segments.push({ kind: "tool", call });
    lastIndex = m.index + m[0].length;
  }
  // Trailing prose — but hide a still-open `<function_calls>` the stream hasn't closed yet.
  let tail = raw.slice(lastIndex);
  tail = tail.replace(FN_OPEN_TAIL, "");
  if (tail.trim()) segments.push({ kind: "text", text: tail });
  return segments;
}

/** Parse every `<invoke>` inside a function-calls block into ToolCalls. */
function parseInvokes(block: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let im: RegExpExecArray | null;
  INVOKE.lastIndex = 0;
  while ((im = INVOKE.exec(block))) {
    const name = im[1] || "tool";
    const params: Record<string, string> = {};
    let pm: RegExpExecArray | null;
    PARAM.lastIndex = 0;
    while ((pm = PARAM.exec(im[2]))) params[pm[1]] = pm[2];
    calls.push({ name, params });
  }
  return calls;
}

/** A short, path-free human summary for a tool call. */
function describe(call: ToolCall): { verb: string; target?: string } {
  const leaf = (p?: string) =>
    p ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p : undefined;
  switch (call.name) {
    case "Edit":
    case "MultiEdit":
      return { verb: "Edited", target: leaf(call.params.path || call.params.file_path) };
    case "Write":
    case "Create":
      return { verb: "Wrote", target: leaf(call.params.path || call.params.file_path) };
    case "Read":
      return { verb: "Read", target: leaf(call.params.path || call.params.file_path) };
    case "Bash":
      return { verb: "Ran command" };
    case "Glob":
    case "Grep":
    case "Search":
      return { verb: "Searched" };
    default:
      return { verb: call.name };
  }
}

function ToolIcon({ name }: { name: string }) {
  const size = 13;
  switch (name) {
    case "Edit":
    case "MultiEdit":
      return <PencilSimple size={size} />;
    case "Write":
    case "Create":
    case "Read":
      return <FileText size={size} />;
    case "Bash":
      return <Terminal size={size} />;
    case "Glob":
    case "Grep":
    case "Search":
      return <MagnifyingGlass size={size} />;
    default:
      return <Wrench size={size} />;
  }
}

/** A collapsed tool-call pill; click to reveal the raw parameters. */
function ToolPill({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const { verb, target } = describe(call);
  const detail = Object.entries(call.params)
    // Hide absolute paths in the summary line; show the rest (e.g. command, diff) on expand.
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n\n");
  return (
    <div className={`llm-tool${open ? " open" : ""}`}>
      <button className="llm-tool-head" onClick={() => setOpen((o) => !o)}>
        <CaretRight size={12} className="llm-tool-caret" weight="bold" />
        <span className="llm-tool-icon"><ToolIcon name={call.name} /></span>
        <span className="llm-tool-verb">{verb}</span>
        {target && <span className="llm-tool-target">{target}</span>}
      </button>
      {open && detail && <pre className="llm-tool-detail">{detail}</pre>}
    </div>
  );
}

/** Render assistant markdown to formatted HTML with copy-able code blocks. */
function Prose({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);

  // After each render, add a hover copy button to every code block. Idempotent: tagged blocks are
  // skipped so re-runs during streaming don't stack buttons.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll<HTMLPreElement>("pre:not([data-copy])").forEach((pre) => {
      pre.dataset.copy = "1";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "llm-code-copy";
      btn.title = "Copy code";
      btn.textContent = "Copy";
      btn.addEventListener("click", () => {
        const code = pre.querySelector("code")?.textContent ?? "";
        navigator.clipboard?.writeText(code).then(() => {
          btn.textContent = "Copied";
          btn.classList.add("done");
          window.setTimeout(() => {
            btn.textContent = "Copy";
            btn.classList.remove("done");
          }, 1200);
        });
      });
      pre.appendChild(btn);
    });
  });

  return (
    <div
      ref={ref}
      className="llm-md"
      dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }}
    />
  );
}

/** True if, after stripping tool-call markup, there's any prose to show (drives the typing caret). */
export function hasVisibleText(text: string): boolean {
  return splitSegments(text).some((s) => s.kind === "text" && s.text.trim().length > 0);
}

/** Assistant turn body: prose with any leaked tool calls rendered as clean pills. */
export function Markdown({ text }: { text: string }) {
  const segments = splitSegments(text);
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "tool" ? (
          <ToolPill key={i} call={seg.call} />
        ) : (
          <Prose key={i} text={seg.text} />
        )
      )}
    </>
  );
}
