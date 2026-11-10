/** Section 5 of the mock — see `index.ts` for the layout. */
import {
  acceptanceReach,
  acceptanceScopes,
  attemptTotal,
  clozePart,
  debrief,
  describe,
  inStatistics,
  evaluationTotal,
  histogram,
  correctionPublishRefusal,
  effectiveFeedbackPolicy,
  feedbackGradeShown,
  isBatchable,
  isDebriefOpen,
  itemPoints,
  negativeMarkingOn,
  parseCloze,
  round2,
  scaleCriteria,
  scoresNegatively,
  rulesForAttempt,
  validatedBreakdown,
  type AcceptanceRule,
  type AttemptTally,
  type DeclaredCriterion,
} from "@quiz/domain";
import { AI_KEY, aiOf, BREAKDOWN_KEY, FeedbackPolicy, JUSTIFICATION_KEY, TEACHER_ONLY_DETAIL_KEYS } from "@quiz/contracts";
import type { GradingConfidence, GradingSource, GradingState, ItemCounting } from "@quiz/contracts";
import type { AnyQuestionTypeServer, ItemAggregate, StudentDetailsPolicy } from "@quiz/core/server";
import { blocksServer } from "@quiz/qt-blocks/server";
import { categorizeServer } from "@quiz/qt-categorize/server";
import { clozeServer } from "@quiz/qt-cloze/server";
import { mcqServer } from "@quiz/qt-mcq/server";
import { richServer } from "@quiz/qt-rich/server";
import { shortServer } from "@quiz/qt-short/server";
import type {
  CircuitStudent,
} from "@quiz/qt-circuit/client";
import {
  H,
  MockError,
  MockPayload,
  flags,
  iso,
  on,
  pick,
  rand,
  refuse,
} from "./runtime";
import {
  MockEvaluation,
  RICH_LONG_ANSWER,
  RICH_SHORT_ANSWER,
  evaluationOr404,
  evaluations,
} from "./evaluation";
import {
  ME_TEACHER,
} from "./org";
import {
  IMAGE_REFERENCE,
  IMAGE_STUDENT_ATTEMPT,
  codeimageTryDetails,
  studentAttemptPixels,
} from "./codeimage";
import {
  BLOCKS_ANSWER,
  CATEGORIZE_BIG_MISS,
  CATEGORIZE_BIG_RIGHT,
  LOGIC_ANSWER,
  LOGIC_PARTIAL_ANSWER,
  BLOCKS_STRAIGHT_ANSWER,
  CATEGORIZE_ANSWER,
  CircuitStimulusLike,
  DIAGRAM_ANSWER,
  CodeCaseLike,
  EMPTY_SCHEMATIC,
  MockQuestion,
  MockSchematic,
  RC_REFERENCE,
  RC_STUDENT,
  mockCircuitDetails,
  fillText,
  fillVariables,
  questions,
  solutionOf,
  studentSolutionOf,
  studentView,
  tryAnswer,
  versionRow,
  NO_RUNNER,
} from "./pool";
import {
  STUDENT_ATTEMPT,
  STUDENT_EARLY_ATTEMPT,
  STUDENT_EVAL_RETAKE,
  STUDENT_PAST_ATTEMPT,
  STUDENT_PRACTICE_A,
  STUDENT_PRACTICE_ATTEMPT,
  STUDENT_RETAKE_ATTEMPT,
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
  /** ADR-052, ADR-108. */
  counting: ItemCounting;
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
  source: GradingSource;
  state: GradingState;
  details: unknown;
  confidence: GradingConfidence | null;
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
  /** Item id -> the answers accepted at grading time (ADR-128). */
  acceptances: Map<string, AcceptanceRule[]>;
}

const cellKey = (attemptId: string, itemId: string) => `${attemptId}:${itemId}`;

/**
 * The server halves the mock runs for real: in the debrief (ADR-033), their
 * `isAnswered` and their per-attempt `aggregate`; in grading, an essay's
 * `gradingCriteria` as the API reads it (ADR-118 §6). `code` is not one —
 * its server half holds the grader, which needs Node — so its case tally is
 * summed from the mock details below.
 */
const MOCK_SERVERS: Record<string, AnyQuestionTypeServer | undefined> = {
  mcq: mcqServer,
  short: shortServer,
  cloze: clozeServer,
  categorize: categorizeServer,
  blocks: blocksServer,
  rich: richServer,
};

/** A question's criteria, from its type's hook on the published config; none without one. */
function criteriaOfQuestion(q: MockQuestion | undefined): DeclaredCriterion[] {
  const hook = q ? MOCK_SERVERS[q.type]?.gradingCriteria : undefined;
  return hook ? [...hook(publishedConfig(q!))] : [];
}

function criteriaOfItem(e: MockGradingWorld, itemId: string): DeclaredCriterion[] {
  const item = e.items.find((i) => i.id === itemId);
  return criteriaOfQuestion(item ? questions.find((q) => q.id === item.questionId) : undefined);
}

/** The model's sentence per criterion, by how much of it the answer earned. */
const ESSAY_SENTENCES = [
  "Not addressed.",
  "Mentioned, not explained.",
  "Explained in part.",
  "Fully explained.",
];

/**
 * What the AI proposes for an essay with criteria, as `askGrader` writes it
 * (ADR-118): each criterion scored in its weight units by the student's
 * ability, scaled to the item's points, keyed by the criterion's id.
 */
function essayProposal(criteria: DeclaredCriterion[], itemPoints: number, ability: number, chars: number) {
  const earned = criteria.map((c, i) => {
    // A little spread between criteria, so the rows do not all read alike.
    const share = Math.min(1, Math.max(0, ability + (i % 2 === 0 ? 0.1 : -0.15)));
    return Math.round(c.weight * share * 4) / 4;
  });
  const scaled = scaleCriteria(
    criteria.map((c, i) => ({ weight: c.weight, earned: earned[i]! })),
    itemPoints,
  );
  const ai = {
    model: "claude-sonnet-5-5",
    criteria: criteria.map((c, i) => ({
      id: c.id,
      criterion: c.title,
      ...scaled.criteria[i]!,
      comment: ESSAY_SENTENCES[Math.min(3, Math.round((earned[i]! / c.weight) * 3))]!,
    })),
  };
  return {
    points: scaled.total,
    details: {
      reason: "llm",
      chars,
      [JUSTIFICATION_KEY]: "The answer names the mechanism; the signal is only implied.",
      [AI_KEY]: ai,
    } as Record<string, unknown>,
  };
}

/**
 * The validated breakdown a validation writes (ADR-118 §6): the teacher's
 * points per criterion, else the proposal's when it names every criterion.
 * `null` when nothing matches, as the API never writes a partial one.
 */
