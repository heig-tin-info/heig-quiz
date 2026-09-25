/** Section 3 of the mock — see `index.ts` for the layout. */
import {
  configLock,
  isConfigEditable,
  isConfigFieldWritable,
  isFeedbackAllowed,
  itemListLock,
  missingTimingFields,
  parseCloze,
  round2,
  splitTemplate,
} from "@quiz/domain";
import type {
  EvaluationTiming,
  FeedbackWhen,
  LobbyName,
  McqScorePolicy,
} from "@quiz/domain";
import {
  D,
  H,
  MockError,
  MockPayload,
  flags,
  iso,
  on,
  rand,
} from "./runtime";
import {
  MockQuestion,
  RC_REFERENCE,
  RC_STUDENT,
  categories,
  coursePools,
  frozenConfig,
  isKeyless,
  poolOr404,
  poolSummary,
  questionOr404,
  questions,
  solutionOf,
  studentView,
} from "./pool";
import {
  ME_TEACHER,
  classroomRoster,
  courses,
  roomOr404,
  rooms,
} from "./org";
import {
  me,
} from "./session";

// --- 3. Evaluations, live dashboard (WP8) ----------------------------------
//
// Everything a teacher can configure and supervise, with enough data that the
// five states of every surface are reachable without a backend: one
// evaluation per state, and a running one at 24 students × 10 questions —
// the size the grid has to stay usable at (120 × 10 under `?many=1`, which is
// the roster the classroom above grows to).
//
// The items are frozen on the questions of section 2, by design: the item
// table, the picker, the teacher's preview and the inspect panel of the
// dashboard then all render the SAME four types on the SAME French content
// the pool screens show, and there is exactly one place to edit when a
// payload changes.
//
// Ids here are real UUIDs, not "e1": the SSE client validates every frame
// against the `ServerEvent` schema of `@quiz/contracts` (invariant 7) and the
// dashboard snapshot against `DashboardView`, so the mock has to speak the
// same grammar as the server, down to the id format. The one exception is the
// `questionId` an item points at, which is the pool's own `q3` — it never
// travels on the stream.

let uuidSeq = 0;
export const uuid = (): string =>
  `00000000-0000-4000-8000-${(uuidSeq += 1).toString(16).padStart(12, "0")}`;

const ADJECTIVES = ["calme", "vif", "patient", "curieux", "sobre", "franc", "alerte", "serein"];
const ANIMALS = ["héron", "renard", "lynx", "martre", "bouquetin", "chamois", "castor", "milan"];
/** Decision D20: a stable adjective+animal per row, never the student's name. */
const pseudonymOf = (index: number) =>
  `${ADJECTIVES[index % ADJECTIVES.length]} ${ANIMALS[(index * 3) % ANIMALS.length]}`;

// --- The pool, seen from an evaluation -------------------------------------
//
// Four adapters, one per thing an item needs from the question it froze: what
// the student sees, what the key is, what a student plausibly answered, and
// the glyph the grid puts in a cell. The first two go through the very
// functions of section 2 (`studentView`, and the `@quiz/domain` cloze
// helpers), so nothing is described twice.


/** The questions an evaluation may draw from: published, `p1` first. */
function itemSource(): MockQuestion[] {
  const published = questions.filter((q) => q.deletedAt === null && q.versions.length > 0);
  const primary = published.filter((q) => q.poolId === "p1");
  /*
   * The `circuit` question lives in the SECOND pool — a sensor's front end is
   * not a C exercise — and an evaluation that never played it would leave the
   * dashboard, the grading panel and the feedback screen without one. It is
   * spliced in early enough that even a four-item evaluation carries it.
   */
  const circuit = published.filter((q) => q.type === "circuit");
  if (primary.length === 0) return published;
  return [...primary.slice(0, 2), ...circuit, ...primary.slice(2)];
}

const studentConfigOf = (q: MockQuestion): unknown => studentView(q, frozenConfig(q));


type MockBlank = ReturnType<typeof parseCloze>["blanks"][number];

/** What a student would type in one blank. A `select` stores the option INDEX. */
function blankAnswer(blank: MockBlank): string {
  switch (blank.kind) {
    case "text":
      return blank.answers[0] ?? "";
    case "number":
      return String(blank.value);
    case "select":
      return String(blank.correct[0] ?? 0);
    case "regex":
      return blank.pattern.replace(/[^\w ]/g, "");
  }
}

/**
 * One student's answer to one item. Two in three are the right one: a grid of
 * nothing but wrong answers reads as a broken mock rather than as a hard
 * question, and the teacher's eye is exactly what these screens are for.
 */
