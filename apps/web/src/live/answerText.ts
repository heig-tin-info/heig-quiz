/*
 * One student's answer to one item, as readable text: what the tooltip of a
 * dashboard cell shows (#94).
 *
 * The cell itself carries the server's `summarizeAnswer`, which is held to
 * the width of a 64 px column ("A, C", "3 L", "int · mal…"). The tooltip is
 * the quick look BETWEEN that glyph and opening the student's whole paper:
 * the choices by their labels, the blanks in order, a short answer in full,
 * the first lines of a program. It is read from the same payload the
 * inspection modal renders (`AttemptInspect`), so the two can never disagree.
 *
 * No type exposes a full textual rendering through the registry — the
 * client's `summarize` is a count or a letter, like the server's — so the
 * shapes are read here, DEFENSIVELY: the payload is `unknown` on the wire,
 * and a shape this function does not recognise gives `null`, which the caller
 * turns into the type's own `summarize` or the cell's summary. A tooltip is
 * never worth an exception.
 *
 * Nothing here decides whether an answer is right: no solution is read.
 */

/** How many lines of a program the tooltip shows before its ellipsis. */
export const CODE_LINES = 20;
/** How many characters of free text, so a pasted essay cannot fill the screen. */
export const TEXT_CHARS = 600;

export type AnswerText =
  /** Multiple choice: the ticked choices, by canonical letter and label. */
  | { kind: "choices"; items: { letter: string; text: string }[] }
  /** Fill in the blanks, in order; `null` is a blank left empty. */
  | { kind: "blanks"; items: (string | null)[] }
  /** Free text, whitespace kept. */
  | { kind: "text"; text: string; truncated: boolean }
  /** What the student wrote in the editable regions of a program. */
  | { kind: "code"; lines: string[]; truncated: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const letter = (index: number) => String.fromCharCode(65 + (index % 26));

function clip(text: string): { text: string; truncated: boolean } {
  return text.length > TEXT_CHARS
    ? { text: `${text.slice(0, TEXT_CHARS).trimEnd()}…`, truncated: true }
    : { text, truncated: false };
}

function mcq(student: unknown, answer: unknown): AnswerText | null {
  if (!isRecord(answer) || !Array.isArray(answer.selected)) return null;
  const choices = isRecord(student) && Array.isArray(student.choices) ? student.choices : [];
  const label = new Map<number, string>();
  for (const c of choices) {
    if (isRecord(c) && typeof c.id === "number" && typeof c.text === "string") {
      label.set(c.id, c.text);
    }
  }
  // Canonical order and canonical letters, exactly as the cell reads "A, C":
  // two students who saw the choices shuffled still read the same way.
  const selected = [
    ...new Set(answer.selected.filter((i): i is number => Number.isInteger(i) && i >= 0)),
  ].sort((a, b) => a - b);
  return {
    kind: "choices",
    items: selected.map((id) => ({ letter: letter(id), text: clip(label.get(id) ?? "").text })),
  };
}

function cloze(student: unknown, answer: unknown): AnswerText | null {
  if (!isRecord(answer) || !Array.isArray(answer.blanks)) return null;
  const blanks = isRecord(student) && Array.isArray(student.blanks) ? student.blanks : [];
  return {
    kind: "blanks",
    items: answer.blanks.map((value, index) => {
      if (typeof value !== "string" || value.trim() === "") return null;
      // A dropdown stores the canonical option index as a string (D4); the
      // teacher reads the option, not "2".
      const blank = blanks.find((b) => isRecord(b) && b.index === index);
      if (isRecord(blank) && blank.kind === "select" && Array.isArray(blank.options)) {
        const option = blank.options.find((o) => isRecord(o) && o.id === Number(value));
        if (isRecord(option) && typeof option.label === "string") return clip(option.label).text;
      }
      return clip(value.trim()).text;
    }),
  };
}

function short(answer: unknown): AnswerText | null {
  if (!isRecord(answer) || typeof answer.text !== "string") return null;
  return { kind: "text", ...clip(answer.text.trim()) };
}

function code(answer: unknown): AnswerText | null {
  if (!isRecord(answer) || !Array.isArray(answer.regions)) return null;
  const regions = answer.regions.filter(
    (r): r is string => typeof r === "string" && r.trim() !== "",
  );
  // Region after region, as the student reads them down the editor; a blank
  // line between two regions stands for the locked code in between.
  const lines = dedent(
    regions
      .map((r) => r.replace(/\s+$/, ""))
      .join("\n\n")
      .split("\n"),
  );
  return lines.length > CODE_LINES
    ? { kind: "code", lines: lines.slice(0, CODE_LINES), truncated: true }
    : { kind: "code", lines: regions.length === 0 ? [] : lines, truncated: false };
}

/**
 * The common indentation removed: a region sits inside a function body, and
 * four columns of nothing are four columns of a small tooltip lost.
 */
function dedent(lines: string[]): string[] {
  const indents = lines
    .filter((l) => l.trim() !== "")
    .map((l) => /^[ \t]*/.exec(l)![0].length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return common === 0 ? lines : lines.map((l) => l.slice(Math.min(common, l.length)));
}

/**
 * The answer as text, or `null` when there is none or when its shape is not
 * one this function reads (a type it does not know, a payload of an older
 * schema): the caller then falls back to a shorter rendering.
 */
export function answerText(type: string, student: unknown, answer: unknown): AnswerText | null {
  if (answer === null || answer === undefined) return null;
  switch (type) {
    case "mcq":
      return mcq(student, answer);
    case "cloze":
      return cloze(student, answer);
    case "short":
      return short(answer);
    case "code":
    case "codeimage":
      return code(answer);
    default:
      return null;
  }
}

/** Whether there is anything to show: an empty rendering reads as "no answer". */
export function isEmptyAnswerText(text: AnswerText): boolean {
  switch (text.kind) {
    case "choices":
      return text.items.length === 0;
    case "blanks":
      return text.items.every((b) => b === null);
    case "text":
      return text.text === "";
    case "code":
      return text.lines.length === 0;
  }
}
