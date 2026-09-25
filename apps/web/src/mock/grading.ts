/** Section 5 of the mock — see `index.ts` for the layout. */
import {
  describe,
  histogram,
  parseCloze,
  round2,
} from "@quiz/domain";
import type {
  CircuitStudent,
} from "@quiz/qt-circuit/client";
import {
  H,
  MockError,
  iso,
  on,
  pick,
  rand,
} from "./runtime";
import {
  MockEvaluation,
  evaluationOr404,
  evaluations,
} from "./evaluation";
import {
  ME_TEACHER,
} from "./org";
import {
  CircuitStimulusLike,
  CodeCaseLike,
  EMPTY_SCHEMATIC,
  MockQuestion,
  MockSchematic,
  RC_REFERENCE,
  RC_STUDENT,
  mockCircuitDetails,
  questions,
  studentView,
  tryAnswer,
  versionRow,
} from "./pool";
import {
  STUDENT_ATTEMPT,
  STUDENT_PAST_ATTEMPT,
} from "./student";

// --- 5. Grading, results and the student's feedback (WP10) ----------------
//
// The second half of an evaluation's life, layered on top of section 3 rather
// than beside it: a GRADING WORLD is derived from one evaluation of that
// section — its items, its dashboard rows — and holds what the first half has
// no use for, the answers handed in and the chain of gradings on each cell.
//
// Two of them, so both halves of the story are reachable: the `closed`
// evaluation is still being graded (proposals waiting, a few cells the runner
// never settled), and the `released` one is published and fully validated.
// Because the ids are the evaluation's own, `/evaluations/<id>/grading` opened
// from the classroom list is the same screen as the one the panel links to.
//
// The gradings are generated from a per-student ability so the histogram and
// the per-question success rates look like a real class rather than a uniform
// cloud, and the answers go through the SAME `tryAnswer` the try panel uses,
// so what the panel renders is what the type would really have produced.
//
// Scene flags: `empty` leaves the two evaluations with no item and no attempt
// at all (the empty queue and the empty results table), `many` grows the
// class with the classroom's roster.

interface MockEvalItem {
  id: string;
  position: number;
  questionId: string;
  internalName: string;
  type: string;
  points: number;
}

interface MockAttempt {
  id: string;
  userId: string;
  displayName: string;
  /** A teacher's own test walk (ADR-018). */
  staff: boolean;
  lastName: string;
  firstName: string;
  email: string;
  pseudonym: string;
  state: "submitted" | "expired";
  durationS: number;
  ability: number;
}

interface MockGrading {
  id: string;
  answerId: string | null;
  attemptId: string;
  itemId: string;
  points: number;
  maxPoints: number;
  source: "auto" | "llm" | "manual";
  state: "proposed" | "validated" | "superseded";
  details: unknown;
  confidence: "low" | "medium" | "high" | null;
  comment: string | null;
  gradedBy: string | null;
  gradedAt: string;
  supersedesId: string | null;
  regradeNote: string | null;
}

interface MockGradingWorld {
  /** The evaluation of section 3 this is the second half of. */
  evaluation: MockEvaluation;
  items: MockEvalItem[];
  attempts: MockAttempt[];
  /** `attemptId:itemId` -> what the student handed in (absent when blank). */
  answers: Map<string, unknown>;
  /** `attemptId:itemId` -> the chain, oldest first, at most one standing. */
  gradings: Map<string, MockGrading[]>;
}

const cellKey = (attemptId: string, itemId: string) => `${attemptId}:${itemId}`;

/** The published configuration of a mock question (its latest version). */
function publishedConfig(q: MockQuestion): Record<string, unknown> {
  return q.versions.at(-1)?.config ?? q.draft.config;
}

