// Icon picker modal: search every Phosphor icon, choose a weight and a color, preview live.
//
// Opened from the file tree (click a node's icon), the explorer context menu ("Set icon…"), and the
// editor header. Returns the chosen NodeIcon via onPick, or null via onRemove to clear an override.

import { useEffect, useMemo, useRef, useState } from "react";
import type { IconWeight, NodeIcon } from "../types";
import { ICON_WEIGHTS, PRESET_COLORS } from "../types";
import { iconComponent, searchIcons } from "./icon-registry";

interface Props {
  /** Human label for what we're decorating, e.g. a page or folder name. */
  targetLabel: string;
  /** The currently-set icon, if any — pre-selects it and enables "Remove". */
  current?: NodeIcon;
  onPick: (icon: NodeIcon) => void;
  onRemove: () => void;
  onClose: () => void;
}

const WEIGHT_LABELS: Record<IconWeight, string> = {
  thin: "Thin",
  light: "Light",
  regular: "Regular",
  bold: "Bold",
  fill: "Fill",
  duotone: "Duotone",
};

export default function IconPicker({ targetLabel, current, onPick, onRemove, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [name, setName] = useState<string>(current?.name ?? "");
  const [weight, setWeight] = useState<IconWeight>(current?.weight ?? "regular");
  const [color, setColor] = useState<string>(current?.color ?? "");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on Escape.
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

  const results = useMemo(() => searchIcons(query), [query]);
  const effectiveColor = color || "var(--text)";

  const apply = () => {
    if (!name) return;
    onPick({ name, weight, color });
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal icon-picker"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Set icon</h2>
          <span className="muted small ip-target" title={targetLabel}>{targetLabel}</span>
        </div>

        {/* Weight + color controls */}
        <div className="ip-controls">
          <div className="ip-weights" role="group" aria-label="Icon weight">
            {ICON_WEIGHTS.map((w) => (
              <button
                key={w}
                className={`ip-weight${weight === w ? " active" : ""}`}
                onClick={() => setWeight(w)}
                title={WEIGHT_LABELS[w]}
              >
                {WEIGHT_LABELS[w]}
              </button>
            ))}
          </div>

          <div className="ip-colors" role="group" aria-label="Icon color">
            <button
              className={`ip-color ip-color-default${color === "" ? " active" : ""}`}
              onClick={() => setColor("")}
              title="Default (theme text color)"
            >
              <span className="ip-color-x">A</span>
            </button>
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                className={`ip-color${color.toLowerCase() === c.toLowerCase() ? " active" : ""}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                title={c}
              />
            ))}
            <label className="ip-color ip-color-custom" title="Custom color">
              <input
                type="color"
                value={color && color.startsWith("#") ? color : "#7c5cff"}
                onChange={(e) => setColor(e.target.value)}
              />
            </label>
          </div>
        </div>

        <input
          ref={searchRef}
          className="ip-search"
          placeholder={`Search ${searchIcons("").length}+ icons…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {/* Icon grid */}
        <div className="ip-grid" role="listbox" aria-label="Icons">
          {results.map((n) => {
            const Cmp = iconComponent(n)!;
            const selected = n === name;
            return (
              <button
                key={n}
                className={`ip-cell${selected ? " active" : ""}`}
                title={n}
                aria-selected={selected}
                onClick={() => setName(n)}
                onDoubleClick={() => onPick({ name: n, weight, color })}
              >
                <Cmp size={24} weight={weight} color={selected ? effectiveColor : "currentColor"} />
              </button>
            );
          })}
          {results.length === 0 && <div className="ip-empty muted">No icons match “{query}”.</div>}
        </div>

        <div className="dialog-actions ip-actions">
          {current && (
            <button className="ip-remove" onClick={onRemove}>
              Remove icon
            </button>
          )}
          <span className="ip-spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={apply} disabled={!name}>
            Set icon
          </button>
        </div>
      </div>
    </div>
  );
}
