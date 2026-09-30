/**
 * Section 5b of the mock — the teacher's stateless evaluation preview
 * (issue #75). Registered after `grading.ts`, and reading sections 2 and 3:
 * an item of the preview is the pool question its evaluation is frozen on,
 * rendered by the same `studentView` the rest of the mock uses and graded by
 * the same `tryAnswer` as the question editor's Try panel.
 *
 * Like the API, nothing is kept: the seed is the whole state. The order of
 * the items is a rotation by the seed when the evaluation shuffles them —
 * enough to see the order move on "Restart" — and the code runner answers the
 * `runner_unavailable` of a machine without a container engine, so the
 * correction shows the warning a default deployment shows.
 */
import type {
  AttemptView,
  EvaluationPreview,
  ItemPreview,
  PreviewCorrection,
  PreviewCorrectionItem,
  PreviewItemStatus,
  PreviewSolution,
} from "@quiz/contracts";
import { evaluationTotal, gradeFromPoints, round2 } from "@quiz/domain";

import { evaluationOr404, itemQuestion, templateOr404, type MockEvaluation } from "./evaluation";
import { frozenConfig, solutionOf, studentSolutionOf, studentView, tryAnswer } from "./pool";
import { MockError, flags, on } from "./runtime";

/** The placeholder the API sends as the attempt id of a preview. */
const PREVIEW_ATTEMPT_ID = "00000000-0000-4000-8000-000000000000";

let seeds = 1_000;