/** The answer a student of the given ability would have handed in. */
function mockAnswer(q: MockQuestion, config: Record<string, unknown>, ability: number): unknown {
  if (q.type === "mcq") {
    const choices = (config.choices ?? []) as { text: string; correct: boolean }[];
    const right = choices.findIndex((c) => c.correct);
    const wrong = choices.findIndex((c) => !c.correct);
    return { selected: [rand() < ability ? right : wrong] };
  }
  if (q.type === "short") {
    return { text: rand() < ability ? "8" : pick(["4", "64", "16"]) };
  }
  if (q.type === "cloze") {
    const parse = parseCloze(String(config.text ?? ""));
    return {
      blanks: parse.blanks.map((blank) => {
        const good = rand() < ability;
        switch (blank.kind) {
          case "select":
            return String(good ? (blank.correct[0] ?? 0) : ((blank.correct[0] ?? 0) + 1) % Math.max(1, blank.options.length));
          case "number":
            return String(good ? blank.value : blank.value + 1);
          case "regex":
            return good ? "int" : "float";
          default:
            return good ? (blank.answers[0] ?? "") : "delete";
        }
      }),
    };
  }
  if (q.type === "circuit") {
    // The wrong half of the class left the capacitor's lower pin in the air,
    // which is the mistake this type actually produces.
    return { schematic: rand() < ability ? RC_REFERENCE : RC_STUDENT };
  }
  const good = rand() < ability;
  return {
    regions: [
      good
        ? "    int s = 0;\n    for (const int *p = t; p < t + n; p++) s += *p;\n    return s;\n"
        : "    int s = 0;\n    for (size_t i = 0; i <= n; i++) s += t[i];\n    return s;\n",
    ],
    lastRun: null,
  };
}

/** `code` never reaches a runner here, so its case-by-case detail is built. */
function mockCodeDetails(config: Record<string, unknown>, ability: number) {
  const cases = ((config.tests as { cases?: CodeCaseLike[] })?.cases ?? []) as CodeCaseLike[];
  const results = cases.map((c) => {
    const ok = rand() < ability;
    return {
      name: c.name,
      visible: c.visible,
      points: c.points,
      ok,
      exitCode: 0,
      ms: 12 + Math.round(rand() * 40),
      timedOut: false,
      oom: false,
      expected: c.expected,
      actual: ok ? c.expected : "0",
      stderr: "",
    };
  });
  const earned = results.reduce((s, c) => (c.ok ? s + c.points : s), 0);
  const total = results.reduce((s, c) => s + c.points, 0) || 1;
  return {
    details: {
      runner: "ok",
      compile: { ok: true, stderr: "", ms: 180 },
      cases: results,
      earned,
      total,
      sourceSha256: "0".repeat(64),
    },
    fraction: earned / total,
    solution: {
      referenceSolution: String(config.referenceSolution ?? ""),
      cases: cases.map((c) => ({
        name: c.name,
        stdin: c.stdin,
        expected: c.expected,
        points: c.points,
        visible: c.visible,
      })),
      compare: (config.tests as { compare?: unknown })?.compare ?? {},
    },
  };
}

/**
 * Half a point is the finest grain a teacher grades at, and it keeps the
 * table free of the 7.01 a chain of fractions produces.
 */
const halfPoints = (n: number) => Math.round(n * 2) / 2;

let gradingSeq = 0;

/**
 * The grading world of one evaluation of section 3.
 *
 * It is DERIVED from that evaluation, never parallel to it: the items are its
 * items and the attempts are its dashboard rows, so an id that works in
 * `/evaluations/<id>` works in `/evaluations/<id>/grading` too, and the queue
 * grades the very questions the configuration screen lists.
 */