function answerOf(q: MockQuestion, seedValue: number): unknown {
  const config = frozenConfig(q);
  const wrong = seedValue % 3 === 0;
  switch (q.type) {
    case "mcq": {
      const choices = (config.choices ?? []) as { correct: boolean }[];
      const correct = Math.max(
        choices.findIndex((c) => c.correct),
        0,
      );
      const picked = wrong ? (correct + 1) % Math.max(choices.length, 1) : correct;
      return { selected: [picked] };
    }
    case "short": {
      const matchers = (config.matchers ?? []) as { value?: unknown }[];
      const expected = String(matchers[0]?.value ?? "");
      return { text: wrong ? `${expected}0` : expected };
    }
    case "cloze": {
      const parse = parseCloze(String(config.text ?? ""));
      // A blank left untouched is `null`, which is what an unfinished answer
      // looks like on the wire.
      return {
        blanks: parse.blanks.map((b, i) => ((seedValue + i) % 4 === 0 ? null : blankAnswer(b))),
      };
    }
    case "code":
      return {
        regions: splitTemplate(String(config.template ?? ""), "c")
          .filter((s) => s.kind === "editable")
          .map((s) => s.text),
        lastRun: null,
      };
    case "codeimage":
      return {
        regions: splitTemplate(String(config.template ?? ""), "c")
          .filter((s) => s.kind === "editable")
          .map((s) => s.text),
      };
    // The student's circuit is the reference with its ground wires missing
    // when the seed says "wrong": a floating capacitor is the mistake this
    // type actually produces, and the strip under the canvas names it.
    case "circuit":
      return { schematic: wrong ? RC_STUDENT : RC_REFERENCE };
  }
}

/** One glyph or two for the grid cell (what `type.summarize` returns). */
/**
 * The glyph a dashboard cell carries, the way the SERVER writes it: the
 * question type's own `summarizeAnswer` (`@quiz/core`), not a count. It is
 * duplicated here rather than imported because the mock answers HTTP and has
 * no configuration to hand a server package; the shapes are the real ones, so
 * a change of form is visible on the screenshots.
 */
export function summaryOf(q: MockQuestion, seedValue: number): string {
  const answer = answerOf(q, seedValue);
  switch (q.type) {
    case "mcq":
      return (answer as { selected: number[] }).selected
        .map((index) => String.fromCharCode(65 + index))
        .join(", ");
    case "short":
      return (answer as { text: string }).text;
    case "cloze":
      return (answer as { blanks: (string | null)[] }).blanks
        .map((b) => (b === null || b === "" ? "—" : b))
        .join(" · ");
    case "code":
    case "codeimage": {
      const regions = (answer as { regions?: string[] }).regions ?? [];
      return `${regions.reduce((sum, r) => sum + r.split("\n").length, 0)} L`;
    }
    case "circuit": {
      const schematic = (answer as { schematic?: { components?: unknown[] } }).schematic;
      const max = (frozenConfig(q).palette as { maxComponents?: number } | undefined)
        ?.maxComponents;
      return `${schematic?.components?.length ?? 0}/${max ?? 10}`;
    }
  }
}

/** The pool question an item froze on, or null if the pool no longer has it. */
export const itemQuestion = (item: { questionId: string }): MockQuestion | null =>
  questions.find((q) => q.id === item.questionId) ?? null;
interface MockCell {
  itemId: string;
  status: "empty" | "seen" | "in_progress" | "done";
  /**
   * The live verdict of ADR-020: with the "Results" switch on, the real
   * server grades the answer it already holds. The mock fakes it the only
   * way a mock can — deterministically, from the cell's own coordinates —
   * so the screen it draws is the screen the teacher gets.
   */
  verdict: "correct" | "partial" | "wrong" | null;
  provisional: boolean;
  points: null;
  revision: number;
  summary: string | null;
}

/** A stable verdict per cell, so a re-render never reshuffles the colours. */
export function mockVerdict(seed: number): "correct" | "partial" | "wrong" {
  const n = seed % 10;
  return n < 6 ? "correct" : n < 8 ? "partial" : "wrong";
}

interface MockItem {
  id: string;
  position: number;
  points: number;
  milestone: boolean;
  questionId: string;
  questionVersionId: string;
  type: string;
  internalName: string;
  versionNumber: number;
  latestVersionNumber: number | null;
  deprecated: boolean;
}

interface MockRowState {
  attemptId: string | null;
  seatId: string;
  userId: string;
  displayName: string;
  /** A teacher walking their own quiz (ADR-018): badged, counted nowhere. */
  staff: boolean;
  lastName: string;
  firstName: string;
  email: string;
  pseudonym: string;
  state: "not_started" | "in_progress" | "submitted" | "expired";
  online: boolean;
  lastSeenAt: string | null;
  deadlineAt: string | null;
  timeBonusPercent: number;
  points: null;
  maxPoints: number;
  cells: MockCell[];
}

