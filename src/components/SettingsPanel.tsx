import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  X,
  Palette,
  FolderSimple,
  PencilSimple,
  CalendarBlank,
  CheckSquare,
  Plus,
  Trash,
  ArrowUDownLeft,
  MagnifyingGlass,
  Robot,
} from "@phosphor-icons/react";
import type { Settings } from "../types";
import { DEFAULT_SMART_REPLACEMENTS } from "../types";
import { MODELS, EFFORTS, MODES, PRESETS, supportsEffort } from "../llm/options";
import Select, { type SelectGroup, type SelectOption } from "./Select";
import { useFocusTrap } from "../hooks/useFocusTrap";
import ColorPicker from "./ColorPicker";
import ThemeManager from "./ThemeManager";
import { formatDate, DATE_PRESETS, TIME_PRESETS, DONE_PRESETS } from "../dateformat";
import { PERIODS } from "../periodic";
import type { TemplateInfo } from "../templates";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  /** Templates discovered in the vault, for the periodic-template bindings. */
  templates?: TemplateInfo[];
  /** All markdown pages in the vault, for the "open a specific page on startup" picker. */
  pages?: { name: string; rel_path: string }[];
}

const FONT_GROUPS: SelectGroup[] = [
  {
    label: "Sans-serif",
    options: [
      "Inter, system-ui, sans-serif",
      "'Hanken Grotesk', system-ui, sans-serif",
      "system-ui, sans-serif",
      "'Segoe UI', sans-serif",
      "Roboto, sans-serif",
      "'Open Sans', sans-serif",
      "Lato, sans-serif",
      "Montserrat, sans-serif",
      "Nunito, sans-serif",
      "'Work Sans', sans-serif",
      "'Source Sans 3', sans-serif",
    ].map(fontOption),
  },
  {
    label: "Serif",
    options: [
      "Georgia, serif",
      "Merriweather, serif",
      "Fraunces, serif",
      "Lora, serif",
      "'Playfair Display', serif",
      "'Source Serif 4', serif",
      "'PT Serif', serif",
      "'Libre Baskerville', serif",
      "'Crimson Pro', serif",
      "'EB Garamond', serif",
    ].map(fontOption),
  },
  {
    label: "Monospace",
    options: ["'JetBrains Mono', monospace", "'Courier New', monospace"].map(fontOption),
  },
];

function fontOption(f: string): SelectOption {
  return { value: f, label: f.split(",")[0].replace(/'/g, "") };
}

const THEME_OPTIONS: SelectOption[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

type TabId = "appearance" | "editor" | "dates" | "tasks" | "vault" | "ai";

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette size={17} /> },
  { id: "editor", label: "Editor", icon: <PencilSimple size={17} /> },
  { id: "dates", label: "Dates & Times", icon: <CalendarBlank size={17} /> },
  { id: "tasks", label: "Tasks", icon: <CheckSquare size={17} /> },
  { id: "ai", label: "AI Chat", icon: <Robot size={17} /> },
  { id: "vault", label: "Vault", icon: <FolderSimple size={17} /> },
];

/**
 * A format picker: a preset dropdown plus a free-text pattern field, with a live preview of the
 * current moment rendered through the pattern. Choosing a preset fills the pattern; editing the
 * pattern by hand switches the dropdown to "Custom". One control reused for each date/time use case.
 */
function FormatPicker({
  value,
  presets,
  sample,
  onChange,
  ariaLabel,
}: {
  value: string;
  presets: { value: string; label: string }[];
  sample: Date;
  onChange: (v: string) => void;
  ariaLabel: string;
}) {
  const isPreset = presets.some((p) => p.value === value);
  const options: SelectOption[] = [
    ...presets.map((p) => ({ value: p.value, label: p.label })),
    { value: "__custom__", label: "Custom…" },
  ];
  return (
    <div className="format-picker">
      <Select
        value={isPreset ? value : "__custom__"}
        options={options}
        onChange={(v) => {
          if (v !== "__custom__") onChange(v);
        }}
        ariaLabel={ariaLabel}
      />
      <input
        className="setting-input format-pattern"
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`${ariaLabel} pattern`}
      />
      <span className="format-preview" aria-live="polite">
        {formatDate(sample, value) || "—"}
      </span>
    </div>
  );
}

