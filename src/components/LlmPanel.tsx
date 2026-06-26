// LLM chat panel — CLI integration.
//
// A right-hand dock that converses with a CLI-driven model. Beyond plain chat it carries context
// controls in the composer: a model selector, reasoning-effort selector, mode toggle
// (chat/note/agent), role preset, and `[[ref]]` page/folder references with the same folder-aware
// autocomplete the editor uses (buildLinkItems from Editor.tsx). On send, `[[refs]]` are resolved
// to page bodies / folder listings and prepended as context (see src/llm/refs.ts).
//
// Layout takes after the VS Code chat extension: a quiet header, a transcript with role-tagged
// turns (assistant replies render markdown), a "+" actions menu for one-shot context actions, a
// settings popover for model/effort/mode/preset, and a single dominant send button. Talks only to
// `llmTransport` (src/llm/transport.ts) — no host branching here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PaperPlaneRight,
  Stop,
  Plus,
  SlidersHorizontal,
  Robot,
  FileText,
  Folder,
  At,
  Broom,
  X,
} from "@phosphor-icons/react";
import {
  llmTransport,
  type LlmEvent,
  type LlmMode,
  type ProviderId,
  type ProviderStatus,
} from "../llm/transport";
import { buildLinkItems, type LinkItem, type PageRef } from "./Editor";
import { buildContext } from "../llm/refs";
import { MODELS, EFFORTS, MODES, PRESETS, supportsEffort } from "../llm/options";
import { Markdown, hasVisibleText } from "../llm/render";
import Select from "./Select";

export interface LlmChatTurn {
  role: "user" | "assistant";
  text: string;
  /** Chips describing attached `[[refs]]`, shown under a user turn. */
  attached?: string[];
  streaming?: boolean;
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
};

/** Starter prompts shown in the empty state — one tap to seed the composer. */
const SUGGESTIONS = [
  "Summarize the current page",
  "Brainstorm ideas for…",
  "Proofread my selection",
];

export interface LlmPanelProps {
  onClose?: () => void;
  /**
   * Conversation state, OWNED BY THE PARENT so it outlives this component. The dock is
   * conditionally rendered for its slide animation, so LlmPanel unmounts whenever the dock is
   * hidden — keeping `turns` and the resume session id up here means a single conversation
   * survives open/close instead of resetting on every toggle.
   */
  turns: LlmChatTurn[];
  setTurns: React.Dispatch<React.SetStateAction<LlmChatTurn[]>>;
  /** Resume session id, persisted across mounts. Mutated in place (a ref, not state). */
  sessionRef: React.MutableRefObject<string | undefined>;
  /** All vault pages, for `[[ref]]` autocomplete + resolution. */
  pages: PageRef[];
  /** The currently open page's rel_path, used to seed the default reference. */
  activePath?: string | null;
  /** Read a page's markdown body by rel_path (for inlining referenced pages). */
  readPage: (relPath: string) => Promise<string>;
  /** Map a vault-relative path to an absolute path (for `--add-dir`). Null host → no folder dirs. */
  vaultRelToAbs?: (rel: string) => string;
  /** Absolute vault root, for agent mode's working directory. */
  vaultRoot?: string | null;
  /** Saved chat defaults (Settings → AI Chat) each new conversation starts from. */
  defaults?: {
    provider: ProviderId;
    model: string;
    effort: string;
    mode: LlmMode;
    preset: string;
  };
}