export interface MockEvaluation {
  id: string;
  classroomId: string;
  title: string;
  mode: "exam" | "exercise" | "poll";
  state:
    | "draft"
    | "scheduled"
    | "lobby"
    | "running"
    | "paused"
    | "closed"
    | "grading"
    | "released";
  settings: Record<string, unknown>;
  gradingScale: Record<string, unknown>;
  feedbackPolicy: Record<string, unknown>;
  mcqPolicy: McqScorePolicy;
  opensAt: string | null;
  closesAt: string | null;
  durationS: number | null;
  accessCode: string | null;
  ipAllowlist: string[];
  startedAt: string | null;
  pausedAt: string | null;
  closedAt: string | null;
  releasedAt: string | null;
  modifiedAfterRelease: boolean;
  createdAt: string;
  items: MockItem[];
  rows: MockRowState[];
  present: number;
}

const defaultEvaluationSettings = () => ({
  navigation: "free",
  presentation: "zen",
  lobby: "manual",
  shuffleItems: false,
  shuffleChoices: true,
  timing: "duration",
  showProgressBar: true,
  logVisibility: true,
  requireFullscreen: false,
});

/**
 * The items of an evaluation, frozen on the published questions of the pool.
 * `versionNumber` is the frozen one and `latestVersionNumber` what the pool
 * published since: one item in five is deliberately left a version behind, so
 * the stale badge and the one-click update are reachable without editing
 * anything.
 */
function makeItems(count: number): MockItem[] {
  const source = itemSource();
  if (source.length === 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const q = source[i % source.length]!;
    const latest = q.versions.at(-1)!;
    // Every third item is frozen one version behind, whenever the question
    // has one: that is the stale badge and the one-click update.
    const frozen = i % 3 === 0 && latest.number > 1 ? latest.number - 1 : latest.number;
    return {
      id: uuid(),
      position: i + 1,
      points: q.type === "code" ? 3 : 1 + (i % 3),
      // Two section breaks, the first early enough that the four-item draft
      // shows one: the milestone separator is a shape of the list and has to
      // appear on the screenshot that documents it.
      milestone: i === 1 || i === 4,
      questionId: q.id,
      questionVersionId: uuid(),
      type: q.type,
      internalName: q.internalName,
      versionNumber: frozen,
      latestVersionNumber: latest.number,
      deprecated: latest.deprecatedAt !== null,
    };
  });
}

export function makeRows(e: MockEvaluation, started: boolean): MockRowState[] {
  const roster = classroomRoster(e.classroomId);
  const maxPoints = e.items.reduce((sum, i) => sum + i.points, 0);
  return roster.map((student, index) => {
    // A deterministic spread: some are ahead, some have not opened it.
    const progress = started ? Math.min(e.items.length, Math.floor(rand() * (e.items.length + 2))) : 0;
    const online = started ? rand() > 0.12 : rand() > 0.3;
    const hasAttempt = started && progress > 0;
    return {
      attemptId: hasAttempt ? uuid() : null,
      seatId: uuid(),
      userId: uuid(),
      displayName: `${student.nom}, ${student.prenom}`,
      staff: false,
      lastName: student.nom,
      firstName: student.prenom,
      email: student.email,
      pseudonym: pseudonymOf(index),
      state: !hasAttempt
        ? "not_started"
        : progress >= e.items.length
          ? "submitted"
          : "in_progress",
      online,
      lastSeenAt: online ? iso(-2000) : hasAttempt ? iso(-40_000) : null,
      deadlineAt: hasAttempt ? iso(12 * 60_000 + index * 1000) : null,
      timeBonusPercent: student.timeBonusPercent,
      points: null,
      maxPoints,
      cells: e.items.map((item, i) => {
        // The four states of F-DASH-01, all four reachable: done behind the
        // student, `in_progress` where they are, `seen` on the next question
        // for a third of the class (opened, nothing typed) and empty after.
        const status: MockCell["status"] =
          i < progress - 1
            ? "done"
            : i === progress - 1
              ? "in_progress"
              : i === progress && index % 3 === 0
                ? "seen"
                : "empty";
        const question = itemQuestion(item);
        const answered = status === "done" || status === "in_progress";
        return {
          itemId: item.id,
          status,
          verdict: answered ? mockVerdict(index * 7 + i * 3) : null,
          provisional: answered,
          points: null,
          revision: status === "empty" || status === "seen" ? 0 : 1 + i,
          // `seen` carries nothing on purpose: there is no answer to preview.
          summary:
            (status === "done" || status === "in_progress") && question !== null
              ? summaryOf(question, index + i)
              : null,
        };
      }),
    };
  });
}

