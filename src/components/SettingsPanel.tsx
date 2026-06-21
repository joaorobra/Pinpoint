import type { Settings } from "../types";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}

const FONT_PRESETS = [
  "Inter, system-ui, sans-serif",
  "system-ui, sans-serif",
  "Georgia, serif",
  "'Segoe UI', sans-serif",
  "'Courier New', monospace",
  "'JetBrains Mono', monospace",
];

export default function SettingsPanel({ settings, onChange, onClose }: Props) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Appearance & Settings</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <p className="muted">Saved to <code>.pinpoint/settings.json</code> in your vault — travels with your notes.</p>

        <div className="setting">
          <label>Theme</label>
          <select value={settings.theme} onChange={(e) => set("theme", e.target.value as Settings["theme"])}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </div>

        <div className="setting">
          <label>UI font</label>
          <select value={settings.font_family} onChange={(e) => set("font_family", e.target.value)}>
            {FONT_PRESETS.map((f) => (
              <option key={f} value={f}>{f.split(",")[0].replace(/'/g, "")}</option>
            ))}
          </select>
        </div>

        <div className="setting">
          <label>Editor font</label>
          <select value={settings.editor_font_family} onChange={(e) => set("editor_font_family", e.target.value)}>
            {FONT_PRESETS.map((f) => (
              <option key={f} value={f}>{f.split(",")[0].replace(/'/g, "")}</option>
            ))}
          </select>
        </div>

        <div className="setting">
          <label>Font size: {settings.font_size}px</label>
          <input type="range" min={12} max={24} value={settings.font_size} onChange={(e) => set("font_size", +e.target.value)} />
        </div>

        <div className="setting">
          <label>Line height: {settings.line_height.toFixed(2)}</label>
          <input type="range" min={1.2} max={2.2} step={0.05} value={settings.line_height} onChange={(e) => set("line_height", +e.target.value)} />
        </div>

        <div className="setting">
          <label>Accent color</label>
          <input type="color" value={settings.accent_color} onChange={(e) => set("accent_color", e.target.value)} />
        </div>

        <div className="setting">
          <label>Background override</label>
          <div className="color-row">
            <input type="color" value={settings.background_color || "#1a1a1f"} onChange={(e) => set("background_color", e.target.value)} />
            <button className="link" onClick={() => set("background_color", "")}>reset to theme</button>
          </div>
        </div>

        <div className="setting">
          <label>Text color override</label>
          <div className="color-row">
            <input type="color" value={settings.text_color || "#e8e8ea"} onChange={(e) => set("text_color", e.target.value)} />
            <button className="link" onClick={() => set("text_color", "")}>reset to theme</button>
          </div>
        </div>

        <div className="setting">
          <label>Periodic notes folder</label>
          <input value={settings.periodic_folder} onChange={(e) => set("periodic_folder", e.target.value)} />
        </div>
      </div>
    </div>
  );
}
