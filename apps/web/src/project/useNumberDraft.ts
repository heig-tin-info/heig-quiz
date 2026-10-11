import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

/**
 * The props of a number input that writes when the teacher leaves it or
 * presses Enter, not at every keystroke (a count typed digit by digit is a
 * run of wrong values). `onCommit` gets the number, or null when the field is
 * empty or not a number; it is not called when nothing changed. Keyed on the
 * stored value by its caller, so a write from elsewhere replaces the text.
 */
export function useNumberDraft(value: number | null, onCommit: (n: number | null) => void) {
  const [text, setText] = useState(value === null ? "" : String(value));
  // Enter commits and the blur that follows must not write it again.
  const sent = useRef<string | null>(null);
  const commit = () => {
    if (sent.current === text) return;
    sent.current = text;
    const trimmed = text.trim();
    const n = trimmed === "" ? null : Number(trimmed);
    const parsed = n !== null && Number.isFinite(n) ? n : null;
    if (parsed !== value) onCommit(parsed);
  };
  return {
    value: text,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      sent.current = null;
      setText(e.target.value);
    },
    onBlur: commit,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      commit();
    },
  };
}