export function makeEvaluation(
  classroomId: string,
  title: string,
  state: MockEvaluation["state"],
  itemCount: number,
  extra: Partial<MockEvaluation> = {},
): MockEvaluation {
  const e: MockEvaluation = {
    id: uuid(),
    classroomId,
    title,
    mode: "exam",
    state,
    settings: defaultEvaluationSettings(),
    gradingScale: { kind: "linear", rounding: "nearest" },
    feedbackPolicy: {
      when: "on_release",
      showAnswer: true,
      showKey: false,
      showExplanation: false,
      showHiddenCaseNames: true,
      showTeacherComment: true,
    },
    mcqPolicy: "all_or_nothing",
    opensAt: null,
    closesAt: null,
    durationS: 45 * 60,
    accessCode: null,
    ipAllowlist: [],
    startedAt: null,
    pausedAt: null,
    closedAt: null,
    releasedAt: null,
    modifiedAfterRelease: false,
    createdAt: iso(-10 * D),
    items: [],
    rows: [],
    present: 0,
    ...extra,
  };
  e.items = makeItems(itemCount);
  const started =
    state === "running" || state === "paused" || state === "closed" || state === "released";
  e.rows = makeRows(e, started);
  if (state === "closed" || state === "released") {
    // Nothing is in flight once the ticker has closed everything: no
    // countdown keeps running on a finished quiz.
    for (const row of e.rows) {
      if (row.state === "in_progress") row.state = "expired";
      row.deadlineAt = null;
    }
  }
  e.present = e.rows.filter((r) => r.online).length;
  return e;
}

export const evaluations: MockEvaluation[] = [];
/** The classroom every seeded evaluation belongs to (`r1`, emptied or not). */
export const EVAL_ROOM = "r1";

/*
 * The finished two come first and are seeded UNCONDITIONALLY. They are the
 * ones section 5 grades, and an empty grading queue or an empty results table
 * is a state of a real evaluation, not of a missing one: under `?empty=1` the
 * classroom has no roster, so they simply carry no item and no attempt.
 *
 * Being first also makes them what the state aliases `closed` and `released`
 * resolve to, which is what the screenshot script deep-links to.
 */
evaluations.push(
  makeEvaluation(EVAL_ROOM, "Quiz 0 — prise en main", "closed", 5, {
    startedAt: iso(-20 * D),
    closedAt: iso(-20 * D + H),
  }),
  makeEvaluation(EVAL_ROOM, "Test d'entrée", "released", 6, {
    startedAt: iso(-60 * D),
    closedAt: iso(-60 * D + H),
    releasedAt: iso(-59 * D),
    // Published, then a grading was adjusted: the banner the results page
    // shows when what the students read is no longer what the table says.
    modifiedAfterRelease: true,
  }),
);

function seedEvaluations() {
  const room = rooms[0];
  if (!room) return;
  evaluations.push(
    makeEvaluation(room.id, "Quiz 1 — variables et types", "draft", 4),
    makeEvaluation(room.id, "Quiz 2 — boucles", "scheduled", 6, {
      opensAt: iso(2 * D),
      closesAt: iso(2 * D + H),
    }),
    makeEvaluation(room.id, "Quiz 4 — chaînes", "lobby", 8),
    makeEvaluation(room.id, "Quiz 3 — pointeurs et tableaux", "running", 10, {
      startedAt: iso(-13 * 60_000),
      closesAt: iso(12 * 60_000),
    }),
    makeEvaluation(room.id, "Exercice — allocation dynamique", "paused", 5, {
      mode: "exercise",
      startedAt: iso(-30 * 60_000),
      closesAt: iso(8 * 60_000),
      pausedAt: iso(-60_000),
    }),
  );
}
if (!flags.empty) seedEvaluations();

/**
 * `?mytest=1` — the teacher joined their own classroom and walked every
 * started evaluation with that staff seat (ADR-018). It is what makes the
 * reset action, the badged row of the live grid, the badged entry of the
 * grading panel and the badged result row reachable in the mock.
 */
function seedStaffTest() {
  for (const room of rooms) {
    if (room.roster.some((s) => s.email === ME_TEACHER.email)) continue;
    room.roster.push({
      id: "s-me",
      nom: ME_TEACHER.familyName,
      prenom: ME_TEACHER.givenName,
      email: ME_TEACHER.email,
      status: "claimed",
      conflictFlag: false,
      staff: true,
      timeBonusPercent: 0,
      note: null,
      lastLoginAt: iso(-H),
      avatarUrl: null,
      userId: ME_TEACHER.userId,
    });
  }
  for (const e of evaluations) {
    // Only where the class itself has attempts: a teacher's test on a draft
    // nobody has opened is not a state worth mocking.
    if (!e.rows.some((r) => r.attemptId !== null)) continue;
    e.rows.push(staffRow(e));
  }
}

/** The teacher's own row: every question answered and submitted. */
function staffRow(e: MockEvaluation): MockRowState {
  const maxPoints = e.items.reduce((sum, i) => sum + i.points, 0);
  return {
    attemptId: uuid(),
    seatId: uuid(),
    userId: ME_TEACHER.userId,
    displayName: `${ME_TEACHER.familyName}, ${ME_TEACHER.givenName}`,
    staff: true,
    lastName: ME_TEACHER.familyName,
    firstName: ME_TEACHER.givenName,
    email: ME_TEACHER.email,
    pseudonym: "Staff Test",
    state: "submitted",
    online: false,
    lastSeenAt: iso(-5 * 60_000),
    deadlineAt: null,
    timeBonusPercent: 0,
    points: null,
    maxPoints,
    cells: e.items.map((item, i) => ({
      itemId: item.id,
      status: "done" as const,
      verdict: mockVerdict(i * 3),
      provisional: true,
      points: null,
      revision: 1 + i,
      summary: null,
    })),
  };
}
if (flags.mytest && !flags.empty) seedStaffTest();