function breakdownFor(
  criteria: DeclaredCriterion[],
  itemPoints: number,
  details: unknown,
  given?: { id: string; points: number }[],
) {
  const scored = given ?? aiOf(details)?.criteria.map((c) => ({ id: c.id ?? "", points: c.points })) ?? [];
  return validatedBreakdown(criteria, itemPoints, scored);
}

// --- A parameterized question (ADR-056 §9) ---------------------------------
//
// The pool's falling ball (`q-fall`, src/mock/pool.ts), appended to the
// `closed` evaluation so the grading table, its panel and the class debrief
// show a parameterized question. The mock has no evaluator (mathjs stays on
// the server): each attempt's `h` and `g` come from a hash of its id — never
// from `rand()`, so the rest of the mock world draws exactly what it drew
// before — `t` is computed from them, and the template is filled by the
// pool's own `fillVariables`.

const FALL: MockQuestion | undefined = questions.find((q) => q.id === "q-fall");

const isFall = (q: { id: string }) => q.id === "q-fall";

/*
 * The blocks question (`q-blocks`, docs/04 §4.17), appended to the `closed`
 * evaluation after the falling ball for the same reason: its answers come
 * from each attempt's `ability`, never from `rand()`, so nothing else the
 * mock draws moves, and no scene's question index either.
 */
const BLOCKS: MockQuestion | undefined = questions.find((q) => q.id === "q-blocks");
/* The logic question (`q-logic`, docs/04 §4.18), appended after it the same way. */
const LOGIC: MockQuestion | undefined = questions.find((q) => q.id === "q-logic");
/*
 * A cloze (`malloc-tableau`), appended last the same way, so the grading
 * table shows an answer accepted at grading time (ADR-128).
 */
const CLOZE: MockQuestion | undefined = questions.find((q) => q.type === "cloze" && q.internalName === "malloc-tableau");
/* A categorize past eight cards (`q-sort-big`), appended last: a summary column, accepted from the panel (ADR-128). */
const SORT_BIG: MockQuestion | undefined = questions.find((q) => q.id === "q-sort-big");

/**
 * A cloze answer from an attempt's ability alone: the able half fill every
 * blank right; the others take the option after the key in each dropdown —
 * the one `seededAcceptances` accepts — and miss every other text blank.
 */
function clozeAppendedAnswer(q: MockQuestion, ability: number): unknown {
  const good = ability >= 0.6;
  return {
    blanks: parseCloze(String(publishedConfig(q).text ?? "")).blanks.map((blank) => {
      if (blank.kind === "select") {
        const key = blank.correct[0] ?? 0;
        return String(good ? key : (key + 1) % Math.max(1, blank.options.length));
      }
      if (blank.kind === "text") return good || blank.index % 2 === 0 ? (blank.answers[0] ?? "") : "delete";
      return null;
    }),
  };
}

/**
 * A question appended to the `closed` evaluation, graded in a pass of its own
 * that draws nothing from `rand()`: what differs is its item id's suffix, its
 * points, each attempt's answer (`null`: blank) and whether a grading is left
 * to validate.
 */
interface Appended {
  question: MockQuestion;
  suffix: string;
  points: number;
  answer: (attempt: MockAttempt, attemptIndex: number, key: string) => unknown;
  proposed: (key: string) => boolean;
}

const APPENDED: Appended[] = [
  ...(FALL
    ? [
        {
          question: FALL,
          suffix: "00000000fa11",
          points: 2,
          // One student left it blank; the others answered from their own values.
          answer: (attempt: MockAttempt, attemptIndex: number, key: string) =>
            attemptIndex === 2 ? null : { text: fallAnswer(fallValues(attempt.id), attempt.ability, fallHash(key)) },
          // A few left to validate while the evaluation is being graded.
          proposed: (key: string) => fallHash(key) % 5 === 0,
        },
      ]
    : []),
  ...(BLOCKS
    ? [
        {
          question: BLOCKS,
          suffix: "0000000b10c5",
          points: 3,
          // One student left it blank; the able half read the sensors, the rest counted cells.
          answer: (attempt: MockAttempt, attemptIndex: number) =>
            attemptIndex === 3 ? null : attempt.ability >= 0.6 ? BLOCKS_ANSWER : BLOCKS_STRAIGHT_ANSWER,
          // Validated at once: the run is the grade (ADR-103 §2).
          proposed: () => false,
        },
      ]
    : []),
  ...(LOGIC
    ? [
        {
          question: LOGIC,
          suffix: "0000000a1061",
          points: 2,
          // The able half wired the whole majority, the rest forgot the third AND.
          answer: (attempt: MockAttempt) => (attempt.ability >= 0.6 ? LOGIC_ANSWER : LOGIC_PARTIAL_ANSWER),
          // Validated at once: the simulation is the grade (ADR-123 §6).
          proposed: () => false,
        },
      ]
    : []),
  ...(CLOZE
    ? [
        {
          question: CLOZE,
          suffix: "00000000c10e",
          points: 3,
          answer: (attempt: MockAttempt, attemptIndex: number) =>
            attemptIndex === 4 ? null : clozeAppendedAnswer(CLOZE, attempt.ability),
          proposed: () => false,
        },
      ]
    : []),
  ...(SORT_BIG
    ? [
        {
          question: SORT_BIG,
          suffix: "00000000b169",
          points: 2,
          answer: (attempt: MockAttempt) => (attempt.ability >= 0.6 ? CATEGORIZE_BIG_RIGHT : CATEGORIZE_BIG_MISS),
          proposed: () => false,
        },
      ]
    : []),
];
const isAppended = (q: { id: string }) => APPENDED.some((a) => a.question.id === q.id);

interface FallValues {
  h: number;
  g: number;
  t: number;
}

/** FNV-1a, for a stable draw per attempt that consumes nothing of `rand()`. */
function fallHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const round2Fall = (x: number) => Math.round(x * 100) / 100;

/** The values of an attempt (`null`: the example, seed 0), the condition `t > 1.5` held. */
function fallValues(attemptId: string | null): FallValues {
  if (attemptId === null) return { h: 42, g: 9.81, t: 2.93 };
  const n = fallHash(attemptId);
  const g = [3.71, 9.81, 24.79][n % 3]!;
  let h = 10 + ((n >>> 3) % 91);
  while (Math.sqrt((2 * h) / g) <= 1.5) h += 10;
  return { h, g, t: round2Fall(Math.sqrt((2 * h) / g)) };
}

/** The values as the grading queue sends them: in the table's order, each with its format. */
const fallNamed = (v: FallValues) => [
  { name: "h", value: String(v.h) },
  { name: "g", value: v.g.toFixed(2) },
  { name: "t", value: v.t.toFixed(2) },
];

