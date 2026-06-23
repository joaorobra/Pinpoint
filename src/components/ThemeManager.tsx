// Theme manager — the Appearance tab's centerpiece. Two modes:
//   • Gallery: a grid of theme cards (each a live mini-preview), with the active one checked. Pick a
//     card to apply it instantly; the built-in "Default" leads. Cards reveal edit / duplicate /
//     delete on hover. A trailing "New theme" card creates one.
//   • Editor: name + a Dark | Light segmented switch that flips which variant you're editing, six
//     core color pickers, optional font overrides, and a big live preview honoring the chosen mode.
//
// Themes live as `.themes/<name>.json` in the vault (see themes-store.ts). The built-in Default is
// virtual: selecting it clears `active_theme`; "duplicate" turns it into a real, editable file.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  PencilSimple,
  Copy,
  Trash,
  Check,
  ArrowLeft,
  Moon,
  Sun,
  FloppyDisk,
  Sparkle,
  MagnifyingGlass,
  CaretDown,
  X,
} from "@phosphor-icons/react";
import {
  BUILTIN_THEME,
  type Theme,
  type ThemeColors,
  type ThemeInfo,
} from "../types";
import {
  listThemeInfos,
  getTheme,
  saveTheme,
  deleteTheme,
  renameTheme,
  duplicateTheme,
} from "../themes-store";
import ColorPicker from "./ColorPicker";
import Select, { type SelectGroup } from "./Select";

type Mode = "dark" | "light";

/** The six core tokens, in editor display order, with labels + hints. */
const SWATCHES: { key: keyof ThemeColors; label: string; hint: string }[] = [
  { key: "accent", label: "Accent", hint: "Links, highlights, active states" },
  { key: "bg", label: "Background", hint: "The page behind everything" },
  { key: "surface", label: "Surface", hint: "Sidebar, cards, popovers" },
  { key: "text", label: "Text", hint: "Primary reading text" },
  { key: "dim", label: "Muted text", hint: "Secondary labels and hints" },
  { key: "border", label: "Border", hint: "Hairlines and dividers" },
];

interface Props {
  /** Name of the active theme ("" = built-in Default). */
  activeName: string;
  /** Select a theme by name ("" selects the built-in Default). */
  onSelect: (name: string) => void;
  /** Font groups reused from the Typography tab so a theme's font overrides match the app's set. */
  fontGroups: SelectGroup[];
}

/**
 * A miniature window preview used both on gallery cards and (larger) in the editor. Pure visual: it
 * paints a faux titlebar, sidebar, a heading line, body lines and an accent "button" from a palette.
 */
function ThemePreview({ c, size = "card" }: { c: ThemeColors; size?: "card" | "lg" }) {
  return (
    <div
      className={`theme-prev theme-prev-${size}`}
      style={{ background: c.bg, borderColor: c.border }}
      aria-hidden
    >
      <div className="theme-prev-side" style={{ background: c.surface, borderColor: c.border }}>
        <span style={{ background: c.accent }} className="theme-prev-dot" />
        <span style={{ background: c.dim }} />
        <span style={{ background: c.dim }} />
        <span style={{ background: c.dim }} />
      </div>
      <div className="theme-prev-main">
        <span className="theme-prev-h" style={{ background: c.text }} />
        <span style={{ background: c.dim }} />
        <span style={{ background: c.dim }} />
        <span className="theme-prev-btn" style={{ background: c.accent }} />
      </div>
    </div>
  );
}

