/**
 * Section 5b of the mock — the teacher's stateless evaluation preview
 * (issue #75). Registered after `grading.ts`, and reading sections 2 and 3:
 * an item of the preview is the pool question its evaluation is frozen on,
 * rendered by the same `studentView` the rest of the mock uses and graded by
 * the same `tryAnswer` as the question editor's Try panel.
 *
 * Like the API, nothing is kept: the seed is the whole state. The order of
 * the items is the API's, from the same domain rule and the same seed — the
 * order moves on "Restart" — and the code runner answers the
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
import { AI_KEY, JUSTIFICATION_KEY, evaluationConditionsOf } from "@quiz/contracts";
import { evaluationTotal, gradeFromPoints, placeIntros, round2, sectionedOrder } from "@quiz/domain";

import { evaluationOr404, itemQuestion, mockCourseOf, templateOr404, type MockEvaluation } from "./evaluation";
import { mockProvided } from "./library";
import { frozenConfig, solutionOf, studentSolutionOf, studentView, tryAnswer } from "./pool";
import { MockError, flags, on } from "./runtime";

/** The placeholder the API sends as the attempt id of a preview. */
const PREVIEW_ATTEMPT_ID = "00000000-0000-4000-8000-000000000000";

/** The details without the model's keys: what the real preview, which never asks one, would hold. */
function withoutAi(details: unknown): unknown {
  if (!details || typeof details !== "object") return details;
  const { [JUSTIFICATION_KEY]: _j, [AI_KEY]: _a, ...rest } = details as Record<string, unknown>;
  return rest;
}

let seeds = 1_000;

/** The items in the order a student of `seed` gets them: the server's own rule (`sectionedOrder`, ADR-143). */
function orderOf(e: MockEvaluation, seed: number) {
  return sectionedOrder(e.items, (item) => item, {
    shuffle: e.settings.shuffleItems === true,
    seed,
    evaluationId: e.id,
  });
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

export function viewOf(e: MockEvaluation, seed: number): AttemptView {
  const nowIso = new Date().toISOString();
  const ordered = orderOf(e, seed);
  const placed = placeIntros(e.items, ordered, (i) => i);
  // ADR-144 §7: the staff's preview lists the selection, as the server's does.
  const documents = mockProvided(mockCourseOf(e), e.documents);
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
    // ADR-079: the server's builder, for a student with no extra time.
    conditions: evaluationConditionsOf({
      mode: e.mode,
      settings: e.settings as AttemptView["evaluation"]["settings"],
      durationS: e.durationS,
      closesAt: e.closesAt,
      timeBonusPercent: 0,
      documentCount: documents.length,
    }),
    documents,
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
    items: ordered.flatMap((item, rank) => {
      const q = itemQuestion(item);
      if (!q) return [];
      const { intro, sectionIntro, section } = placed[rank]!;
      return [
        {
          id: item.id,
          position: item.position,
          points: item.points,
          type: item.type,
          milestone: item.milestone,
          counting: item.counting,
          intro,
          section,
          sectionIntro,
          student: studentView(q, frozenConfig(q)),
          answer: null,
          revision: 0,
          markedDone: false,
          skipped: false,
          flagged: false,
          locked: false,
          acquired: false,
          checked: false,
          correction: null,
        },
      ];
    }),
  };
}

/**
 * The two homes of a previewed paper (F-EVAL-25): an evaluation, and a
 * template through the evaluation-shaped shell it carries. A template has
 * no dates, so its common deadline has no clock to rehearse.
 */
const HOMES: readonly (readonly [string, (id: string) => MockEvaluation])[] = [
  ["evaluations", evaluationOr404],
  ["templates", (id) => templateOr404(id).shell],
];

function startPreview(e: MockEvaluation, body: Record<string, unknown>): EvaluationPreview {
  // A seed given back reloads that walk (ADR-018, sixth addendum).
  const seed = typeof body.seed === "number" ? body.seed : (seeds += 7);
  return {
    seed,
    durationS: durationOf(e),
    view: viewOf(e, seed),
    versions: Object.fromEntries(e.items.map((i) => [i.id, i.versionNumber])),
  };
}

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


/** The key of that item preview, as a student reads it once shown (ADR-037). */
function itemSolution(e: MockEvaluation, itemId: string): PreviewSolution {
  const item = e.items.find((i) => i.id === itemId);
  const q = item ? itemQuestion(item) : null;
  if (!item || !q) throw new MockError(404, "not_found");
  return {
    solution: studentSolutionOf(q, solutionOf(q)),
    explanation: q.versions.at(-1)?.explanation || null,
  };
}

function gradePreview(e: MockEvaluation, body: Record<string, unknown>): PreviewCorrection {
  if (flags.fail) throw new MockError(500, "Simulated failure");
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
      status = "runner_unavailable";
      itemPoints = null;
      ungraded += 1;
    } else if (tried?.manual) {
      // The preview never offers the model (ADR-063 §10): an essay is a
      // proposal by hand, without the Try's AI keys.
      status = "manual";
      itemPoints = null;
      tried.details = withoutAi(tried.details);
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
}

for (const [home, load] of HOMES) {
  const base = `/app/api/${home}/:id/preview`;
  on("POST", base, (m, body) => startPreview(load(m.groups!.id!), body));
  on("GET", `${base}/items/:itemId`, (m) => itemPreview(load(m.groups!.id!), m.groups!.itemId!));
  on("GET", `${base}/items/:itemId/solution`, (m) => itemSolution(load(m.groups!.id!), m.groups!.itemId!));
  on("POST", `${base}/run`, () => {
    throw new MockError(503, "runner_unavailable");
  });
  on("POST", `${base}/simulate`, () => {
    throw new MockError(503, "runner_unavailable");
  });
  on("POST", `${base}/grade`, (m, body) => gradePreview(load(m.groups!.id!), body));
}
