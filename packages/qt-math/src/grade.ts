/**
 * `math` grading (docs/spec/04 §4.16, ADR-102): the answer is READ against
 * the question (`readMath`, with the very rules the student was shown),
 * then compared to each accepted answer at the question's sample points;
 * the first that matches gives its points.
 *
 * An answer that cannot be read — malformed, naming an undeclared symbol,
 * breaking a function rule — is worth 0 with the reason in the details, so
 * the teacher sees "not readable" rather than "wrong" and may override it
 * in the grading table. STACK never grades an invalid answer either; here
 * the deadline does the closing, so the verdict is 0. A blank answer is
 * simply no answer: 0, graded.
 */
import type { GradedResult } from "@quiz/core/server";
import { compareMath, readMath, samplePoints } from "@quiz/domain/math";
import { round2 } from "@quiz/domain/round";

import { fieldRules, isMathAnswered, type MathAnswer, type MathConfig, type MathDetails } from "./schema.js";

/**
 * The points every answer of the question is compared at: drawn once from
 * the question's own content (its first key and its symbols), so the same
 * text gets the same verdict on every paper and on every regrade.
 */
export function gradingPoints(config: MathConfig) {
  return samplePoints(config.symbols, config.samples, [config.answers[0]?.value ?? "", JSON.stringify(config.symbols)]);
}

/** Every key read against the symbols alone: the field's rules are the student's, not the teacher's. */
export function readKeys(config: MathConfig) {
  const symbols = config.symbols.map((s) => s.name);
  return config.answers.map((answer, index) => ({ index, points: answer.points, read: readMath(answer.value, { symbols }) }));
}

const graded = (details: MathDetails, points: number, itemPoints: number): GradedResult<MathDetails> => ({
  kind: "graded",
  points: round2(points),
  maxPoints: itemPoints,
  state: "validated",
  details,
});

export function gradeMath(config: MathConfig, answer: MathAnswer | null, itemPoints: number): GradedResult<MathDetails> {
  if (answer === null || !isMathAnswered(answer)) {
    return graded({ status: "graded", matchedIndex: null, fraction: 0, latex: null }, 0, itemPoints);
  }
  const read = readMath(answer.latex, fieldRules(config));
  if (!read.ok) return graded({ status: "invalid", problem: read.problem, matchedIndex: null, fraction: 0, latex: null }, 0, itemPoints);
  const { reading } = read;
  const points = gradingPoints(config);
  const keys = readKeys(config).flatMap((key) => (key.read.ok ? [{ index: key.index, points: key.points, reading: key.read.reading }] : []));
  const match = keys.find((key) => compareMath(key.reading, reading, points, config.tolerance).equivalent);
  return graded(
    { status: "graded", matchedIndex: match?.index ?? null, fraction: match?.points ?? 0, latex: reading.latex },
    (match?.points ?? 0) * itemPoints,
    itemPoints,
  );
}
