/**
 * The STUB LLM provider (`LLM_PROVIDER=stub`, ADR-045): development, the
 * seed and the tests only. `config.ts` refuses to start with it under
 * `NODE_ENV=production`, exactly like the development login — a grade that
 * no model produced must never reach a real student.
 *
 * It answers through the same call path as a provider would (the grading
 * pass, `app.llm.grade`), and deterministically: the same request always
 * gets the same points, justification and confidence, so the seed and the
 * screenshots are stable. Its rubric is a keyword count — the terms of the
 * teacher's rubric (or of the model answer when the rubric is empty) found
 * in the answer — and its justification says it is a stub without naming
 * the terms. An essay with structured criteria (ADR-118) gets one entry per
 * criterion, the same count over its title and prompt, in its weight units:
 * `askGrader` scales them like a model's.
 */
import type { LlmGradeOutcome, LlmGradeRequest, LlmRequestCriterion } from "@quiz/core/server";

/** Words shorter than this are too common to say anything about an answer. */
const MIN_TERM = 5;
/** Two words are the same term when they share this prefix ("empile", "empilent"). */
const STEM = 5;
/** The share of the terms that earns full marks: nobody writes every word of a rubric. */
const FULL_MARKS_AT = 0.6;
/** Under this many characters an answer is too short to judge with any confidence. */
const SHORT_ANSWER = 80;

/** Lower case, accents dropped, split on anything that is not a letter or a digit. */
function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

/** The distinct stems of a text's terms, one per term. */
function stemsOf(text: string): Set<string> {
  return new Set(
    words(text)
      .filter((w) => w.length >= MIN_TERM && !/^\d+$/.test(w))
      .map((w) => w.slice(0, STEM)),
  );
}

/** Sure of a clear case (most terms, or almost none), unsure of the middle and of a few words. */
function confidenceOf(coverage: number, answer: string): LlmGradeOutcome["confidence"] {
  if (answer.trim().length < SHORT_ANSWER) return "low";
  if (coverage >= 0.5 || coverage < 0.15) return "high";
  if (coverage >= 0.3) return "medium";
  return "low";
}

const JUDGEMENTS: Record<LlmGradeOutcome["confidence"], string> = {
  high: "the answer is clearly on one side of the rubric",
  medium: "the answer covers part of the rubric",
  low: "too little to judge with confidence",
};

/** The share of `terms` the answer holds, 0 when there are none. */
function coverageOf(terms: Set<string>, answer: Set<string>): number {
  return terms.size === 0 ? 0 : [...terms].filter((t) => answer.has(t)).length / terms.size;
}

/** `max` scaled by the coverage, full at {@link FULL_MARKS_AT}, in quarter points. */
const scored = (max: number, coverage: number) =>
  Math.min(max, Math.round(max * Math.min(1, coverage / FULL_MARKS_AT) * 4) / 4);

/** Each criterion from the terms of its title and prompt, in its weight units. */
function byCriteria(req: LlmGradeRequest, criteria: readonly LlmRequestCriterion[], answer: Set<string>): LlmGradeOutcome {
  const all = new Set<string>();
  const entries = criteria.map((c) => {
    const terms = stemsOf(`${c.title} ${c.prompt}`);
    terms.forEach((t) => all.add(t));
    const points = scored(c.weight, coverageOf(terms, answer));
    return { id: c.id, criterion: c.title, points, maxPoints: c.weight };
  });
  const confidence = all.size === 0 ? "low" : confidenceOf(coverageOf(all, answer), req.answer);
  const justification = `Development stub, not a model: ${JUDGEMENTS[confidence]}.`;
  return {
    points: entries.reduce((sum, c) => sum + c.points, 0),
    justification,
    confidence,
    criteria: entries.map((c) => ({ ...c, comment: justification })),
    model: STUB_MODEL,
  };
}

/** The whole rubric, as a pure function: what the tests pin. */
export function stubGrade(req: LlmGradeRequest): LlmGradeOutcome {
  const answer = new Set(words(req.answer).map((w) => w.slice(0, STEM)));
  if (req.criteria !== undefined && req.criteria.length > 0) return byCriteria(req, req.criteria, answer);
  const rubric = stemsOf(req.rubric);
  const terms = rubric.size > 0 ? rubric : stemsOf(req.reference ?? "");
  const coverage = coverageOf(terms, answer);

  const points = scored(req.maxPoints, coverage);
  const confidence = terms.size === 0 ? "low" : confidenceOf(coverage, req.answer);
  const justification = `Development stub, not a model: ${JUDGEMENTS[confidence]}.`;
  // One criterion, the whole question: the stub reads no rubric's structure.
  const criteria = [{ criterion: "Coverage of the rubric", points, maxPoints: req.maxPoints, comment: justification }];
  return { points, justification, confidence, criteria, model: STUB_MODEL };
}

/** What a stub proposal names as its model: never a real one. */
export const STUB_MODEL = "development-stub";

export class StubLlm {
  grade(req: LlmGradeRequest): Promise<LlmGradeOutcome> {
    return Promise.resolve(stubGrade(req));
  }
}