function buildGradingWorld(
  evaluation: MockEvaluation,
  options: { allValidated: boolean; pinnedAttemptId?: string },
): MockGradingWorld {
  const items: MockEvalItem[] = evaluation.items
    .filter((i) => questions.some((q) => q.id === i.questionId))
    .map((i) => ({
      id: i.id,
      position: i.position,
      questionId: i.questionId,
      internalName: i.internalName,
      type: i.type,
      points: i.points,
    }));

  // One attempt per dashboard row that has one. A row without an attempt is a
  // student who never opened it, and stays one: the results table lists them
  // as absent (deviation W6-10) instead of inventing a second class.
  const attempts: MockAttempt[] = [];
  evaluation.rows.forEach((row) => {
    if (row.attemptId === null) return;
    // The student persona's own attempt is pinned on the first row, so the
    // `past` card of their home and the player's finished screen link to a
    // feedback page that really exists — on the very evaluation the teacher
    // is grading two tabs away.
    if (attempts.length === 0 && options.pinnedAttemptId) row.attemptId = options.pinnedAttemptId;
    attempts.push({
      id: row.attemptId,
      userId: row.userId,
      displayName: row.displayName,
      staff: row.staff,
      lastName: row.lastName,
      firstName: row.firstName,
      email: row.email,
      pseudonym: row.pseudonym,
      state: row.state === "submitted" ? "submitted" : "expired",
      durationS: 600 + Math.round(rand() * 1500),
      // A class, not a cloud: a few who have it, a few who do not, most in
      // between. The histogram below is the point of the spread.
      ability: Math.min(0.98, Math.max(0.1, 0.4 + rand() * 0.55)),
    });
  });

  const answers = new Map<string, unknown>();
  const gradings = new Map<string, MockGrading[]>();

  attempts.forEach((attempt, attemptIndex) => {
    items.forEach((item, itemIndex) => {
      const q = questions.find((x) => x.id === item.questionId)!;
      const config = publishedConfig(q);
      const key = cellKey(attempt.id, item.id);
      // Two students in thirty left this question untouched.
      const blank = rand() < 0.06;
      const answer = blank ? null : mockAnswer(q, config, attempt.ability);
      const answerId = blank ? null : `${key}-ans`;
      if (!blank) answers.set(key, answer);

      let points: number;
      let details: unknown;
      let source: MockGrading["source"] = "auto";
      let state: MockGrading["state"] = "validated";
      let confidence: MockGrading["confidence"] = null;
      let comment: string | null = null;

      if (blank) {
        points = 0;
        details = null;
      } else if (q.type === "code") {
        const built = mockCodeDetails(config, attempt.ability);
        points = halfPoints(built.fraction * item.points);
        details = built.details;
      } else if (q.type === "circuit") {
        // A circuit is graded on the ITEM's points, not on its stimuli's, so
        // the fraction is what travels — as it does for every other type.
        const built = mockCircuitDetails(
          studentView(q, config) as CircuitStudent,
          (config.stimuli ?? []) as CircuitStimulusLike[],
          (answer as { schematic?: MockSchematic } | null)?.schematic ?? EMPTY_SCHEMATIC,
        );
        points = halfPoints(built.fraction * item.points);
        details = built.details;
      } else {
        const graded = tryAnswer(q, config, answer, evaluation.mcqPolicy) as {
          points: number;
          details: unknown;
        };
        points = halfPoints(graded.points * item.points);
        details = graded.details;
      }

      // `code` needs the teacher's eyes in the MVP (the stub runner cannot
      // settle it on its own), and every fourth answer of the two longest
      // questions is still a proposal waiting to be validated.
      if (!options.allValidated && !blank) {
        const proposeRate = q.type === "code" ? 0.55 : itemIndex >= items.length - 2 ? 0.3 : 0.08;
        if (rand() < proposeRate) {
          state = "proposed";
          confidence = pick(["high", "high", "medium", "low"]);
          if (q.type === "code") comment = "runner_unavailable";
        }
      }

      // One cell in twenty carries the teacher's own grading, with the
      // comment F-GRADE-05 makes mandatory and the grading it replaced.
      const history: MockGrading[] = [];
      const id0 = `g${(gradingSeq += 1)}`;
      const base: MockGrading = {
        id: id0,
        answerId,
        attemptId: attempt.id,
        itemId: item.id,
        points,
        maxPoints: item.points,
        source,
        state,
        details,
        confidence,
        comment,
        gradedBy: null,
        gradedAt: iso(-2 * H + attemptIndex * 1000),
        supersedesId: null,
        regradeNote: null,
      };

      if (!blank && rand() < 0.05) {
        const bumped = Math.min(item.points, Math.round((points + 1) * 100) / 100);
        history.push({ ...base, state: "superseded" });
        history.push({
          ...base,
          id: `g${(gradingSeq += 1)}`,
          points: bumped,
          source: "manual",
          state: "validated",
          confidence: null,
          comment: "Le raisonnement est juste, la notation attendue était trop stricte.",
          gradedBy: "u-me",
          gradedAt: iso(-30 * 60_000 + attemptIndex * 1000),
          supersedesId: id0,
        });
      } else {
        history.push(base);
      }

      // Runner-pending: no standing grading at all, so the panel shows the
      // cell as still waiting (the `pending` verdict).
      if (!options.allValidated && q.type === "code" && rand() < 0.1) {
        gradings.set(key, []);
        return;
      }
      gradings.set(key, history);
    });
  });

  return { evaluation, items, attempts, answers, gradings };
}

