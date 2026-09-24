/**
 * The teacher's "lock these lines" button, as pure text transformations of
 * a template (docs/spec/04 §4.7).
 *
 * The author never has to type a marker: they select lines and press the
 * button, and the template gains (or loses) `@@lock` / `@@endlock` comment
 * lines around them. What is locked is still decided by the domain's split
 * (`@quiz/domain/lockedTemplate`) — this file only EDITS the text, reading
 * each line with the same matcher, so what it writes is exactly what the
 * server will read back.
 *
 * The model: a template is a sequence of CONTENT lines, each locked or not,
 * separated by GAPS holding the marker lines. Locking or unlocking sets the
 * flag of the content lines of the selection, then rewrites only the gaps
 * next to or inside the selection so that each carries exactly the
 * transition it needs (`@@lock` from editable to locked, `@@endlock` back).
 * Every other line — and every marker away from the selection, with its own
 * spelling (`/* @@lock *\/`, `@@unlock`) — is left byte for byte.
 *
 * A marker that does nothing (a close with no open lock, a lock inside an
 * open one) is read as a content line, as the split reads it; inside the
 * selection it is dropped, so a stray marker never starts meaning something
 * because the lines around it moved. Line numbers are 1-based and inclusive,
 * as an editor numbers them.
 */
import { markerLine, markerOf, type TemplateLanguage } from "@quiz/domain/lockedTemplate";

interface Line {
  text: string;
  /** An EFFECTIVE marker: one that opens or closes a lock where it stands. */
  marker: "lock" | "endlock" | null;
  /** For a content line: whether the split puts it in a locked segment. */
  locked: boolean;
}

interface Parsed {
  lines: Line[];
  /** Whether the template ended with a line break (restored on output). */
  trailingBreak: boolean;
}

function parse(template: string, language: TemplateLanguage): Parsed {
  const raw = template.split("\n");
  const trailingBreak = raw.length > 1 && raw[raw.length - 1] === "";
  if (trailingBreak) raw.pop();
  let open = false;
  const lines = raw.map((text): Line => {
    const marker = markerOf(text, language);
    if (marker === "lock" && !open) {
      open = true;
      return { text, marker: "lock", locked: true };
    }
    if (marker === "endlock" && open) {
      open = false;
      return { text, marker: "endlock", locked: true };
    }
    // Code, an unknown word, `@@next`, or a marker that changes nothing.
    return { text, marker: null, locked: open };
  });
  return { lines, trailingBreak };
}

/**
 * The 1-based numbers of the lines the student cannot edit — the marker
 * lines of a region included, since they belong to its locked text. What the
 * author's editor greys out.
 */
export function lockedLineNumbers(template: string, language: TemplateLanguage): number[] {
  return parse(template, language)
    .lines.flatMap((line, i) => (line.locked ? [i + 1] : []));
}

/** The content lines of `[from, to]`, clamped to the template. */
function contentIn(lines: readonly Line[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i++) {
    if (lines[i - 1]!.marker === null) out.push(i - 1);
  }
  return out;
}

/**
 * Whether every content line of `[from, to]` is locked — the button then
 * offers "unlock". A range with no content line (only markers, or past the
 * end) is not a locked range.
 */
export function isLockedLineRange(
  template: string,
  language: TemplateLanguage,
  from: number,
  to: number,
): boolean {
  const { lines } = parse(template, language);
  const content = contentIn(lines, from, to);
  return content.length > 0 && content.every((i) => lines[i]!.locked);
}

function setLocked(
  template: string,
  language: TemplateLanguage,
  from: number,
  to: number,
  locked: boolean,
): string {
  const { lines, trailingBreak } = parse(template, language);
  const inRange = (i: number) => i >= from - 1 && i <= to - 1;
  const content = contentIn(lines, from, to);
  if (content.length === 0) return template;

  // The new flag of every content line; a stray marker inside the selection
  // is dropped (see the header), everything else keeps its line.
  const isStray = (line: Line) => line.marker === null && markerOf(line.text, language) !== null
    && markerOf(line.text, language) !== "next";
  const items = lines
    .map((line, index) => ({ ...line, index }))
    .filter((line) => !(inRange(line.index) && isStray(line)))
    .map((line) => (line.marker === null && inRange(line.index) ? { ...line, locked } : line));

  // Walk gap by gap. A gap is the run of marker lines before a content line
  // (or after the last one); it is rewritten only when it touches the range:
  // one of its markers is selected, or a content line on either side is.
  const out: string[] = [];
  let prev = false; // the flag of the previous content line; a file starts editable
  let prevSelected = false;
  let gap: typeof items = [];
  // A marker a rewritten gap no longer needs lends its spelling to the next
  // one of its kind that must be written: moving `// @@unlock` below the
  // newly locked line keeps it `// @@unlock`.
  const spare: Record<"lock" | "endlock", string[]> = { lock: [], endlock: [] };
  const flush = (next: boolean | null, nextSelected: boolean) => {
    if (!(prevSelected || nextSelected || gap.some((line) => inRange(line.index)))) {
      for (const line of gap) out.push(line.text);
    } else {
      // At the end of the file a locked tail is closed explicitly, the way
      // every template is written, rather than left open.
      const target = next ?? false;
      const needed = prev === target ? null : target ? "lock" : "endlock";
      const kept = needed === null ? undefined : gap.find((line) => line.marker === needed);
      for (const line of gap) if (line !== kept) spare[line.marker!].push(line.text);
      if (needed !== null) out.push(kept?.text ?? spare[needed].shift() ?? markerLine(needed, language));
    }
    gap = [];
  };
  for (const line of items) {
    if (line.marker !== null) {
      gap.push(line);
      continue;
    }
    flush(line.locked, inRange(line.index));
    out.push(line.text);
    prev = line.locked;
    prevSelected = inRange(line.index);
  }
  flush(null, false);

  return out.join("\n") + (trailingBreak ? "\n" : "");
}

/**
 * Locks the lines `[from, to]`: wraps them in `@@lock` / `@@endlock` marker
 * lines in the language's comment syntax, merging with a locked region they
 * touch or overlap instead of nesting in it.
 */
export function lockLines(template: string, language: TemplateLanguage, from: number, to: number): string {
  return setLocked(template, language, from, to, true);
}

/**
 * Unlocks the lines `[from, to]`: removes the lock around them, splitting a
 * region when they sit in its middle (it closes before them and reopens
 * after).
 */
export function unlockLines(template: string, language: TemplateLanguage, from: number, to: number): string {
  return setLocked(template, language, from, to, false);
}

/**
 * The 1-based lines a text selection covers, as offsets into `text` (a
 * textarea's `selectionStart` / `selectionEnd`). A selection that ends at the
 * very start of a line — the usual result of dragging over whole lines —
 * does not take that line. `null` for an empty selection.
 */
export function selectedLines(
  text: string,
  start: number,
  end: number,
): { from: number; to: number } | null {
  if (end <= start) return null;
  const lineAt = (offset: number) => text.slice(0, offset).split("\n").length;
  const from = lineAt(start);
  const endsAtLineStart = text[end - 1] === "\n";
  const to = Math.max(from, lineAt(end) - (endsAtLineStart ? 1 : 0));
  return { from, to };
}
