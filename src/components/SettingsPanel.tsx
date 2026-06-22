import { useEffect, useState, type ReactNode } from "react";
import {
  X,
  Palette,
  TextAa,
  FolderSimple,
  PencilSimple,
  CalendarBlank,
} from "@phosphor-icons/react";
import type { Settings } from "../types";
import Select, { type SelectGroup, type SelectOption } from "./Select";
import ColorPicker from "./ColorPicker";
import { formatDate, DATE_PRESETS, TIME_PRESETS } from "../dateformat";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}

const FONT_GROUPS: SelectGroup[] = [
  {
    label: "Sans-serif",
    options: [
      "Inter, system-ui, sans-serif",
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

type TabId = "appearance" | "typography" | "editor" | "dates" | "vault";

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette size={17} /> },
  { id: "typography", label: "Typography", icon: <TextAa size={17} /> },
  { id: "editor", label: "Editor", icon: <PencilSimple size={17} /> },
  { id: "dates", label: "Dates & Times", icon: <CalendarBlank size={17} /> },
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

/** A labelled group of related settings within a tab — the "section" in Notion/Obsidian. */
function Group({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
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

export default function SettingsPanel({ settings, onChange, onClose }: Props) {
  const [tab, setTab] = useState<TabId>("appearance");
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    onChange({ ...settings, [k]: v });
  // A fixed sample so previews don't tick/jitter as the panel re-renders. Mid-afternoon shows
  // both 24h and 12h time clearly. Date.now() is fine in the webview runtime.
  const [sample] = useState(() => {
    const d = new Date();
    d.setHours(14, 30, 5, 0);
    return d;
  });

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
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-title">Settings</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
            >
              <span className="settings-tab-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>

        <div className="settings-pane">
          <div className="settings-pane-head">
            <h2>{TABS.find((t) => t.id === tab)?.label}</h2>
            <button onClick={onClose} title="Close" aria-label="Close settings">
              <X size={16} weight="bold" />
            </button>
          </div>

          <div className="settings-pane-body">
            {tab === "appearance" && (
              <Group title="Theme" desc="Colors applied across the whole app.">
                <Row label="Appearance">
                  <Select
                    value={settings.theme}
                    options={THEME_OPTIONS}
                    onChange={(v) => set("theme", v as Settings["theme"])}
                    ariaLabel="Theme"
                    className="select-narrow"
                  />
                </Row>
                <Row label="Accent color" hint="Used for highlights, links and active states.">
                  <ColorPicker
                    value={settings.accent_color}
                    onChange={(v) => set("accent_color", v)}
                    fallback="#7c5cff"
                    ariaLabel="Accent color"
                  />
                </Row>
                <Row label="Background override" hint="Leave unset to follow the theme.">
                  <ColorPicker
                    value={settings.background_color}
                    onChange={(v) => set("background_color", v)}
                    allowReset
                    fallback="#1a1a1f"
                    ariaLabel="Background color override"
                  />
                </Row>
                <Row label="Text color override" hint="Leave unset to follow the theme.">
                  <ColorPicker
                    value={settings.text_color}
                    onChange={(v) => set("text_color", v)}
                    allowReset
                    fallback="#e8e8ea"
                    ariaLabel="Text color override"
                  />
                </Row>
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
            )}

            {tab === "typography" && (
              <>
                <Group title="Fonts" desc="Typefaces for the interface and the editor.">
                  <Row label="UI font">
                    <Select
                      value={settings.font_family}
                      groups={FONT_GROUPS}
                      onChange={(v) => set("font_family", v)}
                      ariaLabel="UI font"
                    />
                  </Row>
                  <Row label="Editor font">
                    <Select
                      value={settings.editor_font_family}
                      groups={FONT_GROUPS}
                      onChange={(v) => set("editor_font_family", v)}
                      ariaLabel="Editor font"
                    />
                  </Row>
                </Group>
                <Group title="Text" desc="Reading comfort in the editor.">
                  <div className="setting">
                    <label>Font size: {settings.font_size}px</label>
                    <input
                      type="range"
                      min={12}
                      max={24}
                      value={settings.font_size}
                      onChange={(e) => set("font_size", +e.target.value)}
                    />
                  </div>
                  <div className="setting">
                    <label>Line height: {settings.line_height.toFixed(2)}</label>
                    <input
                      type="range"
                      min={1.2}
                      max={2.2}
                      step={0.05}
                      value={settings.line_height}
                      onChange={(e) => set("line_height", +e.target.value)}
                    />
                  </div>
                </Group>
                <Group title="Interface" desc="Scale the whole app — sidebar, toolbars and text together. Also Ctrl +/- and Ctrl 0 to reset.">
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
              </>
            )}

            {tab === "editor" && (
              <Group title="Editing" desc="Behavior of the markdown editor.">
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
            )}

            {tab === "dates" && (
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
                <Group title="Tasks" desc="How due dates appear in the Tasks view.">
                  <Row label="Due-date format">
                    <FormatPicker
                      value={settings.task_date_format}
                      presets={DATE_PRESETS}
                      sample={sample}
                      onChange={(v) => set("task_date_format", v)}
                      ariaLabel="Task due-date format"
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
                <p className="settings-hint-block">
                  Patterns use tokens like <code>YYYY</code> <code>MM</code> <code>DD</code>{" "}
                  <code>ddd</code> <code>HH</code> <code>mm</code> <code>A</code>. Wrap literal text
                  in <code>[brackets]</code>, e.g. <code>[Logged] YYYY-MM-DD</code>.
                </p>
              </>
            )}

            {tab === "vault" && (
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
            )}
          </div>

          <p className="settings-footnote">
            Saved to <code>.pinpoint/settings.json</code> in your vault — travels with your notes.
          </p>
        </div>
      </div>
    </div>
  );
}