/**
 * The two graded evaluations, keyed on the very evaluations of section 3 that
 * the classroom list shows as `closed` and `released` — there is ONE set of
 * evaluations in this mock, and this is the second half of two of them.
 */
const gradingWorlds: MockGradingWorld[] = [];
{
  const closed = evaluations.find((e) => e.state === "closed");
  const released = evaluations.find((e) => e.state === "released");
  if (closed)
    gradingWorlds.push(
      buildGradingWorld(closed, { allValidated: false, pinnedAttemptId: STUDENT_ATTEMPT }),
    );
  if (released)
    gradingWorlds.push(
      buildGradingWorld(released, { allValidated: true, pinnedAttemptId: STUDENT_PAST_ATTEMPT }),
    );
}

/** Resolves an id OR a state alias (section 3), then its grading world. */
const gradingWorldOr404 = (key: string): MockGradingWorld => {
  const evaluation = evaluationOr404(key);
  const world = gradingWorlds.find((w) => w.evaluation.id === evaluation.id);
  if (!world) throw new MockError(404, "Evaluation not graded");
  return world;
};

/** The grading that counts, or `null` while the pass has not settled the cell. */
function standingGrading(e: MockGradingWorld, attemptId: string, itemId: string): MockGrading | null {
  const chain = e.gradings.get(cellKey(attemptId, itemId)) ?? [];
  return chain.find((g) => g.state !== "superseded") ?? null;
}

const gradedTotalPointsOf = (e: MockGradingWorld) => e.items.reduce((s, i) => s + i.points, 0);

function gradeOf(points: number, total: number): number {
  return total <= 0 ? 1 : Math.min(6, Math.max(1, Math.round((1 + (5 * points) / total) * 10) / 10));
}

function attemptPoints(e: MockGradingWorld, attemptId: string): { points: number; perItem: Record<string, number> } {
  const perItem: Record<string, number> = {};
  let points = 0;
  for (const item of e.items) {
    const g = standingGrading(e, attemptId, item.id);
    if (g && g.state === "validated") {
      perItem[item.id] = g.points;
      points += g.points;
    }
  }
  return { points: Math.round(points * 100) / 100, perItem };
}

function gradingEntry(e: MockGradingWorld, attempt: MockAttempt, item: MockEvalItem, anonymous: boolean) {
  const q = questions.find((x) => x.id === item.questionId)!;
  const config = publishedConfig(q);
  const key = cellKey(attempt.id, item.id);
  const answer = e.answers.get(key) ?? null;
  const grading = standingGrading(e, attempt.id, item.id);
  const chain = e.gradings.get(key) ?? [];
  const solution =
    q.type === "code"
      ? mockCodeDetails(config, 1).solution
      : (tryAnswer(q, config, answer, e.evaluation.mcqPolicy) as { solution?: unknown }).solution ??
        null;
  return {
    answerId: answer === null ? null : `${key}-ans`,
    attemptId: attempt.id,
    itemId: item.id,
    label: anonymous ? attempt.pseudonym : attempt.displayName,
    staff: attempt.staff,
    answer,
    student: studentView(q, config),
    solution,
    grading,
    history: [...chain]
      .reverse()
      .map((g) => ({
        id: g.id,
        points: g.points,
        maxPoints: g.maxPoints,
        source: g.source,
        state: g.state,
        gradedAt: g.gradedAt,
        comment: g.comment,
        regradeNote: g.regradeNote,
      })),
  };
}