/**
 * The active settings search query (lowercased, trimmed), shared down to every Group/Row so each can
 * decide whether it matches and hide itself otherwise. Empty string means "no search — show all".
 */
const SearchContext = createContext("");

/** True when `query` is empty (show everything) or `text` contains it. */
function matchesQuery(query: string, text: string) {
  return !query || text.toLowerCase().includes(query);
}

/** Walk a React child tree collecting the label/hint text of any <Row> elements within. */
function collectRowText(node: ReactNode): string {
  let text = "";
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as { label?: string; hint?: string; children?: ReactNode };
    if (child.type === Row) text += ` ${props.label ?? ""} ${props.hint ?? ""}`;
    if (props.children) text += collectRowText(props.children);
  });
  return text;
}

/**
 * A labelled group of related settings within a tab — the "section" in Notion/Obsidian.
 * `keywords` adds extra searchable text for groups whose controls aren't plain Rows (theme manager,
 * replacement tables, sliders) so they can still surface on a relevant query.
 */
function Group({
  title,
  desc,
  keywords,
  children,
}: {
  title: string;
  desc?: string;
  keywords?: string;
  children: ReactNode;
}) {
  const query = useContext(SearchContext);
  // The group is searchable by its own header text, any author-supplied keywords, and the text of
  // every Row nested inside it — so searching a row's label keeps its group visible.
  const haystack = useMemo(
    () => `${title} ${desc ?? ""} ${keywords ?? ""}${collectRowText(children)}`,
    [title, desc, keywords, children],
  );
  if (!matchesQuery(query, haystack)) return null;
  return (
    <section className="settings-group">
      <header className="settings-group-head">
        <h3>{title}</h3>
        {desc && <p>{desc}</p>}
      </header>
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

/** A single row: a label/description on the left, a control on the right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const query = useContext(SearchContext);
  if (!matchesQuery(query, `${label} ${hint ?? ""}`)) return null;
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <label>{label}</label>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/**
 * An editable trigger→output table over a `Record<string,string>`. Used for both the symbol
 * replacements and the snippets. We edit an ordered array of pairs (so a key can be retyped without
 * the row jumping) and serialize back to a record on every change, dropping blank-trigger rows.
 */
function ReplaceTable({
  value,
  onChange,
  fromLabel,
  toLabel,
  fromPlaceholder,
  toPlaceholder,
  multilineTo,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  fromLabel: string;
  toLabel: string;
  fromPlaceholder: string;
  toPlaceholder: string;
  multilineTo?: boolean;
}) {
  // Local ordered draft; seeded from the record and re-seeded when the record identity changes
  // (e.g. "Reset to defaults"). A trailing blank row is the implicit "add new" affordance.
  const [pairs, setPairs] = useState<[string, string][]>(() => Object.entries(value));
  // Re-seed only when the incoming record differs from our serialized draft (avoids clobbering typing).
  useEffect(() => {
    const serialized = JSON.stringify(Object.fromEntries(pairs.filter(([k]) => k.trim())));
    if (serialized !== JSON.stringify(value)) setPairs(Object.entries(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (next: [string, string][]) => {
    setPairs(next);
    // Last writer wins on duplicate triggers; blank triggers are dropped.
    const rec: Record<string, string> = {};
    for (const [k, v] of next) if (k.trim()) rec[k] = v;
    onChange(rec);
  };

  const editRow = (i: number, k: string, v: string) => {
    const next = pairs.slice();
    next[i] = [k, v];
    commit(next);
  };
  const removeRow = (i: number) => commit(pairs.filter((_, j) => j !== i));
  const addRow = () => setPairs((p) => [...p, ["", ""]]);

  return (
    <div className="sr-table">
      <div className="sr-table-head" aria-hidden>
        <span>{fromLabel}</span>
        <span />
        <span>{toLabel}</span>
        <span />
      </div>
      {pairs.map(([k, v], i) => (
        <div className="sr-row" key={i}>
          <input
            className="sr-input sr-from"
            value={k}
            placeholder={fromPlaceholder}
            spellCheck={false}
            onChange={(e) => editRow(i, e.target.value, v)}
          />
          <span className="sr-arrow" aria-hidden>→</span>
          {multilineTo ? (
            <textarea
              className="sr-input sr-to"
              value={v}
              placeholder={toPlaceholder}
              rows={1}
              onChange={(e) => editRow(i, k, e.target.value)}
            />
          ) : (
            <input
              className="sr-input sr-to"
              value={v}
              placeholder={toPlaceholder}
              onChange={(e) => editRow(i, k, e.target.value)}
            />
          )}
          <button className="sr-del" title="Remove" onClick={() => removeRow(i)}>
            <Trash size={14} />
          </button>
        </div>
      ))}
      <button className="sr-add" onClick={addRow}>
        <Plus size={14} weight="bold" /> Add {fromLabel.toLowerCase()}
      </button>
    </div>
  );
}

/**
 * The empty-state shown while searching. Groups self-filter, so rather than re-derive every match we
 * just look: after this render, does the pane contain any visible group? If not, nothing matched.
 */
function NoResults({ query, pane }: { query: string; pane: React.RefObject<HTMLDivElement> }) {
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    setEmpty(!pane.current?.querySelector(".settings-group"));
  });
  if (!empty) return null;
  return (
    <p className="settings-no-results">
      No settings match “{query}”.
    </p>
  );
}

export default function SettingsPanel({ settings, onChange, onClose, templates = [], pages = [] }: Props) {
  const [tab, setTab] = useState<TabId>("appearance");
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const searching = query.length > 0;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    onChange({ ...settings, [k]: v });
  // A fixed sample so previews don't tick/jitter as the panel re-renders. Mid-afternoon shows
  // both 24h and 12h time clearly. Date.now() is fine in the webview runtime.
  const [sample] = useState(() => {
    const d = new Date();
    d.setHours(14, 30, 5, 0);
    return d;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-title">Settings</div>
          <div className="settings-search">
            <MagnifyingGlass size={15} className="settings-search-icon" aria-hidden />
            <input
              type="search"
              className="settings-search-input"
              placeholder="Search settings…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search settings"
            />
            {search && (
              <button
                className="settings-search-clear"
                onClick={() => setSearch("")}
                title="Clear search"
                aria-label="Clear search"
              >
                <X size={13} weight="bold" />
              </button>
            )}
          </div>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-tab${!searching && tab === t.id ? " active" : ""}`}
              onClick={() => {
                setSearch("");
                setTab(t.id);
              }}
              aria-current={!searching && tab === t.id ? "page" : undefined}
            >
              <span className="settings-tab-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>

        <div className="settings-pane">
          <div className="settings-pane-head">
            <h2>{searching ? `Results for “${search.trim()}”` : TABS.find((t) => t.id === tab)?.label}</h2>
            <button onClick={onClose} title="Close" aria-label="Close settings">
              <X size={16} weight="bold" />
            </button>
          </div>

          <SearchContext.Provider value={query}>
          <div className="settings-pane-body" ref={paneRef}>
            {(searching || tab === "appearance") && (
              <>
                <Group
                  title="Appearance"
                  desc="Choose Dark, Light or follow your system. A theme supplies a palette for each."
                >
                  <Row label="Mode">
                    <Select
                      value={settings.theme}
                      options={THEME_OPTIONS}
                      onChange={(v) => set("theme", v as Settings["theme"])}
                      ariaLabel="Appearance mode"
                      className="select-narrow"
                    />
                  </Row>
                </Group>

                <Group
                  title="Themes"
                  keywords="palette font typeface text size page width color"
                  desc="A theme is a named palette (and optional fonts) with paired dark & light modes, saved in this vault’s .themes folder. Pick one to apply it everywhere; edit or duplicate to make it yours."
                >
                  <ThemeManager
                    activeName={settings.active_theme}
                    onSelect={(name) => set("active_theme", name)}
                    fontGroups={FONT_GROUPS}
                    baseType={{
                      ui: settings.font_family,
                      editor: settings.editor_font_family,
                      size: settings.font_size,
                      lineHeight: settings.line_height,
                      pageWidth: settings.page_width || 820,
                    }}
                  />
                </Group>

                {/* The standalone color overrides apply to the built-in Default only; a theme owns
                    its own palette via the editor above, so we hide these while one is active. */}
                {!settings.active_theme && (
                  <Group
                    title="Default palette"
                    desc="Fine-tune the built-in look. Select or create a theme above for a full, savable palette."
                  >
                    <Row label="Accent color" hint="Used for highlights, links and active states.">
                      <ColorPicker
                        value={settings.accent_color}
                        onChange={(v) => set("accent_color", v)}
                        fallback="#7c5cff"
                        ariaLabel="Accent color"
                      />
                    </Row>
                    <Row label="Background override" hint="Leave unset to follow the mode.">
                      <ColorPicker
                        value={settings.background_color}
                        onChange={(v) => set("background_color", v)}
                        allowReset
                        fallback="#1a1a1f"
                        ariaLabel="Background color override"
                      />
                    </Row>
                    <Row label="Text color override" hint="Leave unset to follow the mode.">
                      <ColorPicker
                        value={settings.text_color}
                        onChange={(v) => set("text_color", v)}
                        allowReset
                        fallback="#e8e8ea"
                        ariaLabel="Text color override"
                      />
                    </Row>
                  </Group>
                )}

                <Group
                  title="Interface"
                  keywords="zoom scale"
                  desc="Scale the whole app — sidebar, toolbars and text together. Also Ctrl +/- and Ctrl 0 to reset. Fonts, text size and page width now live in your theme above."
                >
                  <div className="setting">
                    <label>UI zoom: {Math.round((settings.ui_zoom || 1) * 100)}%</label>
                    <input
                      type="range"
                      min={0.5}
                      max={2}
                      step={0.1}
                      value={settings.ui_zoom || 1}
                      onChange={(e) => set("ui_zoom", +e.target.value)}
                    />
                  </div>
                </Group>

                <Group title="Window" desc="How the app frame behaves.">
                  <Row
                    label="Semi-fullscreen"
                    hint="Hide the titlebar for a chrome-free workspace; move the pointer to the very top edge to reveal the window controls. Desktop only."
                  >
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={settings.auto_hide_titlebar}
                        onChange={(e) => set("auto_hide_titlebar", e.target.checked)}
                      />
                      <span className="switch-track" />
                    </label>
                  </Row>
                </Group>
              </>
            )}

            {(searching || tab === "editor") && (
              <>
              <Group title="Editing" desc="Behavior of the markdown editor.">
                <Row label="Formatting toolbar" hint="Show the floating toolbar (headings, bold, lists…) above the page.">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={settings.show_format_toolbar}
                      onChange={(e) => set("show_format_toolbar", e.target.checked)}
                    />
                    <span className="switch-track" />
                  </label>
                </Row>
                <Row label="Line numbers" hint="Show line numbers in the gutter.">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={settings.show_line_numbers}
                      onChange={(e) => set("show_line_numbers", e.target.checked)}
                    />
                    <span className="switch-track" />
                  </label>
                </Row>
              </Group>

              <Group
                title="Symbol replacements"
                keywords="autoreplace arrow trigger symbol"
                desc="Type the trigger and it becomes the symbol as you write (e.g. -> → →). Backspace right after a swap reverts it."
              >
                <ReplaceTable
                  value={settings.smart_replacements}
                  onChange={(v) => set("smart_replacements", v)}
                  fromLabel="Trigger"
                  toLabel="Symbol"
                  fromPlaceholder="->"
                  toPlaceholder="→"
                />
                <button
                  className="sr-reset"
                  onClick={() => set("smart_replacements", { ...DEFAULT_SMART_REPLACEMENTS })}
                >
                  <ArrowUDownLeft size={14} /> Reset to defaults
                </button>
              </Group>

              <Group
                title="Snippets"
                desc={`Type a name wrapped in the delimiter to expand it — e.g. ${settings.snippet_delimiter}mycnpj${settings.snippet_delimiter} inserts your saved text.`}
              >
                <Row label="Delimiter" hint="Wraps a snippet name to trigger it.">
                  <input
                    className="setting-input sr-delim"
                    value={settings.snippet_delimiter}
                    maxLength={2}
                    onChange={(e) => set("snippet_delimiter", e.target.value || "_")}
                  />
                </Row>
                <ReplaceTable
                  value={settings.snippets}
                  onChange={(v) => set("snippets", v)}
                  fromLabel="Name"
                  toLabel="Expands to"
                  fromPlaceholder="mycnpj"
                  toPlaceholder="12.345.678/0001-90"
                  multilineTo
                />
              </Group>
              </>
            )}

            {(searching || tab === "dates") && (
              <>
                <Group
                  title="Editor inserts"
                  desc="Used by the /today and /date slash commands."
                >
                  <Row label="Date format" hint="Inserted by /today and as the /date default.">
                    <FormatPicker
                      value={settings.date_format}
                      presets={DATE_PRESETS}
                      sample={sample}
                      onChange={(v) => set("date_format", v)}
                      ariaLabel="Editor date format"
                    />
                  </Row>
                  <Row label="Time format" hint="Inserted by the /time command.">
                    <FormatPicker
                      value={settings.time_format}
                      presets={TIME_PRESETS}
                      sample={sample}
                      onChange={(v) => set("time_format", v)}
                      ariaLabel="Editor time format"
                    />
                  </Row>
                </Group>
                <Group title="Periodic notes" desc="The heading written into a new daily note.">
                  <Row label="Daily note label">
                    <FormatPicker
                      value={settings.periodic_label_format}
                      presets={DATE_PRESETS}
                      sample={sample}
                      onChange={(v) => set("periodic_label_format", v)}
                      ariaLabel="Daily note label format"
                    />
                  </Row>
                </Group>
                {!searching && (
                  <p className="settings-hint-block">
                    Patterns use tokens like <code>YYYY</code> <code>MM</code> <code>DD</code>{" "}
                    <code>ddd</code> <code>HH</code> <code>mm</code> <code>A</code>. Wrap literal
                    text in <code>[brackets]</code>, e.g. <code>[Logged] YYYY-MM-DD</code>.
                  </p>
                )}
              </>
            )}

            {(searching || tab === "tasks") && (
              <>
                <Group title="Due dates" desc="How due dates appear in the Tasks view and editor.">
                  <Row label="Due-date format" hint="Format used for due dates in the Tasks view.">
                    <FormatPicker
                      value={settings.task_date_format}
                      presets={DATE_PRESETS}
                      sample={sample}
                      onChange={(v) => set("task_date_format", v)}
                      ariaLabel="Task due-date format"
                    />
                  </Row>
                  <Row
                    label="Highlight due dates"
                    hint="Tint a task's 📅 / due:: date in the editor — red overdue, amber today, soft soon."
                  >
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={settings.highlight_due_dates}
                        onChange={(e) => set("highlight_due_dates", e.target.checked)}
                      />
                      <span className="switch-track" />
                    </label>
                  </Row>
                </Group>
                <Group
                  title="Completion"
                  desc="Stamp when a to-do is finished. Checking its box adds a done:: timestamp; unchecking removes it."
                >
                  <Row
                    label="Record completion date"
                    hint="Add a done:: timestamp to a to-do when you check it off."
                  >
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={settings.stamp_done_date}
                        onChange={(e) => set("stamp_done_date", e.target.checked)}
                      />
                      <span className="switch-track" />
                    </label>
                  </Row>
                  {settings.stamp_done_date && (
                    <Row
                      label="Completion format"
                      hint="Pick a date-only or date + time pattern (or type your own)."
                    >
                      <FormatPicker
                        value={settings.done_date_format}
                        presets={DONE_PRESETS}
                        sample={sample}
                        onChange={(v) => set("done_date_format", v)}
                        ariaLabel="Task completion timestamp format"
                      />
                    </Row>
                  )}
                  {settings.stamp_done_date && (
                    <Row
                      label="Completion prefix"
                      hint="Optional text before the timestamp, e.g. Done or 🎉 (the pill already shows a ✓). Blank for just the date."
                    >
                      <input
                        className="setting-input"
                        value={settings.done_date_prefix}
                        placeholder="Done"
                        maxLength={24}
                        onChange={(e) => set("done_date_prefix", e.target.value)}
                        aria-label="Completion prefix"
                      />
                    </Row>
                  )}
                </Group>
                <Group title="Appearance" desc="How to-dos and their fields look in the editor.">
                  <Row
                    label="Strike completed to-dos"
                    hint="Cross out and dim the text of checked to-do items."
                  >
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={settings.strike_done_tasks}
                        onChange={(e) => set("strike_done_tasks", e.target.checked)}
                      />
                      <span className="switch-track" />
                    </label>
                  </Row>
                  <Row
                    label="Completed to-dos"
                    hint="Keep finished to-dos visible, fade them back, or hide them in the editor."
                  >
                    <Select
                      value={settings.completed_task_display}
                      options={[
                        { value: "show", label: "Show" },
                        { value: "dim", label: "Dim" },
                        { value: "hide", label: "Hide" },
                      ]}
                      onChange={(v) => set("completed_task_display", v as Settings["completed_task_display"])}
                      ariaLabel="Completed to-do display"
                    />
                  </Row>
                  <Row
                    label="Priority display"
                    hint="Show the priority:: field as a coloured flag and word, flag only, or word only."
                  >
                    <Select
                      value={settings.priority_display}
                      options={[
                        { value: "both", label: "Flag + text" },
                        { value: "flag", label: "Flag only" },
                        { value: "text", label: "Text only" },
                      ]}
                      onChange={(v) => set("priority_display", v as Settings["priority_display"])}
                      ariaLabel="Priority display"
                    />
                  </Row>
                </Group>
                {!searching && (
                  <p className="settings-hint-block">
                    Formats use tokens like <code>YYYY</code> <code>MM</code> <code>DD</code>{" "}
                    <code>ddd</code> <code>HH</code> <code>mm</code> <code>A</code>. Wrap literal
                    text in <code>[brackets]</code>, e.g. <code>[Done] YYYY-MM-DD</code>.
                  </p>
                )}
              </>
            )}

            {(searching || tab === "ai") && (() => {
              // Guard against a settings.json that predates these fields (or any non-canonical
              // provider value): fall back to "claude" so MODELS/EFFORTS lookups can't be undefined
              // and crash the whole app to a blank screen.
              const aiProvider = (MODELS[settings.ai_provider as keyof typeof MODELS]
                ? settings.ai_provider
                : "claude") as Settings["ai_provider"];
              return (
              <>
                <Group
                  title="Defaults"
                  keywords="ai chat llm claude gemini codex model effort reasoning mode agent provider cli"
                  desc="Starting point for each new conversation in the AI chat dock (Ctrl/Cmd+J). You can still override any of these per-conversation from the composer."
                >
                  <Row label="Provider" hint="Which CLI to drive. Uses that CLI's own subscription login.">
                    <Select
                      value={aiProvider}
                      options={(["claude", "gemini", "codex"] as const).map((id) => ({
                        value: id,
                        label: id[0].toUpperCase() + id.slice(1),
                      }))}
                      onChange={(v) => set("ai_provider", v as Settings["ai_provider"])}
                      ariaLabel="Default AI provider"
                    />
                  </Row>
                  <Row label="Model" hint="The model new chats start on. “Default” lets the CLI choose.">
                    <Select
                      value={settings.ai_model ?? ""}
                      options={MODELS[aiProvider].map((c) => ({
                        value: c.value,
                        label: c.label,
                        desc: c.desc,
                      }))}
                      onChange={(v) => set("ai_model", v)}
                      ariaLabel="Default AI model"
                    />
                  </Row>
                  <Row label="Reasoning effort" hint="How hard the model thinks before answering, where supported.">
                    <Select
                      value={settings.ai_effort ?? ""}
                      options={
                        supportsEffort(aiProvider)
                          ? EFFORTS[aiProvider].map((c) => ({
                              value: c.value,
                              label: c.label,
                              desc: c.desc,
                            }))
                          : [{ value: "", label: "Not supported for this provider" }]
                      }
                      onChange={(v) => set("ai_effort", v)}
                      ariaLabel="Default reasoning effort"
                    />
                  </Row>
                  <Row label="Mode" hint="Chat talks only; Note acts on referenced pages; Agent can read/edit across the vault.">
                    <Select
                      value={settings.ai_mode ?? "chat"}
                      options={MODES.map((m) => ({ value: m.value, label: m.label, desc: m.hint }))}
                      onChange={(v) => set("ai_mode", v as Settings["ai_mode"])}
                      ariaLabel="Default AI mode"
                    />
                  </Row>
                  <Row label="Role preset" hint="A short instruction prepended to every message (e.g. “Be concise”).">
                    <Select
                      value={settings.ai_preset ?? ""}
                      options={PRESETS.map((p) => ({ value: p.value, label: p.label }))}
                      onChange={(v) => set("ai_preset", v)}
                      ariaLabel="Default role preset"
                    />
                  </Row>
                </Group>
              </>
              );
            })()}

            {(searching || tab === "vault") && (
              <>
                <Group
                  title="Startup"
                  desc="What to open when you open this vault."
                  keywords="startup launch open last page today daily resume restore where i left off"
                >
                  <Row label="On open" hint="Restore your last page, jump to today's daily note, or always open one page.">
                    <Select
                      value={settings.startup_behavior}
                      options={[
                        { value: "last", label: "Open last page" },
                        { value: "today", label: "Open today's daily note" },
                        { value: "page", label: "Open a specific page" },
                      ]}
                      onChange={(v) => set("startup_behavior", v as Settings["startup_behavior"])}
                      ariaLabel="Startup behaviour"
                    />
                  </Row>
                  {settings.startup_behavior === "page" && (
                    <Row label="Page to open">
                      <Select
                        value={settings.startup_page}
                        options={[
                          { value: "", label: pages.length ? "Choose a page…" : "No pages yet" },
                          ...pages.map((p) => ({ value: p.rel_path, label: p.rel_path.replace(/\.md$/i, "") })),
                        ]}
                        onChange={(v) => set("startup_page", v)}
                        ariaLabel="Startup page"
                      />
                    </Row>
                  )}
                </Group>

                <Group
                  title="Periodic notes"
                  desc="Where daily / weekly notes are created and looked up."
                >
                  <Row label="Periodic notes folder">
                    <input
                      className="setting-input"
                      value={settings.periodic_folder}
                      onChange={(e) => set("periodic_folder", e.target.value)}
                    />
                  </Row>
                </Group>

                <Group
                  title="Templates"
                  desc="Reusable page bodies with {{variables}}. Each .md file in this folder is a template."
                >
                  <Row label="Templates folder">
                    <input
                      className="setting-input"
                      value={settings.templates_folder}
                      onChange={(e) => set("templates_folder", e.target.value)}
                    />
                  </Row>
                </Group>

                <Group
                  title="Periodic templates"
                  desc="Use a template when creating each kind of periodic note. “Built-in” keeps the default starter."
                >
                  {PERIODS.map((p) => (
                    <Row key={p} label={p[0].toUpperCase() + p.slice(1)}>
                      <Select
                        value={settings.periodic_templates[p] ?? ""}
                        options={[
                          { value: "", label: "Built-in" },
                          ...templates.map((t) => ({ value: t.rel_path, label: t.name })),
                        ]}
                        onChange={(v) => {
                          const next = { ...settings.periodic_templates };
                          if (v) next[p] = v; else delete next[p];
                          set("periodic_templates", next);
                        }}
                      />
                    </Row>
                  ))}
                </Group>
              </>
            )}

            {searching && <NoResults query={query} pane={paneRef} />}
          </div>
          </SearchContext.Provider>

          <p className="settings-footnote">
            Saved to <code>.pinpoint/settings.json</code> in your vault — travels with your notes.
          </p>
        </div>
      </div>
    </div>
  );
}