/** One gallery card. `info` is null for the built-in Default (rendered from BUILTIN_THEME). */
function ThemeCard({
  name,
  colors,
  active,
  builtin,
  onPick,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  name: string;
  colors: ThemeColors;
  active: boolean;
  builtin: boolean;
  onPick: () => void;
  onEdit?: () => void;
  onDuplicate: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className={`theme-card${active ? " active" : ""}`}>
      <button
        type="button"
        className="theme-card-pick"
        onClick={onPick}
        aria-pressed={active}
        aria-label={`Use ${name} theme`}
      >
        <ThemePreview c={colors} />
        <span className="theme-card-foot">
          <span className="theme-card-name">{name}</span>
          {active && <Check size={14} weight="bold" className="theme-card-check" />}
        </span>
      </button>
      <div className="theme-card-actions">
        {onEdit && (
          <button type="button" title="Edit" aria-label={`Edit ${name}`} onClick={onEdit}>
            <PencilSimple size={14} />
          </button>
        )}
        <button
          type="button"
          title={builtin ? "Duplicate as a new theme" : "Duplicate"}
          aria-label={`Duplicate ${name}`}
          onClick={onDuplicate}
        >
          <Copy size={14} />
        </button>
        {onDelete && (
          <button
            type="button"
            className="theme-del"
            title="Delete"
            aria-label={`Delete ${name}`}
            onClick={onDelete}
          >
            <Trash size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export default function ThemeManager({ activeName, onSelect, fontGroups }: Props) {
  const [infos, setInfos] = useState<ThemeInfo[] | null>(null);
  // The theme currently open in the editor (a working draft), plus the name it was loaded under so
  // we can rename its file on save. null = gallery mode.
  const [draft, setDraft] = useState<Theme | null>(null);
  const [originalName, setOriginalName] = useState<string>("");
  const [editMode, setEditMode] = useState<Mode>("dark");
  const [nameError, setNameError] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // Gallery: name filter + whether the overflow rows past the fold are revealed.
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);

  // How many custom themes to show before the "Show more" fold (Default always shows on top of these).
  const COLLAPSED_COUNT = 5;

  const refresh = () => listThemeInfos().then(setInfos);
  useEffect(() => {
    refresh();
  }, []);

  // Names already taken (case-insensitive), for duplicate-name checks and auto-naming.
  const takenNames = useMemo(
    () => new Set((infos ?? []).map((i) => i.name.toLowerCase())),
    [infos]
  );

  const uniqueName = (base: string) => {
    let n = base;
    let i = 2;
    while (takenNames.has(n.toLowerCase()) || n.toLowerCase() === "default") {
      n = `${base} ${i++}`;
    }
    return n;
  };

  // ---- Gallery actions ----
  const startCreate = () => {
    const seed = duplicateTheme(BUILTIN_THEME, uniqueName("My theme"));
    setOriginalName(""); // brand-new, no file to rename from
    setDraft(seed);
    setEditMode("dark");
    setNameError("");
  };

  const startEdit = async (name: string) => {
    const t = await getTheme(name);
    if (!t) return;
    setOriginalName(name);
    setDraft(t);
    setEditMode("dark");
    setNameError("");
  };

  const startDuplicate = async (name: string, builtin: boolean) => {
    const src = builtin ? BUILTIN_THEME : await getTheme(name);
    if (!src) return;
    const copy = duplicateTheme(src, uniqueName(`${name} copy`));
    await saveTheme(copy);
    await refresh();
    onSelect(copy.name); // apply + open the new copy for editing
    setOriginalName(copy.name);
    setDraft(copy);
    setEditMode("dark");
  };

  const removeTheme = async (name: string) => {
    await deleteTheme(name);
    if (activeName === name) onSelect(""); // fall back to Default if the active one is gone
    await refresh();
  };

  // ---- Editor actions ----
  const setColor = (key: keyof ThemeColors, value: string) => {
    setDraft((d) =>
      d ? { ...d, [editMode]: { colors: { ...d[editMode].colors, [key]: value } } } : d
    );
  };

  const setFont = (which: "ui" | "editor", value: string) => {
    setDraft((d) => {
      if (!d) return d;
      const fonts = { ...(d.fonts ?? {}) };
      if (value) fonts[which] = value;
      else delete fonts[which];
      const hasAny = fonts.ui || fonts.editor;
      return { ...d, fonts: hasAny ? fonts : undefined };
    });
  };

  const validateName = (name: string): string => {
    const n = name.trim();
    if (!n) return "Name can't be empty.";
    if (/[\\/]|\.\./.test(n) || n.startsWith(".")) return "Avoid slashes, dots-leading or “..”.";
    if (n.toLowerCase() === "default") return "“Default” is reserved.";
    if (n.toLowerCase() !== originalName.toLowerCase() && takenNames.has(n.toLowerCase()))
      return "A theme with this name already exists.";
    return "";
  };

  const saveDraft = async () => {
    if (!draft) return;
    const err = validateName(draft.name);
    if (err) {
      setNameError(err);
      return;
    }
    setBusy(true);
    try {
      const name = draft.name.trim();
      const next = { ...draft, name };
      if (originalName && originalName !== name) {
        await renameTheme({ ...next, name: originalName }, name);
      } else {
        await saveTheme(next);
      }
      await refresh();
      onSelect(name); // make the saved theme active so edits are visible immediately
      setDraft(null);
      setOriginalName("");
    } finally {
      setBusy(false);
    }
  };

  const cancelEdit = () => {
    setDraft(null);
    setOriginalName("");
    setNameError("");
  };

  // Apply the draft's colors live to the preview only (not the whole app) by reading the editing
  // variant; the big preview reflects unsaved edits instantly.
  const previewColors = draft ? draft[editMode].colors : BUILTIN_THEME.dark.colors;

  // ---- Render: editor ----
  if (draft) {
    return (
      <div className="theme-editor">
        <div className="theme-editor-head">
          <button type="button" className="theme-back" onClick={cancelEdit} aria-label="Back to themes">
            <ArrowLeft size={15} /> Themes
          </button>
          <div className="theme-mode-toggle" role="group" aria-label="Edit variant">
            <button
              type="button"
              className={editMode === "dark" ? "active" : ""}
              onClick={() => setEditMode("dark")}
            >
              <Moon size={14} weight={editMode === "dark" ? "fill" : "regular"} /> Dark
            </button>
            <button
              type="button"
              className={editMode === "light" ? "active" : ""}
              onClick={() => setEditMode("light")}
            >
              <Sun size={14} weight={editMode === "light" ? "fill" : "regular"} /> Light
            </button>
          </div>
        </div>

        <div className="theme-editor-body">
          <div className="theme-editor-fields">
            <div className="theme-name-row">
              <label htmlFor="theme-name">Name</label>
              <input
                id="theme-name"
                className={`setting-input${nameError ? " invalid" : ""}`}
                value={draft.name}
                spellCheck={false}
                onChange={(e) => {
                  setDraft((d) => (d ? { ...d, name: e.target.value } : d));
                  setNameError("");
                }}
              />
              {nameError && <span className="theme-name-err">{nameError}</span>}
            </div>

            <div className="theme-swatches">
              {SWATCHES.map((s) => (
                <div className="theme-swatch-row" key={s.key}>
                  <div className="theme-swatch-text">
                    <label>{s.label}</label>
                    <span>{s.hint}</span>
                  </div>
                  <ColorPicker
                    value={previewColors[s.key]}
                    onChange={(v) => setColor(s.key, v)}
                    fallback={previewColors[s.key]}
                    ariaLabel={`${s.label} (${editMode})`}
                  />
                </div>
              ))}
            </div>

            <details className="theme-fonts">
              <summary>Fonts (optional)</summary>
              <p className="theme-fonts-hint">
                Override the UI / editor typeface while this theme is active. Leave unset to keep your
                Typography settings.
              </p>
              <div className="theme-swatch-row">
                <div className="theme-swatch-text">
                  <label>UI font</label>
                </div>
                <Select
                  value={draft.fonts?.ui ?? ""}
                  groups={[{ label: "Inherit", options: [{ value: "", label: "— Inherit —" }] }, ...fontGroups]}
                  onChange={(v) => setFont("ui", v)}
                  ariaLabel="Theme UI font"
                />
              </div>
              <div className="theme-swatch-row">
                <div className="theme-swatch-text">
                  <label>Editor font</label>
                </div>
                <Select
                  value={draft.fonts?.editor ?? ""}
                  groups={[{ label: "Inherit", options: [{ value: "", label: "— Inherit —" }] }, ...fontGroups]}
                  onChange={(v) => setFont("editor", v)}
                  ariaLabel="Theme editor font"
                />
              </div>
            </details>
          </div>

          <div className="theme-editor-preview">
            <span className="theme-preview-label">
              {editMode === "dark" ? "Dark" : "Light"} preview
            </span>
            <ThemePreview c={previewColors} size="lg" />
            <p className="theme-preview-note">
              The other tokens (hovers, rings, raised surfaces) are derived automatically from these.
            </p>
          </div>
        </div>

        <div className="theme-editor-foot">
          <button type="button" onClick={cancelEdit}>Cancel</button>
          <button type="button" className="primary" onClick={saveDraft} disabled={busy}>
            <FloppyDisk size={15} weight="bold" /> Save theme
          </button>
        </div>
      </div>
    );
  }

  // ---- Render: gallery ----
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const all = infos ?? [];
  // When searching, filter and show every match (so the fold never hides a result). Otherwise show
  // the first COLLAPSED_COUNT and tuck the rest behind "Show more".
  const matches = searching ? all.filter((i) => i.name.toLowerCase().includes(q)) : all;
  const overflow = !searching && matches.length > COLLAPSED_COUNT;
  const visible = overflow && !expanded ? matches.slice(0, COLLAPSED_COUNT) : matches;
  // "Default" matches the search too, so it can be found by name.
  const showDefault = !searching || "default".includes(q);

  return (
    <div className="theme-gallery">
      <div className="theme-search">
        <MagnifyingGlass size={15} className="theme-search-icon" />
        <input
          className="theme-search-input"
          type="text"
          value={query}
          placeholder="Search themes…"
          spellCheck={false}
          aria-label="Search themes"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="theme-search-clear"
            title="Clear search"
            aria-label="Clear search"
            onClick={() => setQuery("")}
          >
            <X size={13} weight="bold" />
          </button>
        )}
      </div>

      <div className="theme-grid">
        {/* Built-in default leads the gallery and is always available. */}
        {showDefault && (
          <ThemeCard
            name="Default"
            colors={BUILTIN_THEME.dark.colors}
            active={activeName === ""}
            builtin
            onPick={() => onSelect("")}
            onDuplicate={() => startDuplicate("Default", true)}
          />
        )}

        {visible.map((info) => (
          <ThemeCard
            key={info.name}
            name={info.name}
            colors={info.dark}
            active={activeName === info.name}
            builtin={false}
            onPick={() => onSelect(info.name)}
            onEdit={() => startEdit(info.name)}
            onDuplicate={() => startDuplicate(info.name, false)}
            onDelete={() => removeTheme(info.name)}
          />
        ))}

        {/* Create-new card always sits at the end of the visible set. */}
        <button type="button" className="theme-card theme-card-new" onClick={startCreate}>
          <span className="theme-card-new-icon">
            <Plus size={20} weight="bold" />
          </span>
          <span className="theme-card-name">New theme</span>
        </button>
      </div>

      {overflow && (
        <button
          type="button"
          className="theme-showmore"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <CaretDown
            size={14}
            weight="bold"
            style={{ transform: expanded ? "rotate(180deg)" : "none" }}
          />
          {expanded ? "Show less" : `Show ${matches.length - COLLAPSED_COUNT} more`}
        </button>
      )}

      {infos === null && <p className="theme-empty">Loading themes…</p>}
      {infos?.length === 0 && (
        <p className="theme-empty">
          <Sparkle size={15} weight="fill" /> Make a theme to give this vault its own look — colors
          and fonts, with paired dark &amp; light modes.
        </p>
      )}
      {searching && matches.length === 0 && !showDefault && (
        <p className="theme-empty">No themes match “{query}”.</p>
      )}
    </div>
  );
}