on("GET", "/app/api/evaluations/:id/grading", (m, _body, url) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const by = url.searchParams.get("by") === "student" ? "student" : "question";
  const itemId = url.searchParams.get("itemId");
  const attemptId = url.searchParams.get("attemptId");
  const state = url.searchParams.get("state");
  const anonymous = url.searchParams.get("anonymous") !== "0";
  const items = itemId ? e.items.filter((i) => i.id === itemId) : e.items;
  const attempts = attemptId ? e.attempts.filter((a) => a.id === attemptId) : e.attempts;
  const pairs =
    by === "student"
      ? attempts.flatMap((a) => items.map((i) => ({ a, i })))
      : items.flatMap((i) => attempts.map((a) => ({ a, i })));

  const entries = pairs
    .map(({ a, i }) => gradingEntry(e, a, i, anonymous))
    .filter((entry) => !state || entry.grading?.state === state);

  let validated = 0;
  let proposed = 0;
  for (const { a, i } of pairs) {
    const g = standingGrading(e, a.id, i.id);
    if (g?.state === "validated") validated += 1;
    else if (g?.state === "proposed") proposed += 1;
  }
  return {
    order: by,
    items: items.map((i) => ({
      id: i.id,
      position: i.position,
      internalName: i.internalName,
      type: i.type,
      points: i.points,
    })),
    entries,
    counts: {
      total: pairs.length,
      validated,
      proposed,
      missing: pairs.length - validated - proposed,
    },
  };
});

/** The path of a traversal with each step's state (#107): three counters per step. */
on("GET", "/app/api/evaluations/:id/grading/steps", (m, _body, url) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const by = url.searchParams.get("by") === "student" ? "student" : "question";
  const anonymous = url.searchParams.get("anonymous") !== "0";
  const tally = (cells: { a: MockAttempt; i: MockEvalItem }[]) => {
    let validated = 0;
    let proposed = 0;
    for (const { a, i } of cells) {
      const g = standingGrading(e, a.id, i.id);
      if (g?.state === "validated") validated += 1;
      else if (g?.state === "proposed") proposed += 1;
    }
    return { total: cells.length, validated, proposed };
  };
  return {
    order: by,
    steps:
      by === "question"
        ? e.items.map((i) => ({
            key: i.id,
            label: i.internalName,
            staff: false,
            ...tally(e.attempts.map((a) => ({ a, i }))),
          }))
        : e.attempts.map((a) => ({
            key: a.id,
            label: anonymous ? a.pseudonym : a.displayName,
            staff: a.staff,
            ...tally(e.items.map((i) => ({ a, i }))),
          })),
  };
});

on("GET", "/app/api/evaluations/:id/grading/progress", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const total = e.attempts.length * e.items.length;
  let done = 0;
  for (const a of e.attempts) {
    for (const i of e.items) if (standingGrading(e, a.id, i.id)) done += 1;
  }
  return { done, total, pending: { runner: total - done, llm: 0 }, failed: 0 };
});

on("POST", "/app/api/evaluations/:id/grading/run", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  // The pass settles every cell it left pending, exactly as the real one does.
  for (const a of e.attempts) {
    for (const i of e.items) {
      const key = cellKey(a.id, i.id);
      if ((e.gradings.get(key) ?? []).length > 0) continue;
      const q = questions.find((x) => x.id === i.questionId)!;
      const built = mockCodeDetails(publishedConfig(q), a.ability);
      e.gradings.set(key, [
        {
          id: `g${(gradingSeq += 1)}`,
          answerId: `${key}-ans`,
          attemptId: a.id,
          itemId: i.id,
          points: halfPoints(built.fraction * i.points),
          maxPoints: i.points,
          source: "auto",
          state: "proposed",
          details: built.details,
          confidence: "medium",
          comment: null,
          gradedBy: null,
          gradedAt: iso(0),
          supersedesId: null,
          regradeNote: null,
        },
      ]);
    }
  }
  return { evaluationId: e.evaluation.id, itemIds: e.items.map((i) => i.id), queued: false };
});

