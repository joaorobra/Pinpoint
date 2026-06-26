# PINPOINT — LLM CLI Integration Plan

Drive the official **Claude Code**, **Gemini**, and **Codex/OpenAI** CLIs as subprocesses.
The user logs in once through each CLI's own browser auth (their subscription, official
client). PINPOINT never touches or extracts the subscription token — it only spawns the
installed binary and streams stdin/stdout. This is the legitimate, ToS-safe path.

---

## 1. Why subprocess, not token reuse

Subscription OAuth (Claude Pro/Max, Gemini, ChatGPT Plus) is tied to each tool's official
client and stored encrypted/0600 on disk. Reusing those tokens in our own app is a ToS
gray-zone and brittle (rotation, flow changes). Instead we **shell out to the real CLI**:
the login stays 100% inside the official tool; we are just a frontend to it.

**Confirmed facts (Claude Code, current):**
- Headless: `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages`
- Stream is newline-delimited JSON: `system/init`, `stream_event` (text_delta, tool_use,
  tool_result), final `result` with `session_id`, `usage`, `total_cost_usd`.
- Multi-turn across invocations: capture `session_id`, then `--resume <id>` (same cwd).
- Auth: one-time `claude` login → token on disk (`%USERPROFILE%\.claude\.credentials.json`
  on Windows). Headless calls reuse it automatically. No re-auth.
- Scope/safety: `--add-dir`, `--allowedTools`, `--disallowedTools`, `--permission-mode`.
- An official `@anthropic-ai/claude-agent-sdk` exists but we deliberately use the **raw
  binary** so the same adapter shape works for Gemini and Codex (no per-vendor SDK lock-in).

Gemini CLI (`gemini`) and Codex/OpenAI CLI follow the same spawn-and-stream pattern with
their own flags; each is wrapped behind a common adapter (§4).

---

## 2. The target split (this is the core architecture)

A web page **cannot** spawn processes or read the filesystem. So the capability has two
delivery surfaces behind **one identical frontend API**:

```
┌────────────────────────────────────────────────────────────┐
│  React frontend (LLM panel) — identical in both builds      │
│  calls llm.send(), llm.stream(), llm.listProviders()        │
└───────────────┬───────────────────────────┬────────────────┘
                │                            │
      Tauri build (desktop)        Browser build
                │                            │
   Rust commands spawn CLI         WebSocket to localhost
   directly (in-process)           companion daemon
                │                            │
                └─────────► same CLI adapter logic ◄──────────┘
                              (spawn, stream-json parse)
```

- **Desktop (Tauri):** Rust spawns the CLI in-process. Zero extra moving parts.
- **Browser:** a tiny **companion daemon** (the same Rust core compiled as a CLI/service,
  or a Node sidecar) runs on the user's machine, exposes `ws://127.0.0.1:<port>`, and the
  browser build connects to it. Same adapter, just reached over a socket.

The frontend never knows which transport it's on — it talks to an `LlmTransport`
interface, mirroring how the existing `api` layer abstracts native vs FSA-vault.

---

## 3. Frontend contract (`src/llm/transport.ts`)

```ts
type ProviderId = "claude" | "gemini" | "codex";

interface ProviderStatus {
  id: ProviderId;
  installed: boolean;       // binary found on PATH
  authenticated: boolean;   // login token present
  binPath: string | null;
}

interface RunRequest {
  provider: ProviderId;
  prompt: string;
  sessionId?: string;       // resume a prior turn
  mode: "chat" | "note" | "agent";
  cwd?: string;             // vault path for agent mode
  allowedTools?: string[];  // agent mode scoping
}

// Streamed events, normalized across all three CLIs:
type LlmEvent =
  | { kind: "init"; sessionId: string; model: string }
  | { kind: "text"; delta: string }
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "tool_result"; name: string; ok: boolean }
  | { kind: "done"; sessionId: string; usage?: Usage; costUsd?: number }
  | { kind: "error"; message: string };

interface LlmTransport {
  listProviders(): Promise<ProviderStatus[]>;
  run(req: RunRequest, onEvent: (e: LlmEvent) => void): Promise<void>;
  cancel(runId: string): Promise<void>;
}
```

