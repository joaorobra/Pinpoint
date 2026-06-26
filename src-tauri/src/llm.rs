//! LLM CLI integration — drive the official `claude` (and later `gemini`/`codex`) CLIs as
//! subprocesses and stream their output back to the frontend.
//!
//! We never touch the CLI's stored subscription credentials. The user logs in once through the
//! CLI's own browser-auth flow; headless invocations (`claude -p …`) reuse that stored login
//! automatically. PINPOINT is purely a frontend that spawns the installed binary and pipes a
//! prompt in / parses streamed JSON out.
//!
//! Step 1 scope: desktop, Claude only, chat mode. Gemini/Codex adapters and the browser
//! companion daemon come later (see docs/llm-cli-integration-plan.md). The event shape and
//! `CliAdapter` boundary here are deliberately provider-neutral so those slot in without
//! reshaping the frontend contract.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

/// Which CLI to drive. Only `Claude` is wired up in step 1; the others are reserved so the
/// frontend `ProviderId` and this enum stay in lockstep as adapters land.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Claude,
    Gemini,
    Codex,
}

impl ProviderId {
    /// The executable name we look for on PATH.
    fn bin_name(self) -> &'static str {
        match self {
            ProviderId::Claude => "claude",
            ProviderId::Gemini => "gemini",
            ProviderId::Codex => "codex",
        }
    }
}

/// What the frontend's provider-detection UI renders per CLI.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderStatus {
    pub id: ProviderId,
    /// Binary found on PATH.
    pub installed: bool,
    /// Login token present (best-effort: we look for the CLI's credential file, never read it).
    pub authenticated: bool,
    /// Resolved absolute path to the binary, if found.
    pub bin_path: Option<String>,
}

/// A run request from the frontend. Mirrors `RunRequest` in src/llm/transport.ts.
#[derive(Debug, Clone, Deserialize)]
pub struct RunRequest {
    pub provider: ProviderId,
    /// Unique id the frontend generates so it can correlate the event stream and cancel.
    pub run_id: String,
    pub prompt: String,
    /// Resume a prior turn (multi-turn chat). None starts a fresh session.
    #[serde(default)]
    pub session_id: Option<String>,
    /// chat | note | agent. Step 1 only exercises "chat"; the field is threaded now so the
    /// argv builder can branch on it without a request-shape change later.
    #[serde(default = "default_mode")]
    pub mode: String,
    /// Working directory for agent mode (the vault root). Unused in chat mode.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Model alias/id (`--model`). None = the CLI's default model.
    #[serde(default)]
    pub model: Option<String>,
    /// Reasoning effort (`--effort`): low|medium|high|xhigh|max. None = default.
    #[serde(default)]
    pub effort: Option<String>,
    /// Extra system-prompt text appended via `--append-system-prompt` (role preset).
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Directories to grant as context (`--add-dir`, one flag each). Used when a folder is
    /// referenced or in agent mode. Empty in plain chat.
    #[serde(default)]
    pub add_dirs: Vec<String>,
}

fn default_mode() -> String {
    "chat".to_string()
}

/// Normalized streamed event — identical across providers so the frontend never branches on
/// which CLI produced it. Mirrors `LlmEvent` in src/llm/transport.ts. Emitted on the
/// per-run Tauri event channel `llm://<run_id>`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LlmEvent {
    /// Session metadata at stream start. `session_id` is what the frontend stores to resume.
    Init { session_id: String, model: String },
    /// An incremental chunk of assistant text.
    Text { delta: String },
    /// The model invoked a tool (agent mode). Surfaced so the UI can show activity.
    Tool { name: String },
    /// Final event. `session_id` repeated so a one-shot (non-streaming) caller still gets it.
    Done {
        session_id: Option<String>,
        cost_usd: Option<f64>,
    },
    /// Terminal failure (spawn failed, non-zero exit, parse gave up).
    Error { message: String },
}

