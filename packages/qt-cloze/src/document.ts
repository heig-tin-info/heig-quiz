/**
 * The `cloze` question as blocks of an exported document (ADR-121 §2, ADR-125).
 *
 * The statement and the paper zones read the student view only: its
 * template, whose sentinels become numbered blanks, and its dropdowns'
 * options in the order the student was served. The staff's reading of an
 * answer resolves a dropdown's canonical index (D4) through the stored
 * text, in English (ADR-121 §4).
 */
import { answerZone, markdown, table, type Block, type Labels } from "@quiz/docexport";
import { CLOZE_SENTINEL_PATTERN, parseCloze } from "@quiz/domain/cloze";

import type { ClozeAnswer, ClozeConfig, ClozeDetails, ClozeSolution, ClozeStudent } from "./schema.js";

/** A blank as the document numbers it: `(1)` for index 0. */
const numbered = (index: number): string => `(${index + 1})`;

/** The template with each sentinel `⸢n⸣` a numbered blank to fill, `____(n)`. */
function blanked(template: string): string {
  return template.replace(new RegExp(CLOZE_SENTINEL_PATTERN, "g"), (_, index: string) => `____${numbered(Number(index))}`);
}

/** The text with numbered blanks, then each dropdown's options. */
export function clozeStatementDoc(student: ClozeStudent): Block[] {
  return [
    markdown(blanked(student.template)),
    ...student.blanks.flatMap((blank) =>
      blank.kind === "select"
        ? [markdown(`${numbered(blank.index)} ${blank.options.map((o) => o.label).join(" / ")}`)]
        : [],
    ),
  ];
}

/** Blank by blank, what is accepted. */
export function clozeSolutionDoc(solution: ClozeSolution, _student: ClozeStudent, labels: Labels): Block[] {
  return [table([labels.blank, labels.expected], solution.blanks.map((b) => [numbered(b.index), b.expected]))];
}

/** One zone per blank, numbered: a line to write on, or a dropdown's options to tick. */
export function clozeAnswerZone(student: ClozeStudent): Block[] {
  return student.blanks.flatMap((blank) => [
    markdown(numbered(blank.index)),
    blank.kind === "select"
      ? answerZone("bubbles", { part: `b${blank.index}`, labels: blank.options.map((o) => o.label) })
      : answerZone("lines", { part: `b${blank.index}`, lines: 1 }),
  ]);
}

/** What a blank holds as text: a dropdown's value resolved by `option`, a typed one as typed. */
const shown = (value: string | null | undefined, option: ((value: number) => string | undefined) | null): string => {
  if (value === null || value === undefined || value.trim() === "") return "—";
  return (option && /^\d+$/.test(value.trim()) ? option(Number(value.trim())) : undefined) ?? value;
};

/** The staff's reading: blank by blank, the answer, the key and the verdict. */
export function clozeAnswerDoc(config: ClozeConfig, answer: ClozeAnswer, details: ClozeDetails | null): Block[] {
  const blanks = parseCloze(config.text).blanks;
  const given = (index: number): string => {
    const blank = blanks[index];
    return shown(answer.blanks[index], blank?.kind === "select" ? (i) => blank.options[i] : null);
  };
  if (details === null) {
    return [table(["Blank", "Given"], blanks.map((b) => [numbered(b.index), given(b.index)]))];
  }
  return [
    table(
      ["Blank", "Given", "Expected", "Result"],
      details.perBlank.map((p) => [numbered(p.index), given(p.index), p.expected, p.ok ? "right" : "wrong"]),
    ),
  ];
}

/** The parts of a student's breakdown this document reads; whatever else it holds is ignored. */
interface StudentBlankResult {
  index: number;
  ok?: boolean;
  expected?: string;
}

function studentResults(details: unknown): StudentBlankResult[] {
  const perBlank = (details as { perBlank?: unknown } | null)?.perBlank;
  if (!Array.isArray(perBlank)) return [];
  return perBlank.flatMap((p: unknown) => {
    const r = p as Partial<Record<keyof StudentBlankResult, unknown>> | null;
    if (typeof r?.index !== "number") return [];
    return [
      {
        index: r.index,
        ...(typeof r.ok === "boolean" ? { ok: r.ok } : {}),
        ...(typeof r.expected === "string" ? { expected: r.expected } : {}),
      },
    ];
  });
}

/**
 * The student's own reading: blank by blank, what they wrote — a dropdown by
 * the option at its position in their view — then the verdict and the key
 * when their breakdown holds them (the feedback policy decided upstream).
 * Every side is read by the blank's index, never by list order.
 */
export function clozeStudentAnswerDoc(student: ClozeStudent, answer: ClozeAnswer, details: unknown, labels: Labels): Block[] {
  const results = new Map(studentResults(details).map((r) => [r.index, r]));
  const withVerdict = [...results.values()].some((r) => r.ok !== undefined);
  const withKey = [...results.values()].some((r) => r.expected !== undefined);
  const rows = student.blanks.map((blank) => {
    const options = blank.kind === "select" ? blank.options : null;
    const result = results.get(blank.index);
    return [
      numbered(blank.index),
      shown(answer.blanks[blank.index], options ? (id) => options.find((o) => o.id === id)?.label : null),
      ...(withVerdict ? [result?.ok === undefined ? "" : result.ok ? labels.right : labels.wrong] : []),
      ...(withKey ? [result?.expected ?? ""] : []),
    ];
  });
  return [
    table(
      [labels.blank, labels.yourAnswer, ...(withVerdict ? [labels.result] : []), ...(withKey ? [labels.expected] : [])],
      rows,
    ),
  ];
}
