// Circular color picker used across Settings. A round swatch shows the current color; clicking opens
// a popover with the curated preset circles, an optional "theme default" circle, and a custom color
// well (native <input type=color> hidden behind a rainbow circle). All swatches are circular.
//
// `value` is a CSS hex color, or "" to mean "inherit theme" when `allowReset` is set.

import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { PRESET_COLORS } from "../types";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** When true, offers a "theme default" circle that sets the value to "". */
  allowReset?: boolean;
  /** Color shown on the default circle / used by the custom well when value is empty. */
  fallback?: string;
  ariaLabel?: string;
}

export default function ColorPicker({
  value,
  onChange,
  allowReset = false,
  fallback = "#7c5cff",
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isDefault = value === "";
  const swatchColor = isDefault ? fallback : value;
  const customValue = value && value.startsWith("#") ? value : fallback;
  const matchesPreset = PRESET_COLORS.some((c) => c.toLowerCase() === value.toLowerCase());

  return (
    <div className="cp" ref={rootRef}>
      <button
        type="button"
        className={`cp-swatch${isDefault ? " is-default" : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cp-swatch-fill" style={{ background: swatchColor }} />
      </button>

      {open && (
        <div className="cp-popover" role="dialog" aria-label={ariaLabel}>
          <div className="cp-grid">
            {allowReset && (
              <button
                type="button"
                className={`cp-dot cp-dot-default${isDefault ? " active" : ""}`}
                title="Theme default"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                <ArrowCounterClockwise size={12} weight="bold" />
              </button>
            )}
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`cp-dot${value.toLowerCase() === c.toLowerCase() ? " active" : ""}`}
                style={{ background: c }}
                title={c}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
              />
            ))}
            <label
              className={`cp-dot cp-dot-custom${!isDefault && !matchesPreset ? " active" : ""}`}
              title="Custom color"
            >
              <input
                type="color"
                value={customValue}
                onChange={(e) => onChange(e.target.value)}
              />
            </label>
          </div>
          <div className="cp-hex">
            <span className="cp-hex-dot" style={{ background: swatchColor }} />
            <span className="cp-hex-value">{isDefault ? "Theme default" : value.toUpperCase()}</span>
          </div>
        </div>
      )}
    </div>
  );
}