const byNameOf = (v: FallValues) => Object.fromEntries(fallNamed(v).map((x) => [x.name, x.value]));

/** The config one attempt read (`null`: the example's), an instance for the parameterized question. */
function attemptConfig(q: MockQuestion, attemptId: string | null): Record<string, unknown> {
  return isFall(q) ? fillVariables(publishedConfig(q), byNameOf(fallValues(attemptId))) : publishedConfig(q);
}

/** The parameterized question's explanation, instantiated; null for any other. */
function fallExplanation(q: MockQuestion, attemptId: string | null): string | null {
  const template = q.versions.at(-1)?.explanation ?? "";
  return isFall(q) ? fillText(template, byNameOf(fallValues(attemptId))) : null;
}

/**
 * One attempt's answer to the parameterized question, from ITS values: the
 * right fall time, or a classic mistake (the factor 2 or the square root
 * forgotten) — so alike numbers are right for one student, wrong for another.
 */
function fallAnswer(v: FallValues, ability: number, n: number): string {
  if ((n % 100) / 100 < ability) return v.t.toFixed(2);
  return n % 2 === 0 ? round2Fall(Math.sqrt(v.h / v.g)).toFixed(2) : round2Fall((2 * v.h) / v.g).toFixed(2);
}

/** The published configuration of a mock question (its latest version). */
function publishedConfig(q: MockQuestion): Record<string, unknown> {
  return q.versions.at(-1)?.config ?? q.draft.config;
}

/**
 * ADR-128: the `closed` evaluation's first cloze arrives with one answer
 * accepted — the dropdown option every student who missed it chose
 * (`mockAnswer` picks the one after the key) — so the table shows the
 * seal, and the key's row the accepted answer. Drawn from nothing random.
 */
function seededAcceptances(items: MockEvalItem[], allValidated: boolean): Map<string, AcceptanceRule[]> {
  const out = new Map<string, AcceptanceRule[]>();
  if (allValidated) return out;
  for (const item of items) {
    const q = questions.find((x) => x.id === item.questionId);
    if (q?.type !== "cloze") continue;
    const blank = parseCloze(String(publishedConfig(q).text ?? "")).blanks.find((b) => b.kind === "select");
    if (blank?.kind !== "select") continue;
    const wrong = ((blank.correct[0] ?? 0) + 1) % Math.max(1, blank.options.length);
    out.set(item.id, [{ part: clozePart(blank.index), answer: String(wrong), attemptId: null }]);
    break;
  }
  // The categorize questions: `string` accepted among the pointers (the
  // closed evaluation's board, eight cards), and `atoi`, a distractor,
  // accepted in `stdlib.h` (the board past eight cards).
  for (const item of items) {
    const q = questions.find((x) => x.id === item.questionId);
    const rule = q ? CATEGORIZE_SEEDS[q.internalName] : undefined;
    if (rule) out.set(item.id, [rule]);
  }
  return out;
}

const CATEGORIZE_SEEDS: Record<string, AcceptanceRule> = {
  "types-c-classement": { part: "m5p2l6ak", answer: "r5j8g1h4", attemptId: null },
  "en-tetes-bibliotheque": { part: "atoi0001", answer: "hstdlib1", attemptId: null },
};

/** One answer through its type's own `grade`, with the acceptances in force (ADR-128). */
function gradeAccepted(
  q: MockQuestion,
  config: Record<string, unknown>,
  answer: unknown,
  item: MockEvalItem,
  attemptId: string,
  accepted: { part: string; answer: string }[],
  negativeMarking = false,
): { points: number; maxPoints: number; details: unknown } {
  const graded = MOCK_SERVERS[q.type]!.grade(config, answer, {
    seed: 0,
    itemId: item.id,
    attemptId,
    itemPoints: 1,
    now: new Date(),
    runner: NO_RUNNER,
    accepted,
    // As `tryAnswer` grades a categorize under the evaluation's negative marking.
    ...(negativeMarking ? { defaults: { categorize: { policy: "per_item", negativeMarking: true } } } : {}),
  }) as { points: number; maxPoints: number; details: unknown };
  return graded;
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
  if (q.type === "rich") {
    return { text: rand() < ability ? RICH_LONG_ANSWER : RICH_SHORT_ANSWER };
  }
  if (q.type === "categorize") {
    const key = (config.columns ?? []) as { id: string; cards: string[] }[];
    return rand() < ability ? { columns: Object.fromEntries(key.map((c) => [c.id, c.cards])) } : CATEGORIZE_ANSWER;
  }
  if (q.type === "codeimage") {
    return { regions: [rand() < ability ? IMAGE_REFERENCE : IMAGE_STUDENT_ATTEMPT] };
  }
  if (q.type === "diagram") {
    return rand() < ability ? { scene: config.reference } : DIAGRAM_ANSWER;
  }
  // Short programs and long ones, so the table's box shows its five-line
  // clamp on some rows and not on others.
  const good = rand() < ability;
  return {
    regions: [pick(good ? CODE_GOOD : CODE_BAD)],
    lastRun: null,
  };
}

const CODE_GOOD = [
  "    int s = 0;\n    for (const int *p = t; p < t + n; p++) s += *p;\n    return s;\n",
  "    /* parcours par pointeur, sans [] */\n    int s = 0;\n    const int *fin = t + n;\n" +
    "    for (const int *p = t; p < fin; p++) {\n        s += *p;\n    }\n    return s;\n",
];
const CODE_BAD = [
  "    int s = 0;\n    for (size_t i = 0; i <= n; i++) s += t[i];\n    return s;\n",
  "    int s = 0;\n    size_t i = 0;\n    while (i <= n) {\n        s = s + *(t + i);\n" +
    "        i++;\n    }\n    printf(\"%d\\n\", s);\n    return s;\n",
];