function validateChain(e: MockGradingWorld, g: MockGrading) {
  g.state = "validated";
  e.evaluation.modifiedAfterRelease = e.evaluation.releasedAt !== null ? true : e.evaluation.modifiedAfterRelease;
  return g;
}

on("POST", "/app/api/gradings/:id/validate", (m) => {
  for (const e of gradingWorlds) {
    for (const chain of e.gradings.values()) {
      const g = chain.find((x) => x.id === m.groups!.id);
      if (g) return validateChain(e, g);
    }
  }
  throw new MockError(404, "Grading not found");
});

function overrideCell(e: MockGradingWorld, g: MockGrading, body: Record<string, unknown>) {
  const chain = e.gradings.get(cellKey(g.attemptId, g.itemId))!;
  g.state = "superseded";
  const next: MockGrading = {
    ...g,
    id: `g${(gradingSeq += 1)}`,
    points: Number(body.points ?? 0),
    source: "manual",
    state: "validated",
    confidence: null,
    comment: String(body.comment ?? ""),
    gradedBy: "u-me",
    gradedAt: iso(0),
    supersedesId: g.id,
  };
  chain.push(next);
  if (e.evaluation.releasedAt !== null) e.evaluation.modifiedAfterRelease = true;
  return next;
}

on("POST", "/app/api/gradings/:id/override", (m, body) => {
  for (const e of gradingWorlds) {
    for (const chain of e.gradings.values()) {
      const g = chain.find((x) => x.id === m.groups!.id && x.state !== "superseded");
      if (g) return overrideCell(e, g, body);
    }
  }
  throw new MockError(404, "Grading not found");
});

on("POST", "/app/api/answers/:answerId/gradings", (m, body) => {
  const key = String(m.groups!.answerId).replace(/-ans$/, "");
  for (const e of gradingWorlds) {
    const chain = e.gradings.get(key);
    const g = chain?.find((x) => x.state !== "superseded");
    if (g) return overrideCell(e, g, body);
  }
  throw new MockError(404, "Answer not found");
});

on("POST", "/app/api/evaluations/:id/grading/validate-batch", (m, body) => {
  const e = gradingWorldOr404(m.groups!.id!);
  let validated = 0;
  for (const [key, chain] of e.gradings) {
    const g = chain.find((x) => x.state === "proposed");
    if (!g) continue;
    if (body.itemId && !key.endsWith(`:${String(body.itemId)}`)) continue;
    if (body.source && g.source !== body.source) continue;
    if (body.confidence && g.confidence !== body.confidence) continue;
    validateChain(e, g);
    validated += 1;
  }
  return { validated };
});

/** The versions the regrade sheet offers, newest first, and the frozen one. */
on("GET", "/app/api/evaluations/:id/items/:itemId/versions", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const item = e.evaluation.items.find((i) => i.id === m.groups!.itemId);
  const question = item ? questions.find((q) => q.id === item.questionId) : undefined;
  if (!item || !question) throw new MockError(404, "Item not found");
  return {
    frozenNumber: item.versionNumber,
    versions: question.versions.map(versionRow).reverse(),
  };
});

on("POST", "/app/api/evaluations/:id/items/:itemId/regrade", (m, body) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const itemId = String(m.groups!.itemId);
  const target = Number(body.toVersionNumber);
  const frozen = e.evaluation.items.find((i) => i.id === itemId);
  if (frozen && Number.isInteger(target) && target > 0) frozen.versionNumber = target;
  const note = String(body.note ?? "");
  for (const [key, chain] of e.gradings) {
    if (!key.endsWith(`:${itemId}`)) continue;
    const standing = chain.find((x) => x.state !== "superseded");
    if (!standing) continue;
    standing.state = "superseded";
    chain.push({
      ...standing,
      id: `g${(gradingSeq += 1)}`,
      source: "auto",
      state: "proposed",
      confidence: "medium",
      comment: null,
      gradedBy: null,
      gradedAt: iso(0),
      supersedesId: standing.id,
      regradeNote: note,
    });
  }
  if (e.evaluation.releasedAt !== null) e.evaluation.modifiedAfterRelease = true;
  return { evaluationId: e.evaluation.id, itemIds: [itemId], queued: false };
});

