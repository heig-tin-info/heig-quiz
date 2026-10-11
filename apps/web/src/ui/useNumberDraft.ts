import { useState, type ChangeEvent, type KeyboardEvent } from "react";

/**
 * The props of a number input that writes when the teacher leaves it — Enter
 * leaves it —, not at every keystroke (a count typed digit by digit is a run
 * of wrong values). `onCommit` gets the number, or null when the field is
 * empty or not a number; it is not called when nothing changed. Keyed on the
 * stored value by its caller, so a write from elsewhere replaces the text.
 */
export function useNumberDraft(value: number | null, onCommit: (n: number | null) => void) {
  const [text, setText] = useState(value === null ? "" : String(value));
  return {
    value: text,
    onChange: (e: ChangeEvent<HTMLInputElement>) => setText(e.target.value),
    onBlur: () => {
      const trimmed = text.trim();
      const n = trimmed === "" ? null : Number(trimmed);
      const parsed = n !== null && Number.isFinite(n) ? n : null;
      if (parsed !== value) onCommit(parsed);
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") e.currentTarget.blur();
    },
  };
}