/** `code` never reaches a runner here, so its case-by-case detail is built. */
function mockCodeDetails(config: Record<string, unknown>, ability: number) {
  const cases = ((config.tests as { cases?: CodeCaseLike[] })?.cases ?? []) as CodeCaseLike[];
  const results = cases.map((c, i) => {
    const ok = rand() < ability;
    // The first case fails on a stray leading space — the difference only
    // the whitespace glyphs and the diff view show (#553); the others on a
    // plainly wrong value.
    const wrong = i === 0 ? ` ${c.expected}` : "0";
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
      actual: ok ? c.expected : wrong,
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
  options: {
    allValidated: boolean;
    pinnedAttemptId?: string;
    /** The rows whose attempts are graded; every row by default. */
    rows?: MockEvaluation["rows"];
  },
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
      counting: i.counting,
    }));

  // One attempt per dashboard row that has one. A row without an attempt is a
  // student who never opened it, and stays one: the results table lists them
  // as absent (deviation W6-10) instead of inventing a second class.
  const attempts: MockAttempt[] = [];
  (options.rows ?? evaluation.rows).forEach((row) => {
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
      state: row.state === "submitted" ? "submitted" : "expired",
      durationS: 600 + Math.round(rand() * 1500),
      // A class, not a cloud: a few who have it, a few who do not, most in
      // between. The histogram below is the point of the spread.
      ability: Math.min(0.98, Math.max(0.1, 0.4 + rand() * 0.55)),
    });
  });

  const answers = new Map<string, unknown>();
  const gradings = new Map<string, MockGrading[]>();
  const acceptances = seededAcceptances(items, options.allValidated);

  attempts.forEach((attempt, attemptIndex) => {
    items.forEach((item, itemIndex) => {
      const q = questions.find((x) => x.id === item.questionId)!;
      // Its own pass below: nothing of `rand()` is spent on it.
      if (isAppended(q)) return;
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
      } else if (q.type === "codeimage") {
        // The mock has no compiler: the picture is the one the program
        // above would print, drawn by the same function in TypeScript.
        const good = (answer as { regions: string[] }).regions[0] === IMAGE_REFERENCE;
        const built = codeimageTryDetails(config, good ? undefined : studentAttemptPixels);
        // The share of cells right, unrounded: a picture off by its middle
        // rings is partial credit, not a full mark rounded up.
        points = round2((built.matching / built.pixelCount) * item.points);
        details = built;
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
        const accepted = rulesForAttempt(acceptances.get(item.id) ?? [], { id: attempt.id, practice: false });
        const graded =
          accepted.length > 0
            ? gradeAccepted(q, config, answer, item, attempt.id, accepted, negativeOf(evaluation))
            : (tryAnswer(q, config, answer, evaluation.mcqPolicy, negativeOf(evaluation)) as {
                points: number;
                maxPoints: number;
                details: unknown;
              });
        // Each branch of the try grades on its own scale (an essay at the
        // sum of its weights, ADR-118): read as a fraction, then the item's.
        const fraction = graded.maxPoints > 0 ? graded.points / graded.maxPoints : 0;
        // Stored raw, as the server writes it (ADR-108).
        points = itemPoints(halfPoints(fraction * item.points));
        details = graded.details;
      }

      // An essay or a diagram is graded by hand (issue #192, ADR-046): the
      // type proposes 0, and only a teacher turns it into points — already
      // done once released.
      const byHand = q.type === "rich" || q.type === "diagram";
      // With criteria and an AI, an essay comes back as the model's proposal (ADR-118).
      const criteria = criteriaOfQuestion(q);
      if (criteria.length > 0 && !blank) {
        const text = (answer as { text?: string } | null)?.text ?? "";
        const proposal = essayProposal(criteria, item.points, attempt.ability, text.length);
        points = proposal.points;
        details = proposal.details;
        source = "llm";
        if (options.allValidated) {
          details = { ...proposal.details, [BREAKDOWN_KEY]: breakdownFor(criteria, item.points, details)?.breakdown };
        } else {
          state = "proposed";
          confidence = attempt.ability > 0.7 ? "high" : "medium";
        }
      } else if (byHand && !blank) {
        if (options.allValidated) {
          points = halfPoints(attempt.ability * item.points);
          source = "manual";
        } else {
          state = "proposed";
        }
      }

      // `code` needs the teacher's eyes in the MVP (the stub runner cannot
      // settle it on its own), and every fourth answer of the two longest
      // questions is still a proposal waiting to be validated.
      if (!options.allValidated && !blank && !byHand) {
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

      // An essay with criteria is overridden by them (ADR-118 §6): no bare bump.
      if (!blank && rand() < 0.05 && criteria.length === 0) {
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
      if (!options.allValidated && (q.type === "code" || q.type === "codeimage") && rand() < 0.1) {
        gradings.set(key, []);
        return;
      }
      gradings.set(key, history);
    });
  });

  for (const appended of APPENDED) {
    const q = appended.question;
    for (const item of items.filter((i) => i.questionId === q.id)) {
      for (const [attemptIndex, attempt] of attempts.entries()) {
        const key = cellKey(attempt.id, item.id);
        const answer = appended.answer(attempt, attemptIndex, key);
        if (answer !== null) answers.set(key, answer);
        const accepted = rulesForAttempt(acceptances.get(item.id) ?? [], { id: attempt.id, practice: false });
        const graded =
          answer === null
            ? { points: 0, details: null }
            : accepted.length > 0
              ? gradeAccepted(q, attemptConfig(q, attempt.id), answer, item, attempt.id, accepted, negativeOf(evaluation))
              : (tryAnswer(q, attemptConfig(q, attempt.id), answer) as { points: number; details: unknown });
        const proposed = !options.allValidated && graded.points > 0 && appended.proposed(key);
        gradings.set(key, [
          {
            id: `g${(gradingSeq += 1)}`,
            answerId: answer === null ? null : `${key}-ans`,
            attemptId: attempt.id,
            itemId: item.id,
            points: round2(graded.points * item.points),
            maxPoints: item.points,
            source: "auto",
            state: proposed ? "proposed" : "validated",
            details: graded.details,
            confidence: proposed ? "high" : null,
            comment: null,
            gradedBy: null,
            gradedAt: iso(-2 * H + attemptIndex * 1000),
            supersedesId: null,
            regradeNote: null,
          },
        ]);
      }
    }
  }

  return { evaluation, items, attempts, answers, gradings, acceptances };
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
  // The appended questions, the closed evaluation's last items, in order (`APPENDED`).
  for (const { question, suffix, points } of APPENDED) {
    if (!closed || closed.items.length === 0) break;
    closed.items.push({
      ...closed.items.at(-1)!,
      id: `iiiiiiii-0000-4000-8000-${suffix}`,
      position: closed.items.length,
      points,
      milestone: false,
      counting: "normal",
      questionId: question.id,
      questionVersionId: `vvvvvvvv-0000-4000-8000-${suffix}`,
      type: question.type,
      internalName: question.internalName,
      versionNumber: 1,
      latestVersionNumber: 1,
      deprecated: false,
    });
  }
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

/** The server's total: bonus and neutralized items left out (ADR-052, ADR-108). */
const gradedTotalPointsOf = (e: MockGradingWorld) => evaluationTotal(e.items);

function gradeOf(points: number, total: number): number {
  return total <= 0 ? 1 : Math.min(6, Math.max(1, Math.round((1 + (5 * points) / total) * 10) / 10));
}

function attemptPoints(e: MockGradingWorld, attemptId: string): { points: number; perItem: Record<string, number> } {
  const perItem: Record<string, number> = {};
  for (const item of e.items) {
    const g = standingGrading(e, attemptId, item.id);
    if (g && g.state === "validated") perItem[item.id] = g.points;
  }
  // The server's one total: each cell as it counts (ADR-108), floored at 0
  // under negative marking (ADR-026).
  const cells = e.items.flatMap((i) => (i.id in perItem ? [{ points: perItem[i.id]!, counting: i.counting }] : []));
  return { points: attemptTotal(cells), perItem };
}

/** ADR-026: the evaluation scores its choice questions negatively (never a poll). */
function negativeOf(evaluation: MockEvaluation): boolean {
  return negativeMarkingOn(
    evaluation.mode,
    (evaluation.settings as { negativeMarking?: boolean }).negativeMarking,
  );
}

function gradingEntry(e: MockGradingWorld, attempt: MockAttempt, item: MockEvalItem, anonymous: boolean) {
  const q = questions.find((x) => x.id === item.questionId)!;
  const config = attemptConfig(q, attempt.id);
  const key = cellKey(attempt.id, item.id);
  const answer = e.answers.get(key) ?? null;
  const grading = standingGrading(e, attempt.id, item.id);
  const chain = e.gradings.get(key) ?? [];
  const solution =
    q.type === "code"
      ? mockCodeDetails(config, 1).solution
      : (tryAnswer(q, config, answer, e.evaluation.mcqPolicy, negativeOf(e.evaluation)) as { solution?: unknown }).solution ??
        null;
  return {
    answerId: answer === null ? null : `${key}-ans`,
    attemptId: attempt.id,
    itemId: item.id,
    // Anonymous, no label at all (ADR-044); the names only on request.
    label: anonymous ? null : attempt.displayName,
    guest: null,
    staff: attempt.staff,
    // One attempt per student in this mock: no retake number, and it counts.
    attemptNumber: null,
    kept: true,
    answer,
    ...(isFall(q)
      ? { values: fallNamed(fallValues(attempt.id)), explanation: fallExplanation(q, attempt.id) }
      : {}),
    student: studentView(q, config),
    solution,
    grading,
    ...(MOCK_SERVERS[q.type]?.acceptance ? { parts: partsOf(q, config, answer) } : {}),
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

/** What of an answer an acceptance can name, as the API's `partsOf` (ADR-128). */
function partsOf(q: MockQuestion, config: Record<string, unknown>, answer: unknown) {
  const hook = MOCK_SERVERS[q.type]?.acceptance;
  if (!hook || answer === null) return [];
  return hook.given(config, answer).map((p) => ({ ...p, label: hook.label(config, p.part, p.answer) ?? p.answer }));
}

/** The queue item's `acceptance` (ADR-128), for a type that takes one. */
function itemAcceptance(e: MockGradingWorld, item: MockEvalItem) {
  const q = questions.find((x) => x.id === item.questionId);
  const hook = q ? MOCK_SERVERS[q.type]?.acceptance : undefined;
  if (!q || !hook) return {};
  const config = publishedConfig(q);
  return {
    acceptance: {
      scopes: [...acceptanceScopes({ parameterized: isFall(q), singleAnswer: hook.singleAnswer?.(config) === true })],
      accepted: (e.acceptances.get(item.id) ?? []).map((r) => ({
        ...r,
        label: hook.label(config, r.part, r.answer) ?? r.answer,
      })),
    },
  };
}

on("GET", "/app/api/evaluations/:id/grading", (m, _body, url) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const itemId = url.searchParams.get("itemId");
  const anonymous = url.searchParams.get("anonymous") !== "0";
  const items = itemId ? e.items.filter((i) => i.id === itemId) : e.items;
  const pairs = items.flatMap((i) => e.attempts.map((a) => ({ a, i })));

  const entries = pairs.map(({ a, i }) => gradingEntry(e, a, i, anonymous));

  let validated = 0;
  let proposed = 0;
  for (const { a, i } of pairs) {
    const g = standingGrading(e, a.id, i.id);
    if (g?.state === "validated") validated += 1;
    else if (g?.state === "proposed") proposed += 1;
  }
  return {
    items: items.map((i) => ({
      id: i.id,
      position: i.position,
      internalName: i.internalName,
      type: i.type,
      points: i.points,
      minPoints: scoresNegatively(i.type, negativeOf(e.evaluation), i.counting) ? -i.points : 0,
      criteria: criteriaOfItem(e, i.id).map(({ id, title, weight }) => ({ id, title, weight })),
      explanation: questions.find((q) => q.id === i.questionId)?.versions.at(-1)?.explanation || null,
      // The server's rule (`exportsText`): the types with export hooks, never a parameterized item.
      exportable: i.type === "code" && !(FALL && i.questionId === FALL.id),
      ...itemAcceptance(e, i),
      ...(FALL && i.questionId === FALL.id
        ? {
            parameters: {
              variables: FALL.versions.at(-1)!.variables!,
              // The question as written: its `[[…]]` left as text.
              template: { student: studentView(FALL, publishedConfig(FALL)), solution: solutionOf(FALL), example: false },
            },
          }
        : {}),
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

/** Every question with its state (#107): two counters per question. */
on("GET", "/app/api/evaluations/:id/grading/steps", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  return {
    steps: e.items.map((i) => ({
      key: i.id,
      total: e.attempts.length,
      validated: e.attempts.filter((a) => standingGrading(e, a.id, i.id)?.state === "validated")
        .length,
    })),
  };
});

/** A PDF of the mock: an empty page under `name`. */
const mockPdf = (name: string) =>
  new Response("%PDF-1.7\n%mock\n%%EOF\n", {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}"` },
  });

// ADR-125: the config says the mock makes PDFs, so every PDF button downloads one.
on("GET", "/app/api/evaluations/:id/items/:itemId/answers.pdf", (m) => {
  gradingWorldOr404(m.groups!.id!);
  return mockPdf("answers.pdf");
});
for (const name of ["document", "handout"]) {
  on("GET", `/app/api/evaluations/:id/${name}.pdf`, (m) => {
    evaluationOr404(m.groups!.id!);
    return mockPdf(`${name}.pdf`);
  });
}
on("GET", "/app/api/evaluations/:id/results/attempts/:attemptId/copy.pdf", (m) => {
  gradingWorldOr404(m.groups!.id!);
  return mockPdf("copy.pdf");
});
// The student's own documents (ADR-112 amendment of 2026-11-03): their copy, a past series' blank print.
on("GET", "/app/api/attempts/:id/copy.pdf", () => mockPdf("my-copy.pdf"));
on("GET", "/app/api/student/evaluations/:id/handout.pdf", () => mockPdf("handout.pdf"));

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

function validateChain(e: MockGradingWorld, g: MockGrading, given?: { id: string; points: number }[]) {
  const criteria = criteriaOfItem(e, g.itemId);
  const graded = criteria.length > 0 ? breakdownFor(criteria, g.maxPoints, g.details, given) : null;
  if (given && !graded) throw refuse(422, "criteria_invalid", "the points per criterion do not match the item's criteria");
  if (graded) {
    g.details = { ...(g.details as Record<string, unknown> | null), [BREAKDOWN_KEY]: graded.breakdown };
    if (given && graded.total !== g.points) {
      g.points = graded.total;
      g.source = "manual";
    }
  }
  g.state = "validated";
  e.evaluation.modifiedAfterRelease = e.evaluation.releasedAt !== null ? true : e.evaluation.modifiedAfterRelease;
  return g;
}

on("POST", "/app/api/gradings/:id/validate", (m, body) => {
  for (const e of gradingWorlds) {
    for (const chain of e.gradings.values()) {
      const g = chain.find((x) => x.id === m.groups!.id);
      if (g) return validateChain(e, g, body.criteria as { id: string; points: number }[] | undefined);
    }
  }
  throw new MockError(404, "Grading not found");
});

function overrideCell(e: MockGradingWorld, g: MockGrading, body: Record<string, unknown>) {
  const chain = e.gradings.get(cellKey(g.attemptId, g.itemId))!;
  // The API's rule (ADR-118 §6): an essay with criteria is overridden by
  // them, the model's reply kept beside the new breakdown; any other item
  // writes `{ manual: true }`.
  const criteria = criteriaOfItem(e, g.itemId);
  const given = body.criteria as { id: string; points: number }[] | undefined;
  const graded = criteria.length > 0 ? breakdownFor(criteria, g.maxPoints, null, given ?? []) : null;
  if ((criteria.length > 0) !== (given !== undefined) || (given && !graded)) {
    throw refuse(422, "criteria_invalid", "the points per criterion do not match the item's criteria");
  }
  const previous = (g.details ?? {}) as Record<string, unknown>;
  g.state = "superseded";
  const next: MockGrading = {
    ...g,
    id: `g${(gradingSeq += 1)}`,
    points: graded ? graded.total : Number(body.points ?? 0),
    details: graded
      ? {
          ...(AI_KEY in previous ? { [AI_KEY]: previous[AI_KEY] } : {}),
          ...(JUSTIFICATION_KEY in previous ? { [JUSTIFICATION_KEY]: previous[JUSTIFICATION_KEY] } : {}),
          manual: true,
          [BREAKDOWN_KEY]: graded.breakdown,
        }
      : { manual: true },
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
    // The API's rule: a 0-point placeholder (an essay) waits for a person.
    if (!g || !isBatchable(g)) continue;
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

/**
 * ADR-108: how an item counts, changed at grading time — the server's gates
 * (a frozen list, a total that stays above 0), its "modified after
 * publication" once released.
 */
on("PUT", "/app/api/evaluations/:id/items/:itemId/counting", (m, body) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const itemId = String(m.groups!.itemId);
  const counting = body.counting as ItemCounting;
  const frozen = e.evaluation.items.find((i) => i.id === itemId);
  const graded = e.items.find((i) => i.id === itemId);
  if (!frozen || !graded) throw new MockError(404, "Item not found");
  const next = e.items.map((i) => (i.id === itemId ? { ...i, counting } : i));
  if (evaluationTotal(next) <= 0) {
    throw refuse(409, "illegal_transition", "no question would count", { reason: "no_graded_points" });
  }
  const changed = graded.counting !== counting;
  frozen.counting = counting;
  graded.counting = counting;
  if (changed && e.evaluation.releasedAt !== null) e.evaluation.modifiedAfterRelease = true;
  return { counting, modifiedAfterRelease: changed && e.evaluation.releasedAt !== null };
});

/**
 * ADR-128: accept an answer (`PUT`) or stop (`DELETE`), then re-grade the
 * answers it reaches through the type's own `grade`, a manual override left
 * alone — the API's `changeAcceptance`, on the mock's world.
 */
for (const method of ["PUT", "DELETE"] as const) {
  on(method, "/app/api/evaluations/:id/items/:itemId/acceptances", (m, body) => {
    const e = gradingWorldOr404(m.groups!.id!);
    const item = e.items.find((i) => i.id === String(m.groups!.itemId));
    const q = item ? questions.find((x) => x.id === item.questionId) : undefined;
    if (!item || !q) throw new MockError(404, "Item not found");
    if (!MOCK_SERVERS[q.type]?.acceptance) throw refuse(409, "acceptance_unavailable", "this question cannot accept an answer");
    const rule: AcceptanceRule = {
      part: String(body.part),
      answer: String(body.answer),
      attemptId: (body.attemptId as string | null) ?? null,
    };
    const rules = e.acceptances.get(item.id) ?? [];
    const same = (r: AcceptanceRule) => r.part === rule.part && r.answer === rule.answer && r.attemptId === rule.attemptId;
    const accept = method === "PUT";
    const changed = accept !== rules.some(same);
    e.acceptances.set(item.id, accept ? (changed ? [...rules, rule] : rules) : rules.filter((r) => !same(r)));
    if (!changed) return { accepted: accept, regraded: 0, unchanged: 0, modifiedAfterRelease: false };
    const config = publishedConfig(q);
    const { reached, unchanged } = acceptanceReach(
      e.attempts.map((a) => ({
        attemptId: a.id,
        given: partsOf(q, config, e.answers.get(cellKey(a.id, item.id)) ?? null),
        manual: standingGrading(e, a.id, item.id)?.source === "manual",
      })),
      rule,
    );
    let regraded = 0;
    for (const attemptId of reached) {
      const chain = e.gradings.get(cellKey(attemptId, item.id)) ?? [];
      const standing = chain.find((g) => g.state !== "superseded");
      if (!standing) continue;
      const accepted = rulesForAttempt(e.acceptances.get(item.id) ?? [], { id: attemptId, practice: false });
      const graded = gradeAccepted(
        q,
        config,
        e.answers.get(cellKey(attemptId, item.id)) ?? null,
        item,
        attemptId,
        accepted,
        negativeOf(e.evaluation),
      );
      const fraction = graded.maxPoints > 0 ? graded.points / graded.maxPoints : 0;
      standing.state = "superseded";
      chain.push({
        ...standing,
        id: `g${(gradingSeq += 1)}`,
        points: itemPoints(halfPoints(fraction * item.points)),
        source: "auto",
        state: "validated",
        details: graded.details,
        confidence: null,
        comment: null,
        gradedAt: new Date().toISOString(),
        supersedesId: standing.id,
      });
      regraded += 1;
    }
    const modifiedAfterRelease = regraded > 0 && e.evaluation.releasedAt !== null;
    if (modifiedAfterRelease) e.evaluation.modifiedAfterRelease = true;
    return { accepted: accept, regraded, unchanged: unchanged.length, modifiedAfterRelease };
  });
}

/** A roster line's id for a mock user: what a gradebook mark addresses (`.../marks/:eid`). */
const seatOf = (userId: string) => `00000000-0000-4000-9000-${[...userId].map((c) => c.charCodeAt(0) % 10).join("").padStart(12, "0").slice(-12)}`;

/**
 * An excused student (#969): the gradebook's mark, read by the results view.
 * The mock excuses the first student of a released world, for the screen.
 */
const excusedOf = (e: MockGradingWorld, userId: string) =>
  e.evaluation.releasedAt !== null && e.attempts.find((a) => !a.staff)?.userId === userId
    ? { comment: "Certificat medical" }
    : null;

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
      enrollmentId: seatOf(a.userId),
      excused: excusedOf(e, a.userId),
      origin: e.evaluation.rows.find((r) => r.userId === a.userId)?.origin ?? ("digital" as const),
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
      enrollmentId: seatOf(row.userId),
      excused: excusedOf(e, row.userId),
      origin: "digital" as const,
    });
  });
  // The class, and only the class: a teacher's own test is a row of the
  // table and of nothing else (ADR-018).
  const grades = rows.filter(inStatistics).map((r) => r.grade);
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
        counting: i.counting,
        successRate:
          scores.length === 0
            ? null
            : round2(scores.reduce((s, g) => s + g.points / g.maxPoints, 0) / scores.length),
      };
    }),
    rows,
    stats: { ...stats, histogram: histogram(grades) },
    // ADR-122: an exercise over and open to practice shows who practised since.
    // `?practised=1` shows the line on the mock's graded evaluations, exams in the fiction.
    practisedCount: flags.practised || e.evaluation.mode === "exercise" ? 3 : 0,
  };
}