function resultsView(e: MockGradingWorld) {
  const total = gradedTotalPointsOf(e);
  const rows = e.attempts.map((a) => {
    const { points, perItem } = attemptPoints(e, a.id);
    return {
      userId: a.userId,
      displayName: a.displayName,
      lastName: a.lastName,
      firstName: a.firstName,
      email: a.email,
      attemptId: a.id,
      perItem,
      points,
      grade: gradeOf(points, total),
      durationS: a.durationS,
      state: a.state,
      staff: a.staff,
    };
  });
  // The students who never opened it: a 1.0 that belongs in the table and in
  // the statistics (deviation W6-10). They are the dashboard rows without an
  // attempt, so the absent count of the results matches the live grid's.
  e.evaluation.rows.forEach((row) => {
    if (row.attemptId !== null) return;
    rows.push({
      userId: row.userId,
      displayName: row.displayName,
      lastName: row.lastName,
      firstName: row.firstName,
      email: row.email,
      attemptId: null as unknown as string,
      perItem: {},
      points: 0,
      grade: 1,
      durationS: null as unknown as number,
      state: "absent" as MockAttempt["state"],
      staff: row.staff,
    });
  });
  // The class, and only the class: a teacher's own test is a row of the
  // table and of nothing else (ADR-018).
  const grades = rows.filter((r) => !r.staff).map((r) => r.grade);
  const stats = describe(grades);
  return {
    evaluationId: e.evaluation.id,
    title: e.evaluation.title,
    totalPoints: total,
    scale: { kind: "linear", rounding: "nearest" },
    released: e.evaluation.releasedAt !== null,
    releasedAt: e.evaluation.releasedAt,
    modifiedAfterRelease: e.evaluation.modifiedAfterRelease,
    items: e.items.map((i) => {
      const scores = e.attempts
        .filter((a) => !a.staff)
        .map((a) => standingGrading(e, a.id, i.id))
        .filter((g): g is MockGrading => g !== null && g.state === "validated");
      return {
        id: i.id,
        position: i.position,
        internalName: i.internalName,
        type: i.type,
        points: i.points,
        successRate:
          scores.length === 0
            ? null
            : round2(scores.reduce((s, g) => s + g.points / g.maxPoints, 0) / scores.length),
      };
    }),
    rows,
    stats: { ...stats, histogram: histogram(grades) },
  };
}

on("GET", "/app/api/evaluations/:id/results", (m) => resultsView(gradingWorldOr404(m.groups!.id!)));

on("GET", "/app/api/evaluations/:id/results/by-question", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const view = resultsView(e);
  return e.items.map((item, index) => {
    const q = questions.find((x) => x.id === item.questionId)!;
    const config = publishedConfig(q);
    const given = e.attempts
      .filter((a) => !a.staff)
      .map((a) => e.answers.get(cellKey(a.id, item.id)))
      .filter((x) => x !== undefined);
    let distribution: { key: string; label: string; count: number; correct: boolean | null }[] = [];
    if (q.type === "mcq") {
      const choices = (config.choices ?? []) as { text: string; correct: boolean }[];
      distribution = choices.map((choice, id) => ({
        key: String(id),
        label: choice.text,
        count: given.filter((ans) => ((ans as { selected?: number[] }).selected ?? []).includes(id)).length,
        correct: choice.correct,
      }));
    } else if (q.type === "short" || q.type === "cloze") {
      const counts = new Map<string, number>();
      for (const ans of given) {
        const text =
          q.type === "short"
            ? String((ans as { text?: string }).text ?? "")
            : ((ans as { blanks?: string[] }).blanks ?? []).join(" · ");
        counts.set(text, (counts.get(text) ?? 0) + 1);
      }
      distribution = [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([text, count]) => ({ key: text, label: text || "—", count, correct: null }));
    }
    const cases = ((config.tests as { cases?: CodeCaseLike[] })?.cases ?? []) as CodeCaseLike[];
    return {
      item: view.items[index]!,
      student: studentView(q, config),
      solution:
        q.type === "code"
          ? mockCodeDetails(config, 1).solution
          : (tryAnswer(q, config, null) as { solution?: unknown }).solution ?? null,
      explanation: q.versions.at(-1)?.explanation || null,
      answered: given.length,
      distribution,
      casePassRate:
        q.type === "code"
          ? cases.map((c) => ({
              name: c.name,
              passed: Math.round(e.attempts.length * (0.4 + rand() * 0.5)),
              total: e.attempts.length,
            }))
          : [],
      successRate: view.items[index]!.successRate,
      avgMs: null,
    };
  });
});

