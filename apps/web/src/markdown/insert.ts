/*
 * What the toolbar and the keyboard shortcuts of `MarkdownField` do to the
 * text, with no textarea in sight. Pure on purpose: the interesting part of a
 * markdown toolbar is where the caret lands afterwards, and that is worth
 * testing without a DOM.
 *
 * Every function takes the current value and selection and returns the next
 * value and selection. The field applies them and restores the caret.
 */

export interface Selection {
  value: string;
  /** Caret, or start of the selection. */
  start: number;
  /** End of the selection; equal to `start` when nothing is selected. */
  end: number;
}

/** A selection is "collapsed" when there is nothing to wrap. */
const collapsed = (s: Selection) => s.start === s.end;

/**
 * Wraps the selection in `before`/`after`, or inserts the pair around
 * `placeholder` and selects it when there is no selection — so the next
 * keystroke replaces the word "text" rather than landing between two stars.
 *
 * Wrapping twice unwraps: a second Ctrl+B on a bold word takes the stars off,
 * which is what every editor does and what a teacher will try.
 */
export function wrap(
  sel: Selection,
  before: string,
  after: string = before,
  placeholder = "",
): Selection {
  const { value, start, end } = sel;
  const selected = value.slice(start, end);
  const outerStart = start - before.length;
  // A run of delimiters longer than the one asked for is a DIFFERENT mark:
  // `*` inside `**abc**` is italic over bold, not "the bold is already
  // there". Without this guard, Ctrl+I on the word of a bold phrase quietly
  // removed the bold.
  const partOfLongerRun =
    value.slice(outerStart - before.length, outerStart) === before ||
    value.slice(end + after.length, end + 2 * after.length) === after;
  const alreadyWrapped =
    !collapsed(sel) &&
    outerStart >= 0 &&
    !partOfLongerRun &&
    value.slice(outerStart, start) === before &&
    value.slice(end, end + after.length) === after;
  if (alreadyWrapped) {
    return {
      value: value.slice(0, outerStart) + selected + value.slice(end + after.length),
      start: outerStart,
      end: outerStart + selected.length,
    };
  }
  const inner = selected.slice(before.length, selected.length - after.length);
  if (
    selected.startsWith(before) &&
    selected.endsWith(after) &&
    selected.length > before.length + after.length &&
    // Same guard from the other side: selecting `**abc**` and pressing italic
    // means "italic around the bold", not "take one star off each end".
    !inner.startsWith(before) &&
    !inner.endsWith(after)
  ) {
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
  }
  const body = selected || placeholder;
  return {
    value: value.slice(0, start) + before + body + after + value.slice(end),
    start: start + before.length,
    end: start + before.length + body.length,
  };
}

/** Replaces the selection with `text`; the caret lands after it. */
export function replace(sel: Selection, text: string): Selection {
  const at = sel.start + text.length;
  return { value: sel.value.slice(0, sel.start) + text + sel.value.slice(sel.end), start: at, end: at };
}

/**
 * Inserts a block (a fenced code block, a display formula) on its own lines,
 * adding the blank lines the markdown needs only where they are missing.
 * `select` is the substring of `block` to leave selected, if any.
 */
export function insertBlock(sel: Selection, block: string, select?: string): Selection {
  const { value, start, end } = sel;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const tail = after === "" || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const text = lead + block + tail;
  const nextValue = before + text + after;
  const rel = select ? block.indexOf(select) : -1;
  if (rel >= 0) {
    const at = before.length + lead.length + rel;
    return { value: nextValue, start: at, end: at + select!.length };
  }
  const at = before.length + lead.length + block.length;
  return { value: nextValue, start: at, end: at };
}

/** Two spaces at the caret — the Tab of a markdown field (never a tab stop). */
export const INDENT = "  ";

/**
 * Tab and Shift+Tab over a selection spanning whole lines indent and outdent
 * every line of it; over a caret, Tab is just two spaces. Nesting a list item
 * is the only thing a teacher uses Tab for here, and it always covers lines.
 */
export function indent(sel: Selection, outdent = false): Selection {
  const { value, start, end } = sel;
  if (collapsed(sel) && !outdent) return replace(sel, INDENT);
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEndIndex = value.indexOf("\n", end);
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  let firstDelta = 0;
  let total = 0;
  const next = lines.map((line, i) => {
    if (outdent) {
      const removed = /^ {1,2}/.exec(line)?.[0].length ?? 0;
      if (i === 0) firstDelta = -removed;
      total -= removed;
      return line.slice(removed);
    }
    if (i === 0) firstDelta = INDENT.length;
    total += INDENT.length;
    return INDENT + line;
  });
  return {
    value: value.slice(0, lineStart) + next.join("\n") + value.slice(lineEnd),
    start: Math.max(lineStart, start + firstDelta),
    end: Math.max(lineStart, end + total),
  };
}