on("GET", "/app/api/evaluations/:id/results", (m) => resultsView(gradingWorldOr404(m.groups!.id!)));

function attemptAggregate(type: string, answer: unknown, details: unknown): ItemAggregate {
  const server = MOCK_SERVERS[type];
  if (server?.aggregate) return server.aggregate({ answers: [answer], details: [details] });
  const cases = (details as { cases?: { name: string; ok: boolean }[] } | null)?.cases ?? [];
  return { casePassRate: cases.map((c) => ({ name: c.name, passed: c.ok ? 1 : 0, total: 1 })) };
}

on("GET", "/app/api/evaluations/:id/results/by-question", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  if (
    !isDebriefOpen({
      state: e.evaluation.state,
      correctionPublished: e.evaluation.correctionPublishedAt !== null,
    })
  ) {
    throw new MockPayload(409, { error: "not_over", message: "the evaluation is not over" });
  }
  const view = resultsView(e);
  const papers = e.attempts.filter((a) => !a.staff).length;
  return e.items.map((item, index) => {
    const q = questions.find((x) => x.id === item.questionId)!;
    // A parameterized question projects its example instance (ADR-056 §9).
    const config = attemptConfig(q, null);
    const server = MOCK_SERVERS[q.type];
    // As `byQuestion` does it: one tally per attempt of the class, a blank
    // for no answer (or one that holds nothing), nothing at all for an
    // answer still waiting for its grading to be validated.
    const tallies: AttemptTally[] = [];
    for (const attempt of e.attempts.filter((a) => !a.staff)) {
      const answer = e.answers.get(cellKey(attempt.id, item.id));
      if (answer === undefined || (server !== undefined && !server.isAnswered(answer))) {
        tallies.push({ grading: null, aggregate: {} });
        continue;
      }
      const grading = standingGrading(e, attempt.id, item.id);
      if (grading?.state !== "validated") continue;
      tallies.push({ grading, aggregate: attemptAggregate(q.type, answer, grading.details) });
    }
    const { outcomes, successRate, distribution, casePassRate } = debrief(tallies);
    return {
      item: view.items[index]!,
      papers,
      ...(isFall(q) ? { parameterized: true } : {}),
      student: studentView(q, config),
      solution:
        q.type === "code"
          ? mockCodeDetails(config, 1).solution
          : (tryAnswer(q, config, null) as { solution?: unknown }).solution ?? null,
      explanation: fallExplanation(q, null) ?? (q.versions.at(-1)?.explanation || null),
      outcomes,
      // Grouped by verdict only: no group by what was written holds.
      distribution: isFall(q) ? [] : distribution,
      casePassRate,
      successRate,
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

/**
 * ADR-050: the correction of an open exercise. The debrief reads a grading
 * world, so publishing builds one from the papers handed in so far, graded —
 * the attempts still being written are not in it, as the server counts them.
 */
on("POST", "/app/api/evaluations/:id/publish-correction", (m) => {
  const evaluation = evaluationOr404(m.groups!.id!);
  const refusal = correctionPublishRefusal(evaluation);
  if (refusal === "exam" || refusal === "poll") {
    throw new MockPayload(422, {
      error: "correction_not_allowed",
      reason: refusal,
      message: "never published early",
    });
  }
  if (evaluation.correctionPublishedAt !== null) {
    return { correctionPublishedAt: evaluation.correctionPublishedAt, queued: 0 };
  }
  if (refusal !== null) {
    throw new MockPayload(409, { error: "correction_not_open", message: "not open" });
  }
  evaluation.correctionPublishedAt = iso(0);
  const handedIn = evaluation.rows.filter((r) => r.state === "submitted" || r.state === "expired");
  if (!gradingWorlds.some((w) => w.evaluation.id === evaluation.id)) {
    gradingWorlds.push(buildGradingWorld(evaluation, { allValidated: true, rows: handedIn }));
  }
  return { correctionPublishedAt: evaluation.correctionPublishedAt, queued: handedIn.length };
});

on("POST", "/app/api/evaluations/:id/unrelease", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  e.evaluation.releasedAt = null;
  e.evaluation.state = "closed";
  e.evaluation.modifiedAfterRelease = false;
  return { releasedAt: null, rows: 0, released: false };
});

on("GET", "/app/api/evaluations/:id/results/attempts/:attemptId", (m) => {
  const e = gradingWorldOr404(m.groups!.id!);
  const attempt = e.attempts.find((a) => a.id === m.groups!.attemptId);
  if (!attempt) throw new MockError(404, "Attempt not found");
  return copyOf(e, attempt);
});

/**
 * The student's exercises, read before any release: the released world's
 * page, seen as an exercise, whose correction shows at each hand-in
 * (ADR-124) — points only, no grade (F-RES-04), the last `pending` questions
 * waiting for a grading. The Grades page's early row, the retake between two
 * attempts (the next one offered beside the correction, ADR-091's standings
 * with it) and the latest practice after the due date (ADR-122).
 */
const EXERCISE_PAGES: Record<string, { evaluationId?: string; title: string; pending: number; review?: true; extra?: object }> = {
  [STUDENT_EARLY_ATTEMPT]: { title: "Série 2 — Tableaux", pending: 2 },
  [STUDENT_RETAKE_ATTEMPT]: {
    evaluationId: STUDENT_EVAL_RETAKE,
    title: "Série 3 — Pointeurs, entraînement",
    pending: 0,
    review: true,
    extra: {
      // Two of three attempts taken: the page offers the third (issues #120, #121).
      retake: {
        evaluationId: STUDENT_EVAL_RETAKE,
        keep: "best",
        maxAttempts: 3,
        attemptCount: 2,
        refusal: null,
        // ADR-091: redo the questions to review, or everything.
        scope: "to_review",
      },
    },
  },
  [STUDENT_PRACTICE_ATTEMPT]: {
    evaluationId: STUDENT_PRACTICE_A,
    title: "Série 2 — Boucles et conditions",
    pending: 1,
    extra: { practice: true },
  },
};

on("GET", "/app/api/attempts/:id/feedback", (m) => {
  const attemptId = String(m.groups!.id);
  const page = EXERCISE_PAGES[attemptId];
  if (page) {
    const released = feedbackPage(STUDENT_PAST_ATTEMPT);
    if (!released.available) return released;
    const items = released.items.map((item, index, all) =>
      index < all.length - page.pending ? item : { ...item, points: null, verdict: null, details: null, comment: null },
    );
    // ADR-091: where each question stands, in the student's order, beside the retake.
    const review = page.review
      ? {
          review: items.map((item, rank) => ({
            itemId: item.itemId,
            rank,
            standing: item.points === null ? "pending" : item.points >= item.maxPoints ? "acquired" : "to_review",
          })),
        }
      : {};
    return {
      ...released,
      evaluation: {
        id: page.evaluationId ?? released.evaluation.id,
        title: page.title,
        releasedAt: null,
      },
      attemptId,
      points: items.reduce((sum, item) => sum + (item.points ?? 0), 0),
      grade: null,
      pendingCount: page.pending,
      items,
      ...page.extra,
      ...review,
    };
  }
  return feedbackPage(attemptId);
});

function feedbackPage(attemptId: string) {
  const { e, attempt } = attemptWorldOr404(attemptId);
  // The server's rule: an exercise shows its correction at the hand-in (ADR-124).
  const policy = effectiveFeedbackPolicy(e.evaluation.mode, FeedbackPolicy.parse(e.evaluation.feedbackPolicy));
  const released = e.evaluation.releasedAt !== null;
  if (!released && policy.when !== "immediate") {
    return {
      available: false as const,
      reason: "results_pending",
      evaluation: { id: e.evaluation.id, title: e.evaluation.title },
    };
  }
  const copy = copyOf(e, attempt);
  const shown = { showKey: policy.showKey, showHiddenCaseNames: policy.showHiddenCaseNames };
  return {
    available: true as const,
    evaluation: { id: e.evaluation.id, title: e.evaluation.title, releasedAt: e.evaluation.releasedAt },
    ...copy,
    items: copy.items.map((item) => ({ ...item, details: studentDetailsOf(item.type, item.details, shown) })),
    // The server's rule (F-RES-04): released, and no question pending.
    grade: feedbackGradeShown({ released, pendingCount: copy.pendingCount }) ? copy.grade : null,
  };
}

/**
 * A grading's details as the server's `filterDetails` hands them to a
 * student, its rules borrowed, none of its own: the teacher-only keys
 * stripped, then, without the key, the essay's own hook (which drops the
 * validated points per criterion, ADR-118 §5).
 */
function studentDetailsOf(type: string, details: unknown, policy: StudentDetailsPolicy): unknown {
  if (details === null || typeof details !== "object") return details ?? null;
  const stripped = Object.fromEntries(
    Object.entries(details).filter(([key]) => !TEACHER_ONLY_DETAIL_KEYS.includes(key)),
  );
  return type === "rich" && !policy.showKey
    ? richServer.studentDetails!(stripped as Parameters<NonNullable<typeof richServer.studentDetails>>[0], policy)
    : stripped;
}

function attemptWorldOr404(attemptId: string) {
  const e = gradingWorlds.find((x) => x.attempts.some((a) => a.id === attemptId));
  if (!e) throw new MockError(404, "Attempt not found");
  return { e, attempt: e.attempts.find((a) => a.id === attemptId)! };
}

/** One attempt's copy with everything shown: the teacher's, and the feedback's once released. */
function copyOf(e: MockGradingWorld, attempt: MockAttempt) {
  const { points } = attemptPoints(e, attempt.id);
  const total = gradedTotalPointsOf(e);
  const pendingCount = e.items.filter((item) => !standingGrading(e, attempt.id, item.id)).length;
  return {
    attemptId: attempt.id,
    origin: e.evaluation.rows.find((r) => r.attemptId === attempt.id)?.origin ?? ("digital" as const),
    supersededBy: null,
    points,
    totalPoints: total,
    grade: gradeOf(points, total),
    pendingCount,
    items: e.items.map((item) => {
      const q = questions.find((x) => x.id === item.questionId)!;
      const config = attemptConfig(q, attempt.id);
      const key = cellKey(attempt.id, item.id);
      const answer = e.answers.get(key) ?? null;
      const grading = standingGrading(e, attempt.id, item.id);
      const solution =
        q.type === "code"
          ? mockCodeDetails(config, 1).solution
          : (tryAnswer(q, config, answer, e.evaluation.mcqPolicy, negativeOf(e.evaluation)) as { solution?: unknown }).solution ?? null;
      return {
        itemId: item.id,
        position: item.position,
        type: item.type,
        points: grading ? grading.points : null,
        maxPoints: item.points,
        counting: item.counting,
        verdict: grading
          ? grading.points >= item.points
            ? "correct"
            : grading.points > 0
              ? "partial"
              : "wrong"
          : null,
        student: studentView(q, config),
        answer,
        // The student's key: an essay's rubric stays the teacher's (ADR-037).
        solution: studentSolutionOf(q, solution),
        explanation: fallExplanation(q, attempt.id) ?? (q.versions.at(-1)?.explanation || null),
        details: grading?.details ?? null,
        comment: grading?.comment ?? null,
      };
    }),
  };
}


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
