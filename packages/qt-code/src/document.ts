/**
 * The `code` question as blocks of an exported document (ADR-121 §2).
 *
 * The statement is read from the student view only; the answer is the
 * source as it ran, rebuilt from the STORED template and the student's
 * regions (invariant 14), and its tests as the staff read them.
 */
import { code, markdown, table, tests, type Block } from "@quiz/docexport";
import { TemplateRegionMismatch } from "@quiz/domain/lockedTemplate";

import { assembleCodeSource } from "./grade.js";
import type { CodeAnswer, CodeConfig, CodeDetails, CodeSolution, CodeStudent } from "./schema.js";

/** The prompt, then the code the student started from. */
export function codeStatementDoc(student: CodeStudent): Block[] {
  const template = student.segments.map((s) => s.text).join("");
  return [markdown(student.prompt), ...(template.trim() === "" ? [] : [code(student.language, template)])];
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