on("POST", "/app/api/evaluations/:id/release", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  e.evaluation.releasedAt = iso(0);
  // Publishing moves the evaluation itself, so the classroom list, the
  // configuration header and the student's home all agree one call later.
  e.evaluation.state = "released";
  e.evaluation.modifiedAfterRelease = false;
  return {
    releasedAt: e.evaluation.releasedAt,
    rows: e.attempts.filter((a) => !a.staff).length,
    released: true,
  };
});

on("POST", "/app/api/evaluations/:id/unrelease", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  e.evaluation.releasedAt = null;
  e.evaluation.state = "closed";
  e.evaluation.modifiedAfterRelease = false;
  return { releasedAt: null, rows: 0, released: false };
});

on("GET", "/app/api/attempts/:id/feedback", (m) => {
  const attemptId = String(m.groups!.id);
  const e = gradingWorlds.find((x) => x.attempts.some((a) => a.id === attemptId));
  if (!e) throw new MockError(404, "Attempt not found");
  const attempt = e.attempts.find((a) => a.id === attemptId)!;
  if (e.evaluation.releasedAt === null) {
    return {
      available: false,
      reason: "results_pending",
      evaluation: { id: e.evaluation.id, title: e.evaluation.title },
    };
  }
  const { points } = attemptPoints(e, attempt.id);
  const total = gradedTotalPointsOf(e);
  return {
    available: true,
    evaluation: { id: e.evaluation.id, title: e.evaluation.title, releasedAt: e.evaluation.releasedAt },
    attemptId: attempt.id,
    points,
    totalPoints: total,
    grade: gradeOf(points, total),
    items: e.items.map((item) => {
      const q = questions.find((x) => x.id === item.questionId)!;
      const config = publishedConfig(q);
      const key = cellKey(attempt.id, item.id);
      const answer = e.answers.get(key) ?? null;
      const grading = standingGrading(e, attempt.id, item.id);
      const solution =
        q.type === "code"
          ? mockCodeDetails(config, 1).solution
          : (tryAnswer(q, config, answer, e.evaluation.mcqPolicy) as { solution?: unknown }).solution ?? null;
      return {
        itemId: item.id,
        position: item.position,
        type: item.type,
        points: grading ? grading.points : null,
        maxPoints: item.points,
        verdict: grading
          ? grading.points >= item.points
            ? "correct"
            : grading.points > 0
              ? "partial"
              : "wrong"
          : null,
        student: studentView(q, config),
        answer,
        solution,
        explanation: q.versions.at(-1)?.explanation || null,
        details: grading?.details ?? null,
        comment: grading?.comment ?? null,
      };
    }),
  };
});


/*
 * A route of section 3, registered here because it is the one evaluation
 * route that also touches a GRADING WORLD, which is built on top of the
 * evaluations rather than beside them.
 */
/**
 * ADR-018: the teacher throws away their OWN staff test attempt. The mock
 * holds the same three conditions the server loads — a seat, a STAFF seat,
 * and their own row — so the button disappears here for the same reasons.
 */
on("DELETE", "/app/api/evaluations/:id/attempt", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  const mine = e.rows.find((r) => r.staff && r.userId === ME_TEACHER.userId);
  if (!mine) return { deleted: false };
  e.rows = e.rows.filter((r) => r !== mine);
  // The grading world is derived from the rows, so its copy goes too.
  const world = gradingWorlds.find((w) => w.evaluation.id === e.id);
  if (world) world.attempts = world.attempts.filter((a) => a.id !== mine.attemptId);
  return { deleted: true };
});
