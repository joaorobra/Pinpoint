// LLM CLI integration — frontend transport contract.
//
// One interface, two implementations (mirrors how src/api.ts abstracts native vs FSA vault):
//   - TauriTransport: invoke() commands + listen() on the per-run event channel (this file, below).
//   - WsTransport (later): JSON frames over the localhost companion daemon, for the browser build.
//
// The chat panel imports `llmTransport` and never knows which host it's on. Provider-neutral by
// design so Gemini/Codex slot in behind the same shapes. See docs/llm-cli-integration-plan.md.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../api";

export type ProviderId = "claude" | "gemini" | "codex";

export interface ProviderStatus {
  id: ProviderId;
  installed: boolean; // binary found on PATH
  authenticated: boolean; // login token present (presence-checked, never read)
  binPath: string | null;
}

export type LlmMode = "chat" | "note" | "agent";

export interface RunRequest {
  provider: ProviderId;
  prompt: string;
  /** Resume a prior turn for multi-turn chat. Omit to start fresh. */
  sessionId?: string;
  mode: LlmMode;
  /** Vault root for agent mode. Ignored otherwise. */
  cwd?: string;
  /** Model alias/id (`--model`). Omit for the CLI's default. */
  model?: string;
  /** Reasoning effort (`--effort`): low|medium|high|xhigh|max. Omit for default. */
  effort?: string;
  /** Role-preset text appended to the system prompt (`--append-system-prompt`). */
  systemPrompt?: string;
  /** Directories granted as context (`--add-dir`). Used for a referenced folder / agent mode. */
  addDirs?: string[];
}

/** Normalized streamed event — identical across providers. Mirrors Rust `LlmEvent`. */
export type LlmEvent =
  | { kind: "init"; sessionId: string; model: string }
  | { kind: "text"; delta: string }
  | { kind: "tool"; name: string }
  | { kind: "done"; sessionId?: string | null; costUsd?: number | null }
  | { kind: "error"; message: string };

export interface LlmTransport {
  /** Which CLIs are installed + logged in (for the settings/detection UI). */
  listProviders(): Promise<ProviderStatus[]>;
  /**
   * Start a run. `onEvent` fires for every streamed event; the returned promise resolves when the
   * run ends (after the terminal `done`/`error` event). Returns the `runId` via `onStart` so the
   * caller can cancel mid-stream.
   */
  run(
    req: RunRequest,
    onEvent: (e: LlmEvent) => void,
    onStart?: (runId: string) => void
  ): Promise<void>;
  cancel(runId: string): Promise<void>;
}

/** Generate a unique run id (correlates the event channel + cancellation). */
function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Raw shape coming back from llm_providers (Rust serializes bin_path as snake_case).
interface RawProviderStatus {
  id: ProviderId;
  installed: boolean;
  authenticated: boolean;
  bin_path: string | null;
}

/** Tauri-backed transport: in-process subprocess driving via Rust commands. */
class TauriTransport implements LlmTransport {
  async listProviders(): Promise<ProviderStatus[]> {
    const raw = await invoke<RawProviderStatus[]>("llm_providers");
    return raw.map((r) => ({
      id: r.id,
      installed: r.installed,
      authenticated: r.authenticated,
      binPath: r.bin_path,
    }));
  }

  async run(
    req: RunRequest,
    onEvent: (e: LlmEvent) => void,
    onStart?: (runId: string) => void
  ): Promise<void> {
    const runId = newRunId();
    onStart?.(runId);

    // Subscribe to the per-run channel BEFORE invoking so no early event is missed.
    let unlisten: UnlistenFn | null = null;
    let settle: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      settle = resolve;
    });

    unlisten = await listen<LlmEvent>(`llm://${runId}`, (e) => {
      const ev = e.payload;
      onEvent(ev);
      if (ev.kind === "done" || ev.kind === "error") settle();
    });

    try {
      // `llm_run` resolves when the subprocess exits. The terminal event usually arrives first,
      // but we also settle here in case the stream ended without one. The `req` struct is
      // deserialized by serde, which does NOT apply Tauri's camelCase→snake_case mapping to
      // nested fields — so build the snake_case payload explicitly.
      await invoke<void>("llm_run", {
        req: {
          provider: req.provider,
          run_id: runId,
          prompt: req.prompt,
          session_id: req.sessionId ?? null,
          mode: req.mode,
          cwd: req.cwd ?? null,
          model: req.model ?? null,
          effort: req.effort ?? null,
          system_prompt: req.systemPrompt ?? null,
          add_dirs: req.addDirs ?? [],
        },
      });
    } catch (err) {
      onEvent({ kind: "error", message: String(err) });
    } finally {
      // Give any trailing event a tick to deliver, then tear down.
      await ended.catch(() => {});
      unlisten?.();
    }
  }

  async cancel(runId: string): Promise<void> {
    await invoke<void>("llm_cancel", { runId });
  }
}

/** Placeholder until the companion-daemon WS transport lands (browser build, plan step 6). */
class UnavailableTransport implements LlmTransport {
  async listProviders(): Promise<ProviderStatus[]> {
    return [];
  }
  async run(_req: RunRequest, onEvent: (e: LlmEvent) => void): Promise<void> {
    onEvent({
      kind: "error",
      message:
        "LLM integration needs the desktop app (or the local companion daemon, coming soon).",
    });
  }
  async cancel(): Promise<void> {}
}

/** The transport for the current host. Web build gets the placeholder until step 6. */
export const llmTransport: LlmTransport = isTauri()
  ? new TauriTransport()
  : new UnavailableTransport();