export function LlmPanel({
  onClose,
  turns,
  setTurns,
  sessionRef,
  pages,
  activePath,
  readPage,
  vaultRelToAbs,
  vaultRoot,
  defaults,
}: LlmPanelProps) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  // Seed from saved defaults; the providers probe below still upgrades to the first ready provider
  // only when the saved default isn't usable.
  const [provider, setProvider] = useState<ProviderId>(defaults?.provider ?? "claude");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  // Config controls — initialised from the saved defaults, overridable per-conversation.
  const [model, setModel] = useState(defaults?.model ?? "");
  const [effort, setEffort] = useState(defaults?.effort ?? "");
  const [mode, setMode] = useState<LlmMode>(defaults?.mode ?? "chat");
  const [preset, setPreset] = useState(defaults?.preset ?? "");

  // Popovers anchored to the composer toolbar.
  const [menu, setMenu] = useState<null | "actions" | "settings">(null);

  // `[[` autocomplete state.
  const [linkItems, setLinkItems] = useState<LinkItem[] | null>(null);
  const [linkSel, setLinkSel] = useState(0);

  const runIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    llmTransport
      .listProviders()
      .then((list) => {
        setProviders(list);
        // Honor the saved default if it's usable; otherwise fall back to the first ready provider.
        const savedReady = list.find((p) => p.id === provider && p.installed && p.authenticated);
        if (!savedReady) {
          const ready = list.find((p) => p.installed && p.authenticated);
          if (ready) setProvider(ready.id);
        }
      })
      .catch(() => setProviders([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  // Reset model/effort if the chosen value isn't valid for the new provider.
  useEffect(() => {
    if (!MODELS[provider].some((c) => c.value === model)) setModel("");
    if (!EFFORTS[provider].some((c) => c.value === effort)) setEffort("");
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close the composer popovers on outside click. The settings popover hosts our custom <Select>,
  // whose menu PORTALS to document.body (outside composerRef) — so a click on a Select option must
  // NOT count as "outside", or the popover would close before the option commits and the menu would
  // appear empty. We treat any click inside a portaled `.select-menu` as inside.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (composerRef.current?.contains(t)) return;
      if ((t as Element)?.closest?.(".select-menu")) return;
      setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menu]);

  const current = useMemo(
    () => providers.find((p) => p.id === provider),
    [providers, provider]
  );
  const ready = !!current?.installed && !!current?.authenticated;

  // Compact labels for the inline status row under the transcript.
  const modelLabel = MODELS[provider].find((c) => c.value === model)?.label ?? "Default";
  const modeLabel = MODES.find((m) => m.value === mode)?.label ?? "Chat";
  const effortLabel = EFFORTS[provider].find((c) => c.value === effort)?.label;

  // Proactive mode hint: only Agent mode can touch files. When the user is in chat/note and the
  // draft clearly asks to create/edit/save a file or note, surface a one-tap "switch to Agent"
  // nudge — so they aren't surprised when chat refuses (see the system-prompt guard in llm.rs).
  const wantsFileEdit = useMemo(
    () =>
      /\b(creat|writ|edit|updat|modif|append|sav|delet|rename|insert|add (?:a |the )?(?:line|section|heading|note|file))\w*\b[\s\S]*\b(file|note|page|document|doc|md|markdown|\.md)\b/i.test(
        input
      ) || /\b(?:in|to|into) (?:this|the|my) (?:file|note|page|document)\b/i.test(input),
    [input]
  );
  const showAgentHint = wantsFileEdit && mode !== "agent" && !busy;

  // ---- `[[` autocomplete --------------------------------------------------------
  // Detect an open `[[query` at the caret (no closing `]]` between it and the caret), mirroring the
  // editor's grammar, and offer folder-aware entries via the shared buildLinkItems.
  const refreshLinkMenu = useCallback(
    (value: string, caret: number) => {
      const upToCaret = value.slice(0, caret);
      const m = /\[\[([^\[\]]*)$/.exec(upToCaret);
      if (!m) {
        setLinkItems(null);
        return;
      }
      const items = buildLinkItems(pages, m[1]).slice(0, 12);
      setLinkItems(items);
      setLinkSel(0);
    },
    [pages]
  );

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    refreshLinkMenu(value, e.target.selectionStart ?? value.length);
  };

  /** Insert/complete a `[[ref]]` for the selected link item at the caret. */
  const pickLink = useCallback(
    (item: LinkItem) => {
      const el = inputRef.current;
      if (!el) return;
      const caret = el.selectionStart ?? input.length;
      const before = input.slice(0, caret);
      const after = input.slice(caret);
      const open = before.lastIndexOf("[[");
      if (open === -1) return;

      if (item.folder) {
        // Folder pick: keep the `[[`, rewrite the query to the folder path so the user drills in.
        const next = before.slice(0, open) + `[[${item.path}` + after;
        setInput(next);
        requestAnimationFrame(() => {
          const pos = open + 2 + item.path.length;
          el.focus();
          el.setSelectionRange(pos, pos);
          refreshLinkMenu(next, pos);
        });
        return;
      }
      // Page (or create): finish the link as `[[name]]`. We store the leaf name for readability;
      // refs.ts resolves a bare name or a full path.
      const label = item.create ? item.path : item.name;
      const next = before.slice(0, open) + `[[${label}]]` + after;
      setInput(next);
      setLinkItems(null);
      requestAnimationFrame(() => {
        const pos = open + label.length + 4;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [input, refreshLinkMenu]
  );

  // ---- send ---------------------------------------------------------------------
  const send = useCallback(async () => {
    const raw = input.trim();
    if (!raw || busy) return;
    setInput("");
    setLinkItems(null);
    setBusy(true);

    // Auto-attach the current page when the user clearly means it but typed no `[[ref]]`. Covers
    // "summarize the current page" / note mode, where the open note is the obvious context. We
    // prepend a `[[ref]]` to the active page so the existing resolver inlines its body.
    const hasExplicitRef = /\[\[[^\[\]]+\]\]/.test(raw);
    const mentionsCurrent = /\b(this|current|the)\s+(page|note|document|doc)\b/i.test(raw);
    let prompt = raw;
    if (!hasExplicitRef && activePath && (mode === "note" || mentionsCurrent)) {
      prompt = `[[${activePath.replace(/\.md$/i, "")}]] ${raw}`;
    }

    // Resolve `[[refs]]` → context preamble + add-dirs. Folder dirs need the abs-path mapper.
    const relToAbs = vaultRelToAbs ?? ((r: string) => r);
    const ctx = await buildContext(prompt, pages, readPage, relToAbs);

    // Agent mode runs in the vault root and grants it as a context dir.
    const addDirs = [...ctx.addDirs];
    if (mode === "agent" && vaultRoot) addDirs.push(vaultRoot);

    setTurns((t) => [
      ...t,
      { role: "user", text: raw, attached: ctx.attached.length ? ctx.attached : undefined },
      { role: "assistant", text: "", streaming: true },
    ]);

    const appendToAssistant = (delta: string) =>
      setTurns((t) => {
        const out = t.slice();
        const last = out[out.length - 1];
        if (last?.role === "assistant") out[out.length - 1] = { ...last, text: last.text + delta };
        return out;
      });
    const finishAssistant = (errText?: string) =>
      setTurns((t) => {
        const out = t.slice();
        const last = out[out.length - 1];
        if (last?.role === "assistant") {
          out[out.length - 1] = {
            ...last,
            text: errText ? (last.text ? last.text + "\n\n" : "") + `⚠ ${errText}` : last.text,
            streaming: false,
          };
        }
        return out;
      });

    const onEvent = (e: LlmEvent) => {
      switch (e.kind) {
        case "init":
          sessionRef.current = e.sessionId || sessionRef.current;
          break;
        case "text":
          appendToAssistant(e.delta);
          break;
        case "tool":
          // Normalize a real `tool_use` event into the same wrapper the model sometimes emits
          // inline, so both paths render as one consistent tool pill (see src/llm/render.tsx).
          appendToAssistant(`\n<function_calls><invoke name="${e.name}"></invoke></function_calls>\n`);
          break;
        case "done":
          if (e.sessionId) sessionRef.current = e.sessionId;
          finishAssistant();
          break;
        case "error":
          finishAssistant(e.message);
          break;
      }
    };

    try {
      await llmTransport.run(
        {
          provider,
          prompt: ctx.prompt,
          sessionId: sessionRef.current,
          mode,
          // Always run inside the vault (never the app's launch dir) so the CLI can't discover the
          // surrounding repo / git changes. With no vault open, the Rust side falls back to a
          // neutral temp dir.
          cwd: vaultRoot ?? undefined,
          model: model || undefined,
          effort: effort || undefined,
          systemPrompt: preset || undefined,
          addDirs: addDirs.length ? addDirs : undefined,
        },
        onEvent,
        (runId) => {
          runIdRef.current = runId;
        }
      );
    } finally {
      runIdRef.current = null;
      setBusy(false);
    }
  }, [input, busy, provider, pages, readPage, vaultRelToAbs, vaultRoot, mode, model, effort, preset, setTurns, sessionRef]);

  const stop = useCallback(() => {
    if (runIdRef.current) llmTransport.cancel(runIdRef.current);
  }, []);

  const reset = useCallback(() => {
    if (busy) return;
    sessionRef.current = undefined;
    setTurns([]);
  }, [busy, setTurns, sessionRef]);

  /** Insert a `[[ref]]` to the active page (quick "attach current note" affordance). */
  const refCurrent = useCallback(() => {
    if (!activePath) return;
    const name = activePath.replace(/\.md$/i, "");
    setInput((v) => (v ? `${v} [[${name}]] ` : `[[${name}]] `));
    inputRef.current?.focus();
  }, [activePath]);

  /** Open the `[[` mention menu from the actions menu by inserting `[[` at the caret. */
  const startMention = useCallback(() => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? input.length;
    const next = input.slice(0, caret) + "[[" + input.slice(caret);
    setInput(next);
    requestAnimationFrame(() => {
      const pos = caret + 2;
      el?.focus();
      el?.setSelectionRange(pos, pos);
      refreshLinkMenu(next, pos);
    });
  }, [input, refreshLinkMenu]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Drive the `[[` menu when it's open.
    if (linkItems && linkItems.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setLinkSel((s) => (s + 1) % linkItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setLinkSel((s) => (s - 1 + linkItems.length) % linkItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickLink(linkItems[linkSel]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setLinkItems(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="llm-panel">
      <div className="llm-panel-head">
        <span className="llm-head-brand">
          <Robot size={16} weight="duotone" />
          <span className="llm-head-title">AI Chat</span>
        </span>
        <div className="llm-panel-head-actions">
          <button
            className="llm-icon-btn"
            title="New conversation"
            onClick={reset}
            disabled={busy || turns.length === 0}
          >
            <Broom size={18} />
          </button>
          {onClose && (
            <button className="llm-icon-btn" title="Close" onClick={onClose}>
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      <div className="llm-transcript" ref={scrollRef}>
        {turns.length === 0 ? (
          <div className="llm-empty">
            <span className="llm-empty-mark">
              <Robot size={26} weight="duotone" />
            </span>
            {ready ? (
              <>
                <div className="llm-empty-title">Chat with {PROVIDER_LABEL[provider]}</div>
                <div className="llm-empty-sub">
                  Uses your CLI subscription login. Type <code>[[</code> to reference a page or folder.
                </div>
                <div className="llm-suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      className="llm-suggestion"
                      onClick={() => {
                        setInput(s.endsWith("…") ? s.slice(0, -1) : s);
                        inputRef.current?.focus();
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </>
            ) : !current?.installed ? (
              <div className="llm-empty-sub">
                The {PROVIDER_LABEL[provider]} CLI isn't on your PATH. Install it, then reopen.
              </div>
            ) : (
              <div className="llm-empty-sub">
                You're not logged in to the {PROVIDER_LABEL[provider]} CLI. Log in, then reopen.
              </div>
            )}
          </div>
        ) : (
          turns.map((t, i) => (
            <div key={i} className={`llm-turn llm-turn-${t.role}`}>
              {t.role === "assistant" && (
                <span className="llm-turn-author">
                  <Robot size={13} weight="duotone" /> {PROVIDER_LABEL[provider]}
                </span>
              )}
              <div className="llm-turn-body">
                {t.role === "assistant" ? (
                  <>
                    <Markdown text={t.text} />
                    {t.streaming && !hasVisibleText(t.text) && (
                      <span className="llm-thinking">
                        {t.text ? "Working…" : "Thinking…"}
                      </span>
                    )}
                  </>
                ) : (
                  t.text
                )}
                {t.streaming && hasVisibleText(t.text) && <span className="llm-caret" />}
              </div>
              {t.attached && (
                <div className="llm-attached">
                  {t.attached.map((a, j) => (
                    <span key={j} className="llm-chip">
                      <At size={11} />
                      {a}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="llm-composer" ref={composerRef}>
        {/* `[[` autocomplete menu. */}
        {linkItems && linkItems.length > 0 && (
          <div className="llm-link-menu">
            {linkItems.map((it, i) => (
              <button
                key={`${it.path}-${i}`}
                className={`llm-link-item${i === linkSel ? " sel" : ""}`}
                onMouseEnter={() => setLinkSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickLink(it);
                }}
              >
                {it.folder ? <Folder size={14} /> : <FileText size={14} />}
                <span className="llm-link-name">{it.name}</span>
                {it.create && <span className="llm-link-tag">create</span>}
                {it.folder && <span className="llm-link-tag">folder</span>}
              </button>
            ))}
          </div>
        )}

        {/* "+" one-shot actions menu (VS Code style). */}
        {menu === "actions" && (
          <div className="llm-pop llm-pop-actions">
            <div className="llm-pop-group">Context</div>
            {activePath && (
              <button
                className="llm-pop-item"
                onClick={() => {
                  refCurrent();
                  setMenu(null);
                }}
              >
                <FileText size={15} />
                Attach current page
              </button>
            )}
            <button
              className="llm-pop-item"
              onClick={() => {
                startMention();
                setMenu(null);
              }}
            >
              <At size={15} />
              Mention a page or folder…
            </button>
            <button
              className="llm-pop-item"
              disabled={busy || turns.length === 0}
              onClick={() => {
                reset();
                setMenu(null);
              }}
            >
              <Broom size={15} />
              Clear conversation
            </button>
          </div>
        )}

        {/* Settings popover: model · effort · mode · preset via the app's custom Select. */}
        {menu === "settings" && (
          <div className="llm-pop llm-pop-settings">
            <label className="llm-field">
              <span className="llm-field-label">Provider</span>
              <Select
                value={provider}
                ariaLabel="Provider"
                onChange={(v) => setProvider(v as ProviderId)}
                options={(["claude", "gemini", "codex"] as ProviderId[]).map((id) => {
                  const p = providers.find((x) => x.id === id);
                  const desc = !p?.installed
                    ? "Not installed"
                    : !p?.authenticated
                      ? "Not logged in"
                      : "Ready";
                  return { value: id, label: PROVIDER_LABEL[id], desc };
                })}
              />
            </label>
            <label className="llm-field">
              <span className="llm-field-label">Model</span>
              <Select
                value={model}
                ariaLabel="Model"
                onChange={setModel}
                options={MODELS[provider].map((c) => ({
                  value: c.value,
                  label: c.label,
                  desc: c.desc,
                }))}
              />
            </label>
            <label className="llm-field">
              <span className="llm-field-label">Reasoning effort</span>
              <Select
                value={effort}
                ariaLabel="Reasoning effort"
                onChange={setEffort}
                options={
                  supportsEffort(provider)
                    ? EFFORTS[provider].map((c) => ({ value: c.value, label: c.label, desc: c.desc }))
                    : [{ value: "", label: "Not supported for this provider" }]
                }
              />
            </label>
            <label className="llm-field">
              <span className="llm-field-label">Mode</span>
              <Select
                value={mode}
                ariaLabel="Mode"
                onChange={(v) => setMode(v as LlmMode)}
                options={MODES.map((m) => ({ value: m.value, label: m.label, desc: m.hint }))}
              />
            </label>
            <label className="llm-field">
              <span className="llm-field-label">Role preset</span>
              <Select
                value={preset}
                ariaLabel="Role preset"
                onChange={setPreset}
                options={PRESETS.map((p) => ({ value: p.value, label: p.label }))}
              />
            </label>
          </div>
        )}

        {/* Mode nudge: file edits need Agent mode. One tap switches and refocuses the input. */}
        {showAgentHint && (
          <div className="llm-mode-hint">
            <Robot size={14} weight="duotone" />
            <span>
              Editing files needs <strong>Agent</strong> mode — {modeLabel} mode can only chat.
            </span>
            <button
              className="llm-mode-hint-btn"
              onClick={() => {
                setMode("agent");
                inputRef.current?.focus();
              }}
            >
              Switch to Agent
            </button>
          </div>
        )}

        <textarea
          ref={inputRef}
          className="llm-input"
          value={input}
          onChange={onInputChange}
          onKeyDown={onInputKeyDown}
          placeholder={ready ? "Ask anything…  ( [[ to reference · Enter to send )" : "Unavailable"}
          rows={2}
          disabled={!ready}
        />

        {/* Toolbar: + actions · settings · status pills · send. */}
        <div className="llm-composer-bar">
          <button
            className={`llm-tool-btn${menu === "actions" ? " active" : ""}`}
            title="Add context"
            onClick={() => setMenu((m) => (m === "actions" ? null : "actions"))}
            disabled={!ready}
          >
            <Plus size={16} />
          </button>
          <button
            className={`llm-tool-btn${menu === "settings" ? " active" : ""}`}
            title="Model & options"
            onClick={() => setMenu((m) => (m === "settings" ? null : "settings"))}
            disabled={busy}
          >
            <SlidersHorizontal size={16} />
          </button>
          <button
            className="llm-status"
            title="Model & options"
            onClick={() => setMenu((m) => (m === "settings" ? null : "settings"))}
            disabled={busy}
          >
            <span className="llm-status-model">{modelLabel}</span>
            <span className="llm-status-sep">·</span>
            <span>{modeLabel}</span>
            {effortLabel && (
              <>
                <span className="llm-status-sep">·</span>
                <span>{effortLabel}</span>
              </>
            )}
          </button>
          <span className="llm-bar-spacer" />
          {busy ? (
            <button className="llm-send-btn llm-send-stop" title="Stop" onClick={stop}>
              <Stop size={16} weight="fill" />
            </button>
          ) : (
            <button
              className="llm-send-btn"
              title="Send (Enter)"
              onClick={send}
              disabled={!ready || !input.trim()}
            >
              <PaperPlaneRight size={16} weight="fill" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
