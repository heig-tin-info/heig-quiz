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
 * the terms.
 */
import type { LlmGradeOutcome, LlmGradeRequest, LlmService } from "@quiz/core/server";

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

/** The whole rubric, as a pure function: what the tests pin. */
export function stubGrade(req: LlmGradeRequest): LlmGradeOutcome {
  const rubric = stemsOf(req.rubric);
  const terms = rubric.size > 0 ? rubric : stemsOf(req.reference ?? "");
  const answer = new Set(words(req.answer).map((w) => w.slice(0, STEM)));
  const found = [...terms].filter((t) => answer.has(t)).length;
  const coverage = terms.size === 0 ? 0 : found / terms.size;

  const raw = req.maxPoints * Math.min(1, coverage / FULL_MARKS_AT);
  const points = Math.min(req.maxPoints, Math.round(raw * 4) / 4);
  const confidence = terms.size === 0 ? "low" : confidenceOf(coverage, req.answer);
  const justification = `Development stub, not a model: ${JUDGEMENTS[confidence]}.`;
  // One criterion, the whole question: the stub reads no rubric's structure.
  const criteria = [{ criterion: "Coverage of the rubric", points, maxPoints: req.maxPoints, comment: justification }];
  return { points, justification, confidence, criteria, model: STUB_MODEL };
}

/** What a stub proposal names as its model: never a real one. */
export const STUB_MODEL = "development-stub";

export class StubLlm implements LlmService {
  grade(req: LlmGradeRequest, _billedTo: string | null): Promise<LlmGradeOutcome> {
    return Promise.resolve(stubGrade(req));
  }
}