/** The running evaluation is the one the fake stream keeps moving. */
const runningEvaluation = () => evaluations.find((e) => e.state === "running") ?? null;

/**
 * Mock-only affordance: an evaluation is addressable by its STATE as well as
 * by its id, so `/evaluations/running/live` and `/evaluations/lobby` are
 * stable URLs for the screenshot script and for a quick look. The real API
 * only knows uuids, and so does every id the mock puts on the wire.
 */
export const aliased = new Map<string, string>();
export const findEvaluation = (key: string): MockEvaluation | null => {
  const byId = evaluations.find((x) => x.id === key);
  if (byId) return byId;
  // An alias is resolved ONCE and then pinned to the evaluation it found.
  // Otherwise pausing `/evaluations/running/live` moves that evaluation out
  // of the `running` state, the next request on the same URL matches nothing,
  // and the dashboard that just issued the command gets a 404 (W17).
  const pinned = aliased.get(key);
  if (pinned !== undefined) return evaluations.find((x) => x.id === pinned) ?? null;
  const byState = evaluations.find((x) => x.state === key) ?? null;
  if (byState) aliased.set(key, byState.id);
  return byState;
};

export const evaluationOr404 = (id: string) => {
  const e = findEvaluation(id);
  if (!e) throw new MockError(404, "Evaluation not found");
  return e;
};

const totalPointsOf = (e: MockEvaluation) => e.items.reduce((sum, i) => sum + i.points, 0);
const attemptCountOf = (e: MockEvaluation) => e.rows.filter((r) => r.attemptId !== null).length;

export const toEvaluation = (e: MockEvaluation) => ({
  id: e.id,
  classroomId: e.classroomId,
  title: e.title,
  mode: e.mode,
  state: e.state,
  settings: e.settings,
  gradingScale: e.gradingScale,
  feedbackPolicy: e.feedbackPolicy,
  mcqPolicy: e.mcqPolicy,
  opensAt: e.opensAt,
  closesAt: e.closesAt,
  durationS: e.durationS,
  accessCode: e.accessCode,
  ipAllowlist: e.ipAllowlist,
  startedAt: e.startedAt,
  pausedAt: e.pausedAt,
  closedAt: e.closedAt,
  releasedAt: e.releasedAt,
  modifiedAfterRelease: e.modifiedAfterRelease,
  createdAt: e.createdAt,
});

const evaluationSummary = (e: MockEvaluation) => ({
  id: e.id,
  classroomId: e.classroomId,
  title: e.title,
  mode: e.mode,
  state: e.state,
  itemCount: e.items.length,
  totalPoints: totalPointsOf(e),
  attemptCount: attemptCountOf(e),
  opensAt: e.opensAt,
  closesAt: e.closesAt,
  createdAt: e.createdAt,
});

/**
 * The reader's own seat and test attempt (ADR-018). The seat is read off the
 * classroom roster, exactly as the server reads it off `enrollments`, so
 * clicking "Join as student" here really changes what the button does next.
 */
const selfOf = (e: MockEvaluation) => {
  const seat = (rooms.find((r) => r.id === e.classroomId)?.roster ?? []).find(
    (s) => me !== null && s.email.toLowerCase() === me.email.toLowerCase(),
  );
  return {
    seat: seat !== undefined,
    staffSeat: seat?.staff ?? false,
    attemptId: e.rows.find((r) => r.staff)?.attemptId ?? null,
  };
};

const evaluationDetail = (e: MockEvaluation) => ({
  evaluation: toEvaluation(e),
  items: e.items.map((i) => ({ ...i })),
  totalPoints: totalPointsOf(e),
  staleItems: e.items
    .filter((i) => i.latestVersionNumber !== null && i.latestVersionNumber > i.versionNumber)
    .map((i) => i.id),
  attemptCount: attemptCountOf(e),
  editable: isConfigEditable(e.state, attemptCountOf(e)),
  self: selfOf(e),
});

