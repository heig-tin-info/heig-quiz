/**
 * `@quiz/ui/testing` — TEST-ONLY. The probe that holds a canvas editor's
 * shortcut lines (`CanvasShortcutLine`, issue #549) against its keyboard,
 * both ways. Nothing in `apps/*` imports it.
 *
 * The keys are found by PRESSING them, never by reading the handler tables,
 * so a binding added anywhere is caught.
 */
const NAMED = ["Delete", "Backspace", "Escape", "Enter", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Insert", "F1", "F2"];
const PRINTABLE = [..."abcdefghijklmnopqrstuvwxyz0123456789 -=+[]/.,;"];

/** A key as a line spells it: `R`, `Del`, `Esc`, `Space`. */
const shown = (key: string): string =>
  ({ " ": "Space", Delete: "Del", Escape: "Esc" })[key] ?? (key.length === 1 ? key.toUpperCase() : key);

/**
 * What one press did, as the editor under test can observe it: any string
 * that tells two different effects apart, `""` when the press did nothing.
 */
export type KeyPress = (key: string, mod: boolean, shift: boolean) => string;

/**
 * Every key the editor answers to, spelled as the lines spell them. Shift on
 * a chord counts where it changes what the chord does (Ctrl+Shift+Z redoes
 * where Ctrl+Z undoes), never merely because the chord ignores it.
 */
export function boundKeys(press: KeyPress): string[] {
  const out = new Set<string>();
  for (const key of [...PRINTABLE, ...NAMED]) {
    if (press(key, false, false)) out.add(shown(key));
    const chord = press(key, true, false);
    if (chord) out.add(`Mod+${shown(key)}`);
    const shifted = press(key, true, true);
    if (shifted && shifted !== chord) out.add(`Mod+Shift+${shown(key)}`);
  }
  return [...out].sort();
}

/** What the lines and the unlisted keys claim, `1–9` expanded to the first `digits` digits. */
export function claimedKeys(
  lines: readonly { readonly keys: readonly string[] }[],
  unlisted: readonly string[],
  digits = 9,
): string[] {
  const expand = (key: string): string[] =>
    key === "1–9" ? Array.from({ length: digits }, (_, i) => String(i + 1)) : [key];
  return [...lines.flatMap((line) => line.keys.flatMap(expand)), ...unlisted].sort();
}
