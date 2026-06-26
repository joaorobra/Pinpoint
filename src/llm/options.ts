// Per-provider model / effort / preset option lists for the LLM composer.
//
// Single source of truth so the composer and a future settings panel agree. Claude's values are
// confirmed against the current CLI (`--model` aliases, `--effort` levels). Gemini/Codex lists are
// left minimal until their adapters land and their flags are verified — don't assume their model
// ids here.

import type { ProviderId } from "./transport";

export interface Choice {
  value: string;
  label: string;
  /** Optional one-line subtitle shown under the label in the custom Select menu (VS Code style). */
  desc?: string;
}

/** "" = let the CLI use its default. */
export const DEFAULT_CHOICE: Choice = {
  value: "",
  label: "Default",
  desc: "Let the CLI pick its recommended model",
};

/** Models offered per provider (`--model`). Aliases, not marketing names. */
export const MODELS: Record<ProviderId, Choice[]> = {
  claude: [
    DEFAULT_CHOICE,
    { value: "opus", label: "Opus", desc: "Most capable · best for complex work" },
    { value: "sonnet", label: "Sonnet", desc: "Balanced · efficient for routine tasks" },
    { value: "haiku", label: "Haiku", desc: "Fastest · for quick answers" },
    { value: "fable", label: "Fable", desc: "Creative writing specialist" },
  ],
  // Filled in when the Gemini/Codex adapters land (plan step 4).
  gemini: [DEFAULT_CHOICE],
  codex: [DEFAULT_CHOICE],
};

/** Reasoning effort (`--effort`). Claude only for now; availability is model-dependent. */
export const EFFORTS: Record<ProviderId, Choice[]> = {
  claude: [
    DEFAULT_CHOICE,
    { value: "low", label: "Low", desc: "Quickest, least reasoning" },
    { value: "medium", label: "Medium", desc: "Balanced reasoning" },
    { value: "high", label: "High", desc: "More thorough reasoning" },
    { value: "xhigh", label: "X-High", desc: "Deep reasoning" },
    { value: "max", label: "Max", desc: "Maximum reasoning effort" },
  ],
  gemini: [DEFAULT_CHOICE],
  codex: [DEFAULT_CHOICE],
};

/** Whether a provider supports the effort flag at all (gray the control out otherwise). */
export function supportsEffort(provider: ProviderId): boolean {
  return EFFORTS[provider].length > 1;
}

export type ModeChoice = { value: "chat" | "note" | "agent"; label: string; hint: string };

/** The three use-cases the panel can run in. */
export const MODES: ModeChoice[] = [
  { value: "chat", label: "Chat", hint: "Plain conversation" },
  { value: "note", label: "Note", hint: "Act on referenced pages" },
  { value: "agent", label: "Agent", hint: "Read/edit across the vault" },
];

/** Role presets prepended to the system prompt (`--append-system-prompt`). "" = none. */
export const PRESETS: Choice[] = [
  { value: "", label: "No preset" },
  {
    value: "Be concise and direct. Prefer short answers; skip preamble.",
    label: "Concise",
  },
  {
    value:
      "Act as a careful proofreader. Fix grammar, clarity, and flow; preserve the author's voice and meaning. Return the corrected text.",
    label: "Proofreader",
  },
  {
    value:
      "Act as a brainstorming partner. Offer several distinct ideas, note trade-offs, and ask a clarifying question when useful.",
    label: "Brainstorm",
  },
  {
    value:
      "Summarize the provided context faithfully. Lead with the key point, then supporting detail as tight bullets.",
    label: "Summarizer",
  },
];