export const dashboardView = (e: MockEvaluation, includeAnswers: boolean) => {
  // Every denominator is the CLASS: a teacher's own test walk is a row and
  // not a total (ADR-018).
  const classRows = e.rows.filter((r) => !r.staff);
  const started = classRows.filter((r) => r.attemptId !== null).length;
  return {
    evaluation: {
      id: e.id,
      state: e.state,
      startedAt: e.startedAt,
      pausedAt: e.pausedAt,
      closesAt: e.closesAt,
      serverNow: iso(0),
    },
    items: e.items.map((i) => ({
      id: i.id,
      position: i.position,
      points: i.points,
      type: i.type,
      internalName: i.internalName,
      milestone: i.milestone,
    })),
    rows: e.rows.map((r) => ({
      ...r,
      cells: r.cells.map((c) => ({ ...c, summary: includeAnswers ? c.summary : null })),
    })),
    totals: e.items.map((item) => {
      const done = classRows.filter(
        (r) => r.cells.find((c) => c.itemId === item.id)?.status === "done",
      ).length;
      const graded = classRows
        .map((r) => r.cells.find((c) => c.itemId === item.id))
        .filter((c) => c?.verdict != null);
      const rate =
        graded.length === 0
          ? null
          : round2(
              graded.reduce(
                (sum, c) => sum + (c!.verdict === "correct" ? 1 : c!.verdict === "partial" ? 0.5 : 0),
                0,
              ) / graded.length,
            );
      return {
        itemId: item.id,
        completion: started === 0 ? 0 : round2(done / started),
        successRate: rate,
        provisional: rate !== null,
      };
    }),
  };
};

export const attemptInspect = (e: MockEvaluation, attemptId: string) => {
  const row = e.rows.find((r) => r.attemptId === attemptId);
  if (!row) throw new MockError(404, "Attempt not found");
  // The seed the row's cells were summarised with (`makeRows`), so the paper
  // read here is the answer the cell's glyph and its tooltip describe.
  const rowIndex = e.rows.indexOf(row);
  return {
    attempt: {
      id: attemptId,
      userId: row.userId,
      displayName: row.displayName,
      pseudonym: row.pseudonym,
      state: row.state,
      startedAt: e.startedAt,
      deadlineAt: row.deadlineAt,
      submittedAt: row.state === "submitted" ? iso(-60_000) : null,
    },
    items: e.items.flatMap((item, i) => {
      const q = itemQuestion(item);
      if (q === null) return [];
      const cell = row.cells.find((c) => c.itemId === item.id);
      return [{
        item: {
          id: item.id,
          position: item.position,
          points: item.points,
          type: item.type,
          internalName: item.internalName,
        },
        studentConfig: studentConfigOf(q),
        answer:
          cell && (cell.status === "in_progress" || cell.status === "done")
            ? answerOf(q, rowIndex + i)
            : null,
        revision: cell?.revision ?? 0,
        markedDone: cell?.status === "done",
        solution: solutionOf(q),
      }];
    }),
    events: [{ kind: "visibility" as const, at: iso(-120_000), details: null }],
    serverNow: iso(0),
  };
};

// --- Routes: evaluations --------------------------------------------------

on("GET", "/app/api/classrooms/:id/evaluations", (m) =>
  evaluations.filter((e) => e.classroomId === m.groups!.id).map(evaluationSummary),
);
on("POST", "/app/api/classrooms/:id/evaluations", (m, body) => {
  const e = makeEvaluation(
    roomOr404(m.groups!.id!).id,
    String(body.title),
    "draft",
    0,
    {
      mode: (body.mode as MockEvaluation["mode"]) ?? "exam",
      // Seeded from the creator's preference, exactly like `createEvaluation`.
      mcqPolicy: me?.mcqPolicy ?? "all_or_nothing",
    },
  );
  evaluations.push(e);
  return toEvaluation(e);
});
on("GET", "/app/api/evaluations/:id", (m) => evaluationDetail(evaluationOr404(m.groups!.id!)));
// The picker's pools: the course's own, like the server (F-EVAL-01).
on("GET", "/app/api/evaluations/:id/pools", (m) => {
  const room = roomOr404(evaluationOr404(m.groups!.id!).classroomId);
  return (coursePools[room.courseId] ?? [])
    .map((id) => poolSummary(poolOr404(id)))
    .sort((a, b) => a.name.localeCompare(b.name));
});
on("PATCH", "/app/api/evaluations/:id", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  // #86: what a patch may touch is the domain's `configLock`, as on the server.
  const lock = configLock(e.state, attemptCountOf(e));
  if (Object.keys(body).some((k) => !isConfigFieldWritable(lock, k))) {
    throw new MockPayload(
      409,
      lock === "running"
        ? {
            error: "running_locked",
            message: "the evaluation is running: its configuration is locked until it closes",
          }
        : { error: "locked", message: "an attempt exists: the structure is frozen" },
    );
  }
  const settings = body.settings as { lobby?: LobbyName } | undefined;
  const feedback = body.feedbackPolicy as { when?: FeedbackWhen } | undefined;
  // F-EVAL-11, #78: the server refuses `immediate` in class, whichever half
  // of the pair the patch moves, and writes nothing.
  if (feedback?.when !== undefined || settings?.lobby !== undefined) {
    const lobby = settings?.lobby ?? (e.settings as { lobby: LobbyName }).lobby;
    const when = feedback?.when ?? (e.feedbackPolicy as { when: FeedbackWhen }).when;
    if (!isFeedbackAllowed({ mode: e.mode, lobby }, when)) {
      throw new MockPayload(422, {
        error: "feedback_not_allowed",
        message: `feedback "${when}" is not allowed for an evaluation sat in class (F-EVAL-11)`,
      });
    }
  }
  if (typeof body.title === "string") e.title = body.title;
  if (body.settings) e.settings = { ...e.settings, ...(body.settings as object) };
  if (body.feedbackPolicy) {
    e.feedbackPolicy = { ...e.feedbackPolicy, ...(body.feedbackPolicy as object) };
  }
  if (body.gradingScale) e.gradingScale = body.gradingScale as Record<string, unknown>;
  if (body.mcqPolicy) e.mcqPolicy = body.mcqPolicy as McqScorePolicy;
  if ("opensAt" in body) e.opensAt = body.opensAt as string | null;
  if ("closesAt" in body) e.closesAt = body.closesAt as string | null;
  if ("durationS" in body) e.durationS = body.durationS as number | null;
  if ("accessCode" in body) e.accessCode = body.accessCode as string | null;
  return evaluationDetail(e);
});
on("DELETE", "/app/api/evaluations/:id", (m) => {
  const i = evaluations.findIndex((e) => e.id === m.groups!.id);
  if (i >= 0) evaluations.splice(i, 1);
  return undefined;
});
on("POST", "/app/api/evaluations/:id/duplicate", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  const copy = makeEvaluation(e.classroomId, String(body.title), "draft", e.items.length, {
    mode: e.mode,
  });
  evaluations.push(copy);
  return toEvaluation(copy);
});
/**
 * The item-list gate of the API (issue #79), with the same codes: the screen
 * disables its controls, and a stale tab that still tries is refused here
 * exactly as it would be for real.
 */