Two implementations: `TauriTransport` (invoke + event listen) and `WsTransport`
(JSON frames over the companion socket). The panel imports whichever the build provides,
exactly like the vault layer.

---

## 4. CLI adapter (shared core)

One trait, three impls. Each adapter owns: locating the binary, building argv, spawning,
parsing that vendor's stream format into the normalized `LlmEvent`s above.

```
trait CliAdapter {
  fn detect(&self) -> ProviderStatus;          // which/where + auth check
  fn build_argv(&self, req: &RunRequest) -> Vec<String>;
  fn parse_line(&self, line: &str) -> Option<LlmEvent>;  // vendor JSON → normalized
}
```

- **ClaudeAdapter** — flags from §1; parse `stream-json` lines.
- **GeminiAdapter** — `gemini` headless/JSON flags; map its event shape.
- **CodexAdapter** — OpenAI CLI headless/JSON flags; map its event shape.

Spawn with `tokio::process::Command`, read stdout line-by-line, emit each parsed event to
the frontend (Tauri `emit` per run-id channel / WS frame). `cancel` kills the child.

---

## 5. The three use cases (all map onto §3)

1. **Chat panel** — `mode: "chat"`, no cwd, tools disabled. Side panel, multi-turn via
   `sessionId`. New right-hand dock in `App.tsx`, styled with existing CSS variables.
2. **Act on current note** — `mode: "note"`. Inject the open page's markdown (or selection)
   into the prompt as context. Commands: Summarize / Rewrite / Extract tasks / Custom.
   Results can be inserted back into the editor (reuse the attachment-insert plumbing).
3. **Agentic over vault** — `mode: "agent"`, `cwd = vaultRoot`, `--add-dir vaultRoot`,
   scoped `allowedTools` (Read/Edit/Glob; Bash gated behind an explicit toggle). Claude
   Code's permission-mode keeps edits visible. **Always confirmed by the user** before any
   write, surfaced as a diff (reuse the 3-way Keep/Trash/Delete dialog pattern).

---

## 6. Safety / trust rules (non-negotiable)

- **No silent file writes.** Agent mode runs with edit confirmation; show diffs before apply.
- **Vault-scoped only.** `--add-dir` is the vault root; never the whole disk.
- **Bash off by default** in agent mode; opt-in per session with a clear warning.
- **Companion daemon binds `127.0.0.1` only**, random port, one-time pairing token the
  desktop app/UX hands to the browser tab. No LAN exposure.
- **Encrypted-vault interaction:** if a scope is locked (see `[[vault-encryption]]`), the
  agent cannot read it until unlocked in-session.
- We **never read, copy, or transmit** any CLI's credential file.

---

## 7. Build order (incremental, each step shippable)

1. **Desktop, Claude-only, chat mode.** Rust `llm_run` command + `ClaudeAdapter` +
   `TauriTransport` + minimal chat panel. Proves the spawn/stream/parse loop end-to-end.
2. **Provider detection UI.** `listProviders()` + a settings section showing
   installed/authenticated per CLI, with "how to log in" hints (links to each CLI's login).
3. **Act-on-note mode** wired to the editor (context injection + insert-back).
4. **Gemini + Codex adapters** behind the same trait.
5. **Agentic mode** with `--add-dir`, tool scoping, diff-confirm UI.
6. **Companion daemon + `WsTransport`** to bring the browser build to parity (last, because
   it's the most work and desktop already delivers full value).

---

## 8. Open questions to resolve before coding step 1

- Companion daemon language: reuse the Rust core as a second binary, or a small Node
  sidecar? (Rust = one codebase; Node = faster to write the WS layer.)
- Where do per-provider sessions live so chat history survives app restarts — in
  `<vault>/.pinpoint/` (travels with vault) or app-global like recent-vaults?
- Codex/OpenAI CLI exact headless flags + stream shape still need the same verification
  pass we did for Claude Code (don't assume; confirm before writing CodexAdapter).