/** The items in the order a student of `seed` gets them. */
function orderOf(e: MockEvaluation, seed: number) {
  const items = [...e.items];
  if (e.settings.shuffleItems !== true || items.length === 0) return items;
  const shift = seed % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

function durationOf(e: MockEvaluation): number | null {
  const timing = e.settings.timing;
  if (timing === "duration") return e.durationS && e.durationS > 0 ? e.durationS : null;
  if (timing === "deadline" && e.opensAt && e.closesAt) {
    const windowS = Math.round((Date.parse(e.closesAt) - Date.parse(e.opensAt)) / 1000);
    return windowS > 0 ? windowS : null;
  }
  return null;
}

function viewOf(e: MockEvaluation, seed: number): AttemptView {
  const nowIso = new Date().toISOString();
  return {
    attempt: {
      id: PREVIEW_ATTEMPT_ID,
      state: "in_progress",
      startedAt: nowIso,
      deadlineAt: null,
      lastItemId: null,
      serverNow: nowIso,
      preview: true,
      readOnly: false,
    },
    evaluation: {
      id: e.id,
      title: e.title,
      mode: e.mode,
      state: e.state,
      settings: e.settings as AttemptView["evaluation"]["settings"],
      feedbackPolicy: e.feedbackPolicy as AttemptView["evaluation"]["feedbackPolicy"],
      pausedAt: e.pausedAt,
      totalPoints: evaluationTotal(e.items),
    },
    items: orderOf(e, seed).flatMap((item) => {
      const q = itemQuestion(item);
      if (!q) return [];
      return [
        {
          id: item.id,
          position: item.position,
          points: item.points,
          type: item.type,
          milestone: item.milestone,
          bonus: item.bonus,
          student: studentView(q, frozenConfig(q)),
          answer: null,
          revision: 0,
          markedDone: false,
          skipped: false,
          flagged: false,
          locked: false,
        },
      ];
    }),
  };
}

on("POST", "/app/api/evaluations/:id/preview", (m, body): EvaluationPreview => {
  const e = evaluationOr404(m.groups!.id!);
  // A seed given back reloads that walk (ADR-018, sixth addendum).
  const seed = typeof body.seed === "number" ? body.seed : (seeds += 7);
  return {
    seed,
    durationS: durationOf(e),
    view: viewOf(e, seed),
    versions: Object.fromEntries(e.items.map((i) => [i.id, i.versionNumber])),
  };
});

/**
 * One item at the version its evaluation or template froze (issue #127,
 * F-EVAL-25): that version's config when the question still has it, through
 * the same `studentView`.
 */
function itemPreview(e: MockEvaluation, itemId: string): ItemPreview {
  const item = e.items.find((i) => i.id === itemId);
  const q = item ? itemQuestion(item) : null;
  if (!item || !q) throw new MockError(404, "not_found");
  const frozen = q.versions.find((v) => v.number === item.versionNumber)?.config ?? frozenConfig(q);
  return {
    itemId: item.id,
    type: item.type,
    versionNumber: item.versionNumber,
    points: item.points,
    student: studentView(q, frozen),
  };
}

on("GET", "/app/api/evaluations/:id/preview/items/:itemId", (m) =>
  itemPreview(evaluationOr404(m.groups!.id!), m.groups!.itemId!),
);
on("GET", "/app/api/templates/:id/preview/items/:itemId", (m) =>
  itemPreview(templateOr404(m.groups!.id!).shell, m.groups!.itemId!),
);

/** The key of that item preview, as a student reads it once shown (ADR-037). */
function itemSolution(e: MockEvaluation, itemId: string): PreviewSolution {
  const item = e.items.find((i) => i.id === itemId);
  const q = item ? itemQuestion(item) : null;
  if (!item || !q) throw new MockError(404, "not_found");
  return { solution: studentSolutionOf(q, solutionOf(q)) };
}

on("GET", "/app/api/evaluations/:id/preview/items/:itemId/solution", (m) =>
  itemSolution(evaluationOr404(m.groups!.id!), m.groups!.itemId!),
);
on("GET", "/app/api/templates/:id/preview/items/:itemId/solution", (m) =>
  itemSolution(templateOr404(m.groups!.id!).shell, m.groups!.itemId!),
);

on("POST", "/app/api/evaluations/:id/preview/run", () => {
  throw new MockError(503, "runner_unavailable");
});

on("POST", "/app/api/evaluations/:id/preview/simulate", () => {
  throw new MockError(503, "runner_unavailable");
});

on("POST", "/app/api/evaluations/:id/preview/grade", (m, body): PreviewCorrection => {
  if (flags.fail) throw new MockError(500, "Simulated failure");
  const e = evaluationOr404(m.groups!.id!);
  const seed = Number(body.seed);
  const answers = (body.answers ?? {}) as Record<string, unknown>;
  const items: PreviewCorrectionItem[] = [];
  let points = 0;
  let ungraded = 0;
  for (const [rank, shown] of viewOf(e, seed).items.entries()) {
    const item = e.items.find((i) => i.id === shown.id)!;
    const q = itemQuestion(item)!;
    const answer = shown.id in answers ? answers[shown.id] : undefined;
    const tried =
      answer === undefined
        ? null
        : (tryAnswer(q, frozenConfig(q), answer, e.mcqPolicy) as {
            status: string;
            points?: number;
            maxPoints?: number;
            details?: unknown;
            solution?: unknown;
            manual?: true;
          });
    let status: PreviewItemStatus = "graded";
    let itemPoints: number | null = 0;
    if (tried && tried.status !== "graded") {
      status = tried.status === "llm_unavailable" ? "llm_unavailable" : "runner_unavailable";
      itemPoints = null;
      ungraded += 1;
    } else if (tried?.manual) {
      status = "manual";
      itemPoints = null;
    } else if (tried) {
      // `tryAnswer` scores on the question's own scale; the item has its own.
      itemPoints = round2(((tried.points ?? 0) / (tried.maxPoints || 1)) * item.points);
    }
    points += itemPoints ?? 0;
    items.push({
      itemId: shown.id,
      position: rank,
      type: shown.type,
      status,
      points: itemPoints,
      maxPoints: item.points,
      verdict:
        itemPoints === null
          ? null
          : itemPoints >= item.points
            ? "correct"
            : itemPoints > 0
              ? "partial"
              : "wrong",
      student: shown.student,
      answer: answer ?? null,
      solution: studentSolutionOf(q, tried?.solution ?? solutionOf(q)),
      explanation: q.versions.at(-1)?.explanation || null,
      details: tried?.status === "graded" ? (tried.details ?? null) : null,
    });
  }
  const totalPoints = evaluationTotal(e.items);
  const scale = (e.gradingScale.kind ? e.gradingScale : { kind: "linear", rounding: "nearest" }) as
    PreviewCorrection["scale"];
  points = round2(points);
  return {
    seed,
    points,
    totalPoints,
    grade: gradeFromPoints(points, totalPoints, scale),
    scale,
    ungraded,
    items,
  };
});