const ATTEMPTS_REFUSAL = {
  locked: "an attempt exists: the structure is frozen",
  attempts_exist: "versions cannot be updated once an attempt exists",
} as const;

function assertItemListEditable(
  e: MockEvaluation,
  onAttempts: keyof typeof ATTEMPTS_REFUSAL = "locked",
): void {
  const lock = itemListLock(e.state, attemptCountOf(e));
  if (lock === "attempts") {
    throw new MockPayload(409, { error: onAttempts, message: ATTEMPTS_REFUSAL[onAttempts] });
  }
  if (lock === "opened") {
    throw new MockPayload(409, {
      error: "items_frozen",
      message: "the evaluation has been opened: its questions are frozen",
    });
  }
}

on("POST", "/app/api/evaluations/:id/items/update-versions", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  assertItemListEditable(e, "attempts_exist");
  const ids = (body.itemIds as string[] | undefined) ?? null;
  for (const item of e.items) {
    if (ids !== null && !ids.includes(item.id)) continue;
    if (item.latestVersionNumber !== null) item.versionNumber = item.latestVersionNumber;
  }
  return e.items.map((i) => ({ ...i }));
});
on("POST", "/app/api/evaluations/:id/items", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  assertItemListEditable(e);
  for (const questionId of (body.questionIds as string[] | undefined) ?? []) {
    const q = questions.find((x) => x.id === questionId);
    const latest = q?.versions.at(-1);
    // A question that was never published cannot be added: the picker shows
    // it disabled, and the API refuses it too (F-EVAL-03).
    if (!q || !latest) continue;
    // A question kept after an opinion poll has no key: polls only.
    if (isKeyless(q)) {
      throw new MockPayload(422, {
        error: "question_keyless",
        message: `question ${q.id} has no correct answer: polls only`,
      });
    }
    e.items.push({
      id: uuid(),
      position: e.items.length + 1,
      points: q.type === "code" ? 3 : 1,
      milestone: false,
      questionId: q.id,
      questionVersionId: uuid(),
      type: q.type,
      internalName: q.internalName,
      versionNumber: latest.number,
      latestVersionNumber: latest.number,
      deprecated: latest.deprecatedAt !== null,
    });
  }
  return e.items.map((i) => ({ ...i }));
});
on("PATCH", "/app/api/evaluations/:id/items/:itemId", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  assertItemListEditable(e);
  const item = e.items.find((i) => i.id === m.groups!.itemId);
  if (!item) throw new MockError(404, "Item not found");
  if (typeof body.points === "number") item.points = body.points;
  if (typeof body.milestone === "boolean") item.milestone = body.milestone;
  return { ...item };
});
on("PUT", "/app/api/evaluations/:id/items/order", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  assertItemListEditable(e);
  const order = (body.itemIds as string[]) ?? [];
  e.items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  e.items.forEach((i, index) => (i.position = index + 1));
  return e.items.map((i) => ({ ...i }));
});
on("DELETE", "/app/api/evaluations/:id/items/:itemId", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  assertItemListEditable(e);
  e.items = e.items.filter((i) => i.id !== m.groups!.itemId);
  e.items.forEach((i, index) => (i.position = index + 1));
  return undefined;
});
on("POST", "/app/api/evaluations/:id/state", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  // The server's two readiness refusals (`guardTransition`), with the same
  // body, so the launch step's translated messages can be seen here (#76).
  if (body.to !== "draft") {
    if (e.items.length === 0) {
      throw new MockPayload(409, {
        error: "illegal_transition",
        message: "an evaluation needs at least one question",
        reason: "no_items",
      });
    }
    const missing = missingTimingFields({
      mode: e.mode,
      timing: (e.settings as { timing: EvaluationTiming }).timing,
      durationS: e.durationS,
      opensAt: e.opensAt,
      closesAt: e.closesAt,
    });
    if (missing.length > 0) {
      throw new MockPayload(409, {
        error: "illegal_transition",
        message: `the timing settings are incomplete (F-EVAL-04): ${missing.join(", ")}`,
        reason: "timing_incomplete",
        missing,
      });
    }
  }
  e.state = body.to as MockEvaluation["state"];
  return toEvaluation(e);
});