/// Cancellation registry: run_id -> a sender that, when fired, kills the child. Lives in
/// `AppState`; commands reach it through `tauri::State`.
#[derive(Default)]
pub struct LlmState {
    cancels: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl LlmState {
    fn register(&self, run_id: &str, tx: oneshot::Sender<()>) {
        self.cancels.lock().unwrap().insert(run_id.to_string(), tx);
    }
    fn take(&self, run_id: &str) -> Option<oneshot::Sender<()>> {
        self.cancels.lock().unwrap().remove(run_id)
    }
}

/// Locate a binary on PATH (cross-platform). Returns its absolute path if runnable.
fn which(bin: &str) -> Option<String> {
    // `which`/`where` differ per-OS; do the PATH walk ourselves so there's no shell dependency.
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into())
            .split(';')
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path) {
        // Try the bare name and each executable extension (Windows ships `claude.cmd`).
        let candidates = std::iter::once(dir.join(bin)).chain(exts.iter().filter_map(|e| {
            if e.is_empty() {
                None
            } else {
                Some(dir.join(format!("{bin}{e}")))
            }
        }));
        for cand in candidates {
            if cand.is_file() {
                return Some(cand.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Best-effort check that a CLI has a stored login, without ever reading the credential. We only
/// test for the presence of the well-known file/dir each CLI writes after browser auth.
fn is_authenticated(provider: ProviderId) -> bool {
    let Some(home) = dirs_home() else {
        return false;
    };
    match provider {
        // Windows: %USERPROFILE%\.claude\.credentials.json. macOS stores in Keychain, so we
        // fall back to "the .claude dir exists" there — detection is a hint, not a gate.
        ProviderId::Claude => {
            let creds = home.join(".claude").join(".credentials.json");
            creds.is_file() || home.join(".claude").is_dir()
        }
        ProviderId::Gemini => home.join(".gemini").is_dir(),
        ProviderId::Codex => home.join(".codex").is_dir(),
    }
}

/// Home directory without pulling in the `dirs` crate (one call site).
fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(Into::into)
}

/// Detect every provider for the settings UI.
pub fn detect_all() -> Vec<ProviderStatus> {
    [ProviderId::Claude, ProviderId::Gemini, ProviderId::Codex]
        .into_iter()
        .map(|id| {
            let bin_path = which(id.bin_name());
            ProviderStatus {
                id,
                installed: bin_path.is_some(),
                authenticated: is_authenticated(id),
                bin_path,
            }
        })
        .collect()
}

/// Build the argv for a run. Step 1 implements Claude chat; other providers/modes return an
/// error until their adapters land, so the failure is explicit rather than a silent wrong spawn.
fn build_argv(req: &RunRequest) -> Result<Vec<String>, String> {
    match req.provider {
        ProviderId::Claude => {
            // ISOLATION (critical): without this, the subprocess auto-discovers the user's MCP
            // servers (e.g. context-mode), which leaked tool calls and other-project context into
            // the chat. `--strict-mcp-config` loads MCP only from `--mcp-config`; we pass none → zero
            // MCP servers. (Confirmed against the live CLI: yields `mcp_servers:[]`.)
            //
            // NOTE: do NOT add `--bare` here. It additionally skips the OAuth/keychain credential
            // load, so the subprocess comes up "Not logged in" and exits 1 for subscription users.
            // Tool isolation below + strict-mcp is enough; --bare breaks auth.
            let mut args = vec![
                "--strict-mcp-config".to_string(),
                "-p".to_string(),
                req.prompt.clone(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--include-partial-messages".to_string(),
            ];
            if let Some(sid) = &req.session_id {
                args.push("--resume".to_string());
                args.push(sid.clone());
            }
            if let Some(model) = &req.model {
                if !model.is_empty() {
                    args.push("--model".to_string());
                    args.push(model.clone());
                }
            }
            if let Some(effort) = &req.effort {
                if !effort.is_empty() {
                    args.push("--effort".to_string());
                    args.push(effort.clone());
                }
            }
            if let Some(sys) = &req.system_prompt {
                if !sys.trim().is_empty() {
                    args.push("--append-system-prompt".to_string());
                    args.push(sys.clone());
                }
            }
            // Grant context directories (referenced folder / agent mode). One flag per path.
            for dir in &req.add_dirs {
                args.push("--add-dir".to_string());
                args.push(dir.clone());
            }
            // chat/note: a pure text assistant — disable EVERY tool (the `*` glob matches MCP tools
            // too). Note content reaches the model only via the injected `[[ref]]` preamble, never
            // by the model reading files.
            if req.mode == "chat" || req.mode == "note" {
                args.push("--disallowedTools".to_string());
                args.push("*".to_string());
                // Belt-and-suspenders: also clear the built-in tool set.
                args.push("--tools".to_string());
                args.push(String::new());
                // With no tools, the model can still CLAIM it created/edited a file — the user then
                // sees nothing change on disk ("it says it wrote but didn't"). Tell the model the
                // truth about its capabilities so it stops pretending and routes the user to Agent
                // mode, which is the only mode that can touch files. Appended as its own
                // system-prompt segment (a later `--append-system-prompt` does NOT override an
                // earlier one — the CLI concatenates them).
                args.push("--append-system-prompt".to_string());
                args.push(
                    "IMPORTANT: You have NO file tools in this mode. You CANNOT create, write, or \
                     edit any file, and you must never claim or imply that you did. If the user \
                     asks you to create/write/edit/save a file or a note, do not pretend to do it: \
                     briefly explain that file editing only works in \"Agent\" mode and ask them \
                     to switch the mode (the sliders icon in the composer) to Agent, then resend. \
                     You may still show the proposed file contents inline so they can copy it."
                        .to_string(),
                );
            } else if req.mode == "agent" {
                // agent mode keeps tools, confined to the vault by --add-dir + cwd. CRITICAL: in
                // headless `-p` there's no TTY to approve edits, so the default permission mode
                // would silently DENY every Edit/Write — the model narrates the tool call but the
                // file never changes. `acceptEdits` auto-accepts file edits/writes (still confined
                // to the granted dirs), so edits actually apply.
                args.push("--permission-mode".to_string());
                args.push("acceptEdits".to_string());
            }
            Ok(args)
        }
        ProviderId::Gemini | ProviderId::Codex => {
            Err("provider not yet supported (step 1 is Claude-only)".to_string())
        }
    }
}

/// Parse one line of Claude's `stream-json` output into a normalized event. Returns None for
/// lines we intentionally ignore (keep-alives, event types the UI doesn't surface).
fn parse_claude_line(line: &str) -> Option<LlmEvent> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let ty = v.get("type")?.as_str()?;
    match ty {
        "system" => {
            // init carries session_id + model.
            if v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                let session_id = v
                    .get("session_id")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default()
                    .to_string();
                let model = v
                    .get("data")
                    .and_then(|d| d.get("model"))
                    .and_then(|m| m.as_str())
                    .or_else(|| v.get("model").and_then(|m| m.as_str()))
                    .unwrap_or("claude")
                    .to_string();
                return Some(LlmEvent::Init { session_id, model });
            }
            None
        }
        "stream_event" => {
            let event = v.get("event")?;
            // Text delta.
            if let Some(text) = event
                .get("delta")
                .and_then(|d| d.get("text"))
                .and_then(|t| t.as_str())
            {
                return Some(LlmEvent::Text {
                    delta: text.to_string(),
                });
            }
            // Tool invocation.
            if event.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                let name = event
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool")
                    .to_string();
                return Some(LlmEvent::Tool { name });
            }
            None
        }
        // Final result line (also seen as "result"). Carries session_id + cost — and, on failure,
        // `is_error:true` with the human message in `result` (e.g. "Not logged in · Please run
        // /login"). Surface that as an Error so the UI shows the real cause, not a bare exit code.
        "message" | "result" => {
            if v.get("is_error").and_then(|b| b.as_bool()) == Some(true) {
                let message = v
                    .get("result")
                    .and_then(|r| r.as_str())
                    .or_else(|| v.get("error").and_then(|e| e.as_str()))
                    .unwrap_or("the CLI reported an error")
                    .to_string();
                return Some(LlmEvent::Error { message });
            }
            let session_id = v
                .get("session_id")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            let cost_usd = v.get("total_cost_usd").and_then(|c| c.as_f64());
            Some(LlmEvent::Done {
                session_id,
                cost_usd,
            })
        }
        _ => None,
    }
}

/// Spawn the CLI for `req`, stream normalized events to `llm://<run_id>`, and register a
/// cancellation handle. Resolves when the child exits (or is cancelled). Errors are emitted as a
/// final `Error` event AND returned, so the caller's `invoke` rejection and the stream agree.
pub async fn run(
    app: AppHandle,
    state: &LlmState,
    req: RunRequest,
) -> Result<(), String> {
    let channel = format!("llm://{}", req.run_id);
    let emit = {
        let app = app.clone();
        let channel = channel.clone();
        move |ev: LlmEvent| {
            let _ = app.emit(&channel, ev);
        }
    };

    let bin = which(req.provider.bin_name())
        .ok_or_else(|| format!("{} CLI not found on PATH", req.provider.bin_name()))?;
    let argv = build_argv(&req)?;

    let mut cmd = Command::new(&bin);
    cmd.args(&argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Working directory: NEVER inherit the app's launch directory. Claude Code auto-discovers a
    // "project" (git status, CLAUDE.md, the working tree) from its cwd, so inheriting the app's dir
    // (the Pinpoint repo during dev) leaks our source + git changes into the chat. Pin cwd to the
    // vault root when given, else a neutral temp dir so there's nothing to discover.
    match &req.cwd {
        Some(cwd) if !cwd.is_empty() => {
            cmd.current_dir(cwd);
        }
        _ => {
            cmd.current_dir(std::env::temp_dir());
        }
    }
    // Don't pop a console window on Windows for the child process. `tokio::process::Command`
    // re-exports `creation_flags` from the std `CommandExt` trait (already in scope via tokio),
    // so no extra import is needed.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!("failed to launch {bin}: {e}");
        emit(LlmEvent::Error {
            message: msg.clone(),
        });
        msg
    })?;

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    // Cancellation: firing this kills the child mid-stream.
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    state.register(&req.run_id, cancel_tx);

    let mut lines = BufReader::new(stdout).lines();
    let mut saw_done = false;

    loop {
        tokio::select! {
            // Cancelled from the frontend.
            _ = &mut cancel_rx => {
                let _ = child.start_kill();
                emit(LlmEvent::Done { session_id: None, cost_usd: None });
                state.take(&req.run_id);
                return Ok(());
            }
            line = lines.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        if let Some(ev) = parse_claude_line(&l) {
                            if matches!(ev, LlmEvent::Done { .. }) {
                                saw_done = true;
                            }
                            emit(ev);
                        }
                    }
                    Ok(None) => break, // EOF
                    Err(e) => {
                        let msg = format!("stream read error: {e}");
                        emit(LlmEvent::Error { message: msg.clone() });
                        state.take(&req.run_id);
                        return Err(msg);
                    }
                }
            }
        }
    }

    // Drain the child and check exit status.
    let status = child.wait().await.map_err(|e| e.to_string())?;
    state.take(&req.run_id);

    if !status.success() {
        // Surface stderr so auth/usage errors are actionable rather than a bare exit code.
        let mut err_text = String::new();
        let mut err_lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = err_lines.next_line().await {
            err_text.push_str(&l);
            err_text.push('\n');
        }
        let msg = if err_text.trim().is_empty() {
            format!("{} exited with {}", req.provider.bin_name(), status)
        } else {
            err_text.trim().to_string()
        };
        emit(LlmEvent::Error {
            message: msg.clone(),
        });
        return Err(msg);
    }

    // Some versions don't emit a final result line in stream mode; synthesize Done so the UI
    // always gets a terminal event.
    if !saw_done {
        emit(LlmEvent::Done {
            session_id: None,
            cost_usd: None,
        });
    }
    Ok(())
}

/// Fire a registered run's cancellation. No-op if the run already finished.
pub fn cancel(state: &LlmState, run_id: &str) {
    if let Some(tx) = state.take(run_id) {
        let _ = tx.send(());
    }
}
