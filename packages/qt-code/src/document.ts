/**
 * The `code` question as blocks of an exported or printed document
 * (ADR-121 §2, ADR-125, ADR-126 §8 as amended on 2026-11-04).
 *
 * The statement is read from the student view only; the staff answer is the
 * source as it ran, rebuilt from the STORED template and the student's
 * regions (invariant 14), and its tests as the staff read them. On paper the
 * answer is a ruled free frame for a program written by hand, graded by hand
 * (ADR-125 §14), as for `blocks`; a student's copy prints their own source,
 * rebuilt from the view they were served.
 */
import { answerZone, code, markdown, noAnswerOr, table, tests, type Block, type Labels } from "@quiz/docexport";
import { joinSegments, TemplateRegionMismatch } from "@quiz/domain/lockedTemplate";

import { assembleCodeSource } from "./grade.js";
import {
  isCodeAnswered,
  type CodeAnswer,
  type CodeConfig,
  type CodeDetails,
  type CodeSolution,
  type CodeStudent,
} from "./schema.js";
import { stripMarkerLines } from "./segments.js";

/** The template a student is given, its marker lines hidden as the player hides them. */
const templateOf = (student: CodeStudent): string => stripMarkerLines(student.segments.map((s) => s.text).join(""));

/** The prompt, then the code the student started from. */
export function codeStatementDoc(student: CodeStudent): Block[] {
  const template = templateOf(student);
  return [markdown(student.prompt), ...(template.trim() === "" ? [] : [code(student.language, template)])];
}

/**
 * Ruled lines for a program written by hand, under the template the
 * statement printed (ADR-126 §8, amended 2026-11-04). About half a page; a
 * longer template asks for as many lines, up to a page. The height never
 * comes from the reference (ADR-126 §6).
 */
const LINE_PITCH_MM = 8;
const MIN_ANSWER_LINES = 16;
const MAX_ANSWER_LINES = 28;

export function codeAnswerZone(student: CodeStudent): Block[] {
  const templateLines = templateOf(student).trimEnd().split("\n").length;
  const lines = Math.min(MAX_ANSWER_LINES, Math.max(MIN_ANSWER_LINES, templateLines));
  return [answerZone("free", { heightMm: lines * LINE_PITCH_MM, ruling: { kind: "lines", pitchMm: LINE_PITCH_MM } })];
}

/**
 * The student's own program in their copy, rebuilt from the template they
 * were served and the regions they handed back — the student view only
 * (invariant 4). A stored answer that no longer fits the template prints its
 * regions alone, never pasted into the wrong hole.
 */
export function codeStudentAnswerDoc(student: CodeStudent, answer: CodeAnswer, _details: unknown, labels: Labels): Block[] {
  let source: string;
  try {
    source = stripMarkerLines(joinSegments(student.segments, answer.regions));
  } catch (err) {
    if (!(err instanceof TemplateRegionMismatch)) throw err;
    source = answer.regions.join("\n");
  }
  return [noAnswerOr(labels, !isCodeAnswered(answer), code(student.language, source))];
}

/** The reference solution, then the cases the grade runs, hidden ones by name. */
export function codeSolutionDoc(solution: CodeSolution, student: CodeStudent): Block[] {
  return [
    code(student.language, solution.referenceSolution),
    table(
      ["Test", "Visibility", "Arguments", "Points"],
      solution.cases.map((c) => [c.name, c.visible ? "visible" : "hidden", c.args.join(" "), String(c.points)]),
    ),
  ];
}

/**
 * The source the runner compiled, the compiler's complaint when it refused
 * it, and every test with its verdict — the staff's reading of `details`.
 */
export function codeAnswerDoc(config: CodeConfig, answer: CodeAnswer, details: CodeDetails | null): Block[] {
  let source: Block;
  try {
    source = code(config.language, assembleCodeSource(config, answer));
  } catch (err) {
    // A stored answer that no longer fits the template: never pasted into the wrong hole.
    if (!(err instanceof TemplateRegionMismatch)) throw err;
    source = markdown("The answer no longer fits the question's template.");
  }
  if (details === null) return [source];
  const compile =
    details.compile && !details.compile.ok ? [markdown("Compilation failed:"), code("text", details.compile.stderr)] : [];
  return [
    source,
    ...compile,
    tests(details.cases.map((c) => ({ name: c.name, visible: c.visible, ok: c.ok, points: c.points }))),
  ];
}