/*
 * `POST /questions/move` is a route of section 2, and it is registered here
 * because it is the one pool route that reads the EVALUATIONS playing a
 * question (ADR-017's 409). Keeping it in `pool.ts` would make the pool
 * import the evaluations that are built on top of it.
 */
/**
 * `POST /questions/move` (ADR-017): the question keeps its id and changes
 * pool. The mock reproduces the three refusals the screens branch on — a
 * classroom that plays the question while the target pool is not one of its
 * course's, a course this browser is not staff of, and a name already taken
 * there — because each of them is a different dialog.
 */
on("POST", "/app/api/questions/move", (_m, body) => {
  const ids = ((body.questionIds as string[]) ?? []).filter((id, i, all) => all.indexOf(id) === i);
  const moving = ids.map(questionOr404);
  const target = poolOr404(String(body.targetPoolId));
  const writable = (poolId: string) => poolSummary(poolOr404(poolId)).role !== "reader";
  if (!writable(target.id) || moving.some((q) => !writable(q.poolId))) {
    throw new MockError(403, "Read-only access");
  }
  const categoryId = (body.categoryId as string | null | undefined) ?? null;
  if (categoryId !== null && !categories.some((c) => c.id === categoryId && c.poolId === target.id)) {
    throw new MockError(404, "Category not found");
  }

  // Which courses play one of these questions without drawing from the target.
  const blocking = new Map<string, Record<string, unknown>>();
  for (const evaluation of evaluations) {
    if (!evaluation.items.some((item) => ids.includes(item.questionId))) continue;
    const room = rooms.find((r) => r.id === evaluation.classroomId);
    const course = courses.find((c) => c.id === room?.courseId);
    if (!room || !course) continue;
    if ((coursePools[course.id] ?? []).includes(target.id)) continue;
    const entry = blocking.get(course.id) ?? {
      courseId: course.id,
      courseName: course.name,
      courseCode: course.code,
      classrooms: [] as { id: string; name: string }[],
      mayLink: course.staff.some((s) => s.userId === (me?.id ?? "u-me")),
    };
    const listed = entry.classrooms as { id: string; name: string }[];
    if (!listed.some((x) => x.id === room.id)) listed.push({ id: room.id, name: room.name });
    blocking.set(course.id, entry);
  }
  const blocked = [...blocking.values()];
  let linkedCourseIds: string[] = [];
  if (blocked.length > 0) {
    if (body.linkCourses !== true) {
      throw new MockPayload(409, {
        error: "pool_not_linked",
        message: "This question is used by a classroom whose course does not draw from that pool",
        courses: blocked,
        names: [],
      });
    }
    const forbidden = blocked.filter((c) => c.mayLink !== true);
    if (forbidden.length > 0) {
      throw new MockPayload(409, {
        error: "course_forbidden",
        message: "You are not on the teaching staff of that course",
        courses: forbidden,
        names: [],
      });
    }
    linkedCourseIds = blocked.map((c) => String(c.courseId));
    for (const courseId of linkedCourseIds) {
      coursePools[courseId] = [...new Set([...(coursePools[courseId] ?? []), target.id])];
    }
  }

  const taken = questions
    .filter((q) => q.poolId === target.id && !q.deletedAt && !ids.includes(q.id))
    .map((q) => q.internalName.toLowerCase());
  const clashing = moving
    .filter((q) => taken.includes(q.internalName.toLowerCase()))
    .map((q) => q.internalName);
  if (clashing.length > 0) {
    throw new MockPayload(409, {
      error: "name_taken",
      message: "That internal name is already taken in the target pool",
      courses: [],
      names: clashing,
    });
  }

  for (const q of moving) {
    q.poolId = target.id;
    q.categoryId = categoryId;
    q.updatedAt = iso(0);
  }
  return {
    moved: moving.length,
    questionIds: ids,
    targetPoolId: target.id,
    categoryId,
    linkedCourseIds,
  };
});
