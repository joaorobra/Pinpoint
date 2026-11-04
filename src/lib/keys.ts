// Platform-aware keyboard shortcut labels, shared by tooltips, menus and the shortcuts sheet.
//
// `shortcutLabel("mod+Shift+S")` → "⌘⇧S" on macOS, "Ctrl+Shift+S" elsewhere. `mod` is Cmd on macOS
// and Ctrl on Windows/Linux; `Alt` renders as ⌥ on macOS.

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);

/** Display label for one key token. */
export function keyLabel(key: string): string {
  if (key === "mod") return IS_MAC ? "⌘" : "Ctrl";
  if (key === "Alt") return IS_MAC ? "⌥" : "Alt";
  if (key === "Shift") return IS_MAC ? "⇧" : "Shift";
  return key;
}

/** Display label for a "+"-joined combo such as "mod+W" or "Alt+←". */
export function shortcutLabel(combo: string): string {
  const parts = combo.split("+").map(keyLabel);
  return IS_MAC ? parts.join("") : parts.join("+");
}
