/**
 * The `poll` module's business layer (F-LIVE-13, F-LIVE-14, F-AUTH-05,
 * ADR-014).
 *
 * A poll IS an evaluation of mode `poll` with exactly one item, created and
 * started in one call, whose `access_code` is the six-character session code
 * on the beamer. Everything below the create call reuses the machinery that
 * already exists:
 *   - the attempt, the answer and the autosave gate come from
 *     `modules/live/service.ts` (`ensureAttempt`, `beginAttempt`,
 *     `saveAnswer`), so a poll answer travels the same path as an exam one;
 *   - the question content only ever leaves through `studentView`
 *     (invariant 4), the key only through `solutionView`, and the key only
 *     travels once the teacher revealed;
 *   - the aggregate is the pure rule `pollTally` of `@quiz/domain`.
 *
 * What is new here is the PARTICIPANT, and it depends on the AUDIENCE
 * (ADR-014, addendum 2026-09-27):
 *   - an anonymous poll belongs to no classroom and has no roster. Whoever
 *     holds the code answers — an account, or a browser identified by the
 *     `quiz_guest` cookie and a row in `guest_participants`. Its launcher
 *     owns it (`evaluations.created_by`);
 *   - a classroom's poll is answered by that classroom's roster and staff,
 *     signed in, and by nobody else (the route loads the viewer through
 *     `findReachableEvaluation` before joining or answering).
 */
import { randomBytes, randomInt } from "node:crypto";

import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import {
  POLL_SHORT_CAP,
  type PollAudience,
  type PollPoolPage,
  type PollPoolSearch,
  type PollPublicView,
  type PollQuestionPick,
  type PollSettings,
  type PollSummary,
  type PollTally,
  type PollTeacherView,
} from "@quiz/contracts";
import { pollOutcome, pollTally, type PollRunCounts, type PollType } from "@quiz/domain";

import { iso } from "../../clock.js";
import { isUniqueViolation, type Db } from "../../db/client.js";
import {
  answers,
  attempts,
  classrooms,
  courses,
  enrollments,
  evaluationItems,
  evaluations,
  gradings,
  isOwnedPoll,
  pools,
  questionVersions,
  questions,
} from "../../db/schema.js";
import {
  byId,
  createPollEvaluation,
  joinedItems,
  setPollSettings,
  settingsOf,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import * as live from "../live/service.js";
import { solutionView, studentViewOf } from "../live/studentView.js";
import { hasKey, loadConfig, typeOf } from "../pool/config.js";
import { createUnsavedQuestion, searchReachableQuestions } from "../pool/service.js";
import * as events from "./events.js";

// --- Failures -------------------------------------------------------------

export class PollError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PollError";
  }
}

/** A poll runs `mcq` or `short` and nothing else (contract `PollQuestionType`). */
export class PollTypeRefused extends PollError {
  constructor(type: string) {
    super("poll_type", 422, `a poll cannot run a "${type}" question`);
  }
}

class PollUnpublished extends PollError {
  constructor() {
    super("unpublished", 422, "this question has no published version");
  }
}

// --- The session code -----------------------------------------------------

/**
 * No `I`, `O`, `0` or `1`: the code is read off a beamer at the back of a
 * lecture hall and typed on a phone (F-LIVE-13).
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

/**
 * How long a finished poll still answers on its code. A phone that scanned
 * the QR must keep showing the question and the revealed key while the
 * teacher comments it; two hours later the code is free again. A code is
 * therefore not drawn while a poll can still be reached by it
 * ({@link codeTaken}); the unique index on the running polls is the backstop
 * that makes two concurrent draws of one code safe.
 */
const ENDED_GRACE_MS = 2 * 60 * 60 * 1000;

/** One uniformly drawn session code. Six characters is 32^6 ≈ 10^9 codes. */
export function drawCode(): string {
  // `randomInt`, not `byte % length`: uniform whatever the alphabet's size.
  const draw = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return Array.from({ length: CODE_LENGTH }, draw).join("");
}

/** How many codes `createPoll` draws before giving up; one collision is already rare. */
const CODE_DRAWS = 20;

function stillAddressable(now: Date) {
  return or(
    eq(evaluations.state, "running"),
    gte(evaluations.closedAt, new Date(now.getTime() - ENDED_GRACE_MS)),
  );
}

/** A code is taken while its poll is still reachable by it (see {@link byCode}). */
async function codeTaken(db: Db, code: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: evaluations.id })
    .from(evaluations)
    .where(and(eq(evaluations.mode, "poll"), eq(evaluations.accessCode, code), stillAddressable(now)))
    .limit(1);
  return row !== undefined;
}

// --- Guest identity (F-AUTH-05) ------------------------------------------

export const GUEST_COOKIE = "quiz_guest";
/** The cookie is scoped to the public poll routes and reaches nothing else. */
export const GUEST_COOKIE_PATH = "/app/api/p";
export const GUEST_TTL_S = 12 * 60 * 60;

/**
 * The value that lives in the browser. Never stored server-side: the guest
 * row holds its hash, and that row is the `live` module's (`guestByToken`,
 * `ensureGuest`), which owns `guest_participants`.
 */
export function newGuestToken(): string {
  return randomBytes(32).toString("base64url");
}

// --- Loading a poll -------------------------------------------------------

export interface PollScope {
  evaluation: EvaluationRecord;
  item: JoinedItem;
}

/**
 * The poll's two switches as the views carry them. `anonymous` is DERIVED —
 * a poll is anonymous exactly when it belongs to no classroom — and never
 * read from the stored settings, which keep `revealed` only: one fact, one
 * place (ADR-014, addendum 2026-09-27).
 */
export function pollSettingsOf(evaluation: EvaluationRecord): PollSettings {
  const stored = settingsOf(evaluation).poll;
  return {
    anonymous: isOwnedPoll(evaluation),
    revealed: stored?.revealed ?? false,
    votes: stored?.votes ?? false,
  };
}

/** The classroom a poll is for, or null for anyone with the code. */
export function audienceClassroom(audience: PollAudience): string | null {
  return audience.kind === "classroom" ? audience.classroomId : null;
}

/** The single item of a poll, with its frozen version. */
export async function scopeOf(db: Db, evaluation: EvaluationRecord): Promise<PollScope | null> {
  const items = await joinedItems(db, evaluation.id);
  const item = items[0];
  return item ? { evaluation, item } : null;
}

/** The poll a code names, or null — 404, whatever the reason (invariant 6). */
export async function byCode(
  db: Db,
  code: string,
  now: Date,
): Promise<{ evaluation: EvaluationRecord; state: "running" | "ended" } | null> {
  const [row] = await db
    .select()
    .from(evaluations)
    .where(
      and(
        eq(evaluations.mode, "poll"),
        eq(evaluations.accessCode, code.trim().toUpperCase()),
        stillAddressable(now),
      ),
    )
    .orderBy(desc(evaluations.createdAt))
    .limit(1);
  if (!row) return null;
  return { evaluation: row, state: row.state === "running" ? "running" : "ended" };
}

// --- Creating and running -------------------------------------------------

/** F-LIVE-13: the question is a poll type AND it has a published version. */
async function assertPollable(db: Db, questionId: string): Promise<void> {
  const [question] = await db
    .select()
    .from(questions)
    .where(eq(questions.id, questionId))
    .limit(1);
  if (!question || question.deletedAt !== null) throw new PollError("not_found", 404);
  if (question.type !== "mcq" && question.type !== "short") {
    throw new PollTypeRefused(question.type);
  }
  const [version] = await db
    .select({ id: questionVersions.id })
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, questionId), sql`${questionVersions.number} is not null`))
    .limit(1);
  if (!version) throw new PollUnpublished();
}

/**
 * Creates the poll AND starts it (ADR-014). The evaluation and its single
 * item are written by the `evaluation` module, which owns those tables.
 * `classroomId` null is an anonymous poll, owned by `createdBy`.
 */
export async function createPoll(
  db: Db,
  input: {
    classroomId: string | null;
    questionId: string;
    createdBy: string;
    now: Date;
    /** The code draw, injectable so a test can force a collision. */
    drawCode?: () => string;
  },
): Promise<PollScope> {
  await assertPollable(db, input.questionId);
  const [question] = await db
    .select({ internalName: questions.internalName })
    .from(questions)
    .where(eq(questions.id, input.questionId))
    .limit(1);
  // A code a poll can still be reached by (running, or ended within the
  // grace period) is not drawn. The check alone would race two concurrent
  // creates: the partial unique index on the running polls' codes refuses
  // the second insert, and the draw starts over.
  const draw = input.drawCode ?? drawCode;
  let created: Awaited<ReturnType<typeof createPollEvaluation>> | undefined;
  for (let n = 0; created === undefined; n += 1) {
    if (n === CODE_DRAWS) {
      throw new PollError("code_exhausted", 503, "could not draw a free session code");
    }
    const code = draw();
    if (await codeTaken(db, code, input.now)) continue;
    try {
      created = await createPollEvaluation(db, {
        classroomId: input.classroomId,
        title: question?.internalName ?? "Poll",
        createdBy: input.createdBy,
        questionId: input.questionId,
        accessCode: code,
        defaultPoints: (type, version) =>
          typeOf(type).defaultPoints(
            loadConfig(type, { config: version.config, configVersion: version.configVersion }),
          ),
        now: input.now,
      });
    } catch (err) {
      if (!isUniqueViolation(err, "evaluations_running_poll_code_uq")) throw err;
    }
  }
  const scope = await scopeOf(db, created.evaluation);
  if (!scope) throw new PollError("internal_error", 500, "poll item vanished after insert");
  events.pollStarted(scope.evaluation, input.now);
  return scope;
}

/**
 * A poll on a question written in the launcher and never saved (ADR-014,
 * addendum 2026-09-23). The `pool` module writes the question — its tables —
 * as a pool-less question with one published version, validated by the
 * type's own schema; from there on it is an ordinary poll, frozen on that
 * version, and "run again" reuses it like any other.
 */
export async function createInlinePoll(
  db: Db,
  input: {
    classroomId: string | null;
    type: string;
    config: unknown;
    createdBy: string;
    now: Date;
    drawCode?: () => string;
  },
): Promise<PollScope> {
  if (input.type !== "mcq" && input.type !== "short") throw new PollTypeRefused(input.type);
  const { questionId } = await createUnsavedQuestion(db, {
    type: input.type,
    config: input.config,
    createdBy: input.createdBy,
    now: input.now,
  });
  return createPoll(db, {
    classroomId: input.classroomId,
    questionId,
    createdBy: input.createdBy,
    now: input.now,
    ...(input.drawCode ? { drawCode: input.drawCode } : {}),
  });
}

/**
 * The reveal (F-LIVE-13). ONE fact, written in two places on purpose:
 * `settings.poll.revealed` is what the projection and the phones read, and
 * `feedbackPolicy.showKey` is what the ordinary feedback route of a signed-in
 * participant obeys. Leaving the second one behind would publish the key to
 * `GET /attempts/:id/feedback` before the teacher revealed anything.
 *
 * `votes` is the projection's own switch (#157): the distribution on the
 * wall. Omitted, it stays as it was. It never reaches a phone — only the
 * reveal does (`publicView`).
 */
export async function setRevealed(
  db: Db,
  evaluation: EvaluationRecord,
  revealed: boolean,
  now: Date,
  votes?: boolean,
): Promise<EvaluationRecord> {
  const settings = settingsOf(evaluation);
  const feedbackPolicy = {
    ...(evaluation.feedbackPolicy as Record<string, unknown>),
    showKey: revealed,
    showExplanation: revealed,
  };
  await setPollSettings(
    db,
    evaluation.id,
    {
      settings: {
        ...settings,
        poll: {
          revealed,
          votes: votes === undefined ? pollSettingsOf(evaluation).votes : votes,
        },
      },
      feedbackPolicy,
    },
    now,
  );
  const row = (await byId(db, evaluation.id))!;
  events.pollChanged(row);
  return row;
}

/**
 * The end of a poll: the attempts are expired, the state moves to `closed`
 * and the deterministic grading pass runs — exactly what `closeEvaluation`
 * does for every other evaluation. It stops THERE and does not release
 * (ADR-014): a release writes a frozen grade for every student of the
 * classroom, including the ones who never saw the poll, and makes a 1.0
 * appear on their results page.
 */
export async function endPoll(
  app: FastifyInstance,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<EvaluationRecord> {
  if (evaluation.state !== "running") return evaluation;
  const closed = await live.closeEvaluation(app.db, evaluation, now, "teacher", app);
  await emitTally(app.db, closed, now);
  return closed;
}

// --- Participation --------------------------------------------------------

export interface Viewer {
  userId: string | null;
  guestId: string | null;
}

/** The attempt of THIS browser, or null when it has not joined. */
export async function attemptOfViewer(
  db: Db,
  evaluation: EvaluationRecord,
  viewer: Viewer,
): Promise<live.AttemptRecord | null> {
  if (viewer.userId === null && viewer.guestId === null) return null;
  return live.attemptOf(db, evaluation.id, {
    userId: viewer.userId,
    guestId: viewer.guestId,
    timeBonusPercent: 0,
  });
}

/**
 * Joining: an attempt, started. `participantOf` is bypassed for a poll on
 * purpose (ADR-014): a guest has no seat, and a staff member trying the poll
 * holds none either. WHO may join is the route's loader: anyone with the code
 * for an anonymous poll (F-AUTH-05), the roster and the staff for a
 * classroom's (addendum 2026-09-27).
 */
export async function join(
  db: Db,
  evaluation: EvaluationRecord,
  viewer: Viewer,
  now: Date,
): Promise<live.AttemptRecord> {
  const participant: live.Participant = { ...viewer, timeBonusPercent: 0 };
  const attempt = await live.ensureAttempt(db, evaluation, participant, now);
  const started = await live.beginAttempt(db, evaluation, attempt, participant, now);
  await emitTally(db, evaluation, now);
  return started;
}

/**
 * One answer, through the ordinary autosave gate: the type's `answerSchema`
 * validates it, the deadline rule refuses it once the poll is over, and the
 * revision is the stored one plus one — a participant may change their mind
 * until the end, and the change replaces their vote rather than adding one.
 */
export async function answerPoll(
  db: Db,
  scope: PollScope,
  attempt: live.AttemptRecord,
  payload: unknown,
  now: Date,
): Promise<{ revision: number }> {
  const stored = await db
    .select({ revision: answers.revision })
    .from(answers)
    .where(and(eq(answers.attemptId, attempt.id), eq(answers.itemId, scope.item.item.id)))
    .limit(1);
  const revision = (stored[0]?.revision ?? 0) + 1;
  const saved = await live.saveAnswer(db, {
    evaluation: scope.evaluation,
    attempt,
    itemId: scope.item.item.id,
    payload,
    revision,
    now,
  });
  await emitTally(db, scope.evaluation, now);
  return { revision: saved.revision };
}

// --- The aggregate --------------------------------------------------------

/** The counts the projection draws, computed the same way for both exits. */
export async function tallyOf(db: Db, evaluation: EvaluationRecord): Promise<PollTally> {
  const scope = await scopeOf(db, evaluation);
  if (!scope) return { joined: 0, answered: 0, choices: [], answers: [] };
  const [[joined], payloads] = await Promise.all([
    db
      .select({ n: count() })
      .from(attempts)
      .where(eq(attempts.evaluationId, evaluation.id)),
    db
      .select({ payload: answers.payload })
      .from(answers)
      .innerJoin(attempts, eq(answers.attemptId, attempts.id))
      .where(
        and(eq(attempts.evaluationId, evaluation.id), eq(answers.itemId, scope.item.item.id)),
      ),
  ]);
  const type = scope.item.question.type as PollType;
  let choiceCount = 0;
  if (type === "mcq") {
    const config = loadConfig(type, {
      config: scope.item.version.config,
      configVersion: scope.item.version.configVersion,
    }) as { choices?: unknown[] };
    choiceCount = Array.isArray(config.choices) ? config.choices.length : 0;
  }
  return pollTally({
    type,
    choiceCount,
    joined: joined?.n ?? 0,
    payloads: payloads.map((r) => r.payload),
    shortCap: POLL_SHORT_CAP,
  });
}

/** The tally, out on `evaluation:<id>`, staff only, coalesced 500 ms. */
async function emitTally(
  db: Db,
  evaluation: EvaluationRecord,
  now: Date,
): Promise<void> {
  events.tallyChanged(evaluation.id, await tallyOf(db, evaluation), now);
}

// --- The two views --------------------------------------------------------

/**
 * THE content exit of this module (invariant 4): every poll payload a
 * participant or a projection sees is built here, by `studentView`.
 *
 * A poll never shuffles — everyone in the room reads the same screen as the
 * beamer, and the tally is labelled by canonical choice index — so the seed
 * is fixed and the shuffle is off.
 */
function studentPayload(
  type: string,
  version: { config: unknown; configVersion: number },
  itemId: string,
): unknown {
  return studentViewOf(type, loadConfig(type, version), { seed: 0, itemId, shuffle: false });
}

function studentOf(item: JoinedItem): unknown {
  return studentPayload(
    item.question.type,
    { config: item.version.config, configVersion: item.version.configVersion },
    item.item.id,
  );
}

function solutionOf(item: JoinedItem): unknown {
  return solutionView({
    type: item.question.type,
    version: { config: item.version.config, configVersion: item.version.configVersion },
    seed: 0,
    itemId: item.item.id,
  });
}

/**
 * Where the poll lives: the classroom and its course, in one join. The
 * projection prints them in its context line, so the screen never has to ask
 * a second route for a name it already implies.
 */
async function homeOf(
  db: Db,
  classroomId: string | null,
): Promise<{ classroomName: string | null; courseName: string | null }> {
  // An anonymous poll lives nowhere: the projection says who may answer.
  if (classroomId === null) return { classroomName: null, courseName: null };
  const [row] = await db
    .select({ classroomName: classrooms.name, courseName: courses.name })
    .from(classrooms)
    .innerJoin(courses, eq(courses.id, classrooms.courseId))
    .where(eq(classrooms.id, classroomId))
    .limit(1);
  return row ?? { classroomName: null, courseName: null };
}

/**
 * The teacher's screen. `pool` is the pool holding the question when the
 * CALLER can open it (the route loads it through the pool predicate); a
 * colleague's private pool is not named to them.
 */
export async function teacherView(
  db: Db,
  scope: PollScope,
  webUrl: string,
  pool: { id: string; name: string } | null = null,
): Promise<PollTeacherView> {
  const { evaluation, item } = scope;
  const [home, tally] = await Promise.all([
    homeOf(db, evaluation.classroomId),
    tallyOf(db, evaluation),
  ]);
  return {
    evaluation: {
      id: evaluation.id,
      classroomId: evaluation.classroomId,
      classroomName: home.classroomName,
      courseName: home.courseName,
      title: evaluation.title,
      state: evaluation.state,
      code: evaluation.accessCode ?? "",
      createdAt: iso(evaluation.createdAt),
    },
    joinUrl: joinUrl(webUrl, evaluation.accessCode ?? ""),
    settings: pollSettingsOf(evaluation),
    question: {
      id: item.question.id,
      type: item.question.type as PollType,
      student: studentOf(item),
      // The teacher's own screen: the key is theirs whether or not the room
      // has seen it, and the projection decides when to draw it.
      solution: solutionOf(item),
      saved: item.question.poolId !== null,
      pool,
    },
    tally,
  };
}

export function joinUrl(webUrl: string, code: string): string {
  return `${webUrl.replace(/\/+$/, "")}/p/${code}`;
}

/**
 * What a phone reads at `/p/:code`. The question travels through
 * `studentView` like every other student payload (invariant 4), and the
 * solution only once the teacher revealed it.
 */
export async function publicView(
  db: Db,
  scope: PollScope,
  state: "running" | "ended",
  viewer: Viewer & { loggedIn: boolean },
): Promise<PollPublicView> {
  const { evaluation, item } = scope;
  const settings = pollSettingsOf(evaluation);
  const attempt = await attemptOfViewer(db, evaluation, viewer);
  const answer =
    attempt === null
      ? null
      : ((
          await db
            .select({ payload: answers.payload })
            .from(answers)
            .where(and(eq(answers.attemptId, attempt.id), eq(answers.itemId, item.item.id)))
            .limit(1)
        )[0]?.payload ?? null);
  return {
    code: evaluation.accessCode ?? "",
    title: evaluation.title,
    state,
    settings,
    question: { type: item.question.type as PollType, student: studentOf(item) },
    solution: settings.revealed ? solutionOf(item) : null,
    tally: settings.revealed ? await tallyOf(db, evaluation) : null,
    me: {
      identified: viewer.userId !== null || viewer.guestId !== null,
      loginRequired: !viewer.loggedIn && !settings.anonymous,
      joined: attempt !== null,
      answer,
    },
  };
}

// --- The launcher ---------------------------------------------------------

/**
 * The people a run was addressed to: its classroom's roster (staff seats
 * excluded), or NONE for an anonymous poll. Since the audience addendum
 * (2026-09-27) an anonymous poll IS a classroom-less one; both tests stay,
 * because a poll run before it may still carry a classroom and the stored
 * flag is gone — `anonymous` is derived from the classroom.
 */
function rosterOfRun(
  anonymous: boolean,
  classroomId: string | null,
  rosters: ReadonlyMap<string, number>,
): number | null {
  if (anonymous || classroomId === null) return null;
  return rosters.get(classroomId) ?? 0;
}

/**
 * The launcher's "Recent polls" (issue #161, ADR-014 addendum 2026-09-27):
 * the questions of the polls the caller LAUNCHED, one row per question, most
 * recent run first, each with the outcome of its last runs (`pollOutcome` of
 * `@quiz/domain`); then the published questions of their personal pool that
 * never ran, most recently edited first.
 *
 * A question written in the launcher and never kept (`pool_id` null) is
 * listed like any other: the caller ran it, and relaunching it reuses the
 * same row (`findOwnUnsavedPollQuestion` in the guards). A pool question is
 * listed only while `poolWhere` — the caller's `poolAccess`, `undefined` for
 * an admin — still lets them reach it, so every row can be relaunched.
 *
 * "Used" is read from the poll evaluations that froze a version of the
 * question; no column is added to `questions` for it.
 */
export async function questionPicks(
  db: Db,
  input: { userId: string; poolWhere: SQL | undefined },
): Promise<PollQuestionPick[]> {
  const runRows = await db
    .select({
      evaluation: evaluations,
      questionId: questionVersions.questionId,
      config: questionVersions.config,
      configVersion: questionVersions.configVersion,
    })
    .from(evaluations)
    .innerJoin(evaluationItems, eq(evaluationItems.evaluationId, evaluations.id))
    .innerJoin(questionVersions, eq(questionVersions.id, evaluationItems.questionVersionId))
    .where(and(eq(evaluations.mode, "poll"), eq(evaluations.createdBy, input.userId)))
    .orderBy(desc(evaluations.createdAt));

  const personal = await db
    .select({ id: questions.id })
    .from(questions)
    .innerJoin(pools, eq(pools.id, questions.poolId))
    .where(and(eq(pools.ownerId, input.userId), eq(pools.isPersonal, true)));

  const candidates = [...new Set([...runRows.map((r) => r.questionId), ...personal.map((p) => p.id)])];
  if (candidates.length === 0) return [];

  const rows = await db
    .select({ question: questions })
    .from(questions)
    .leftJoin(pools, eq(pools.id, questions.poolId))
    .where(
      and(
        inArray(questions.id, candidates),
        inArray(questions.type, ["mcq", "short"]),
        isNull(questions.deletedAt),
        input.poolWhere === undefined ? undefined : or(isNull(questions.poolId), input.poolWhere),
      ),
    );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.question.id);
  const typeById = new Map(rows.map((r) => [r.question.id, r.question.type] as const));

  const versions = await db
    .select()
    .from(questionVersions)
    .where(and(inArray(questionVersions.questionId, ids), isNotNull(questionVersions.number)))
    .orderBy(asc(questionVersions.questionId), desc(questionVersions.number));
  const latest = new Map<string, (typeof versions)[number]>();
  for (const version of versions) if (!latest.has(version.questionId)) latest.set(version.questionId, version);

  // What each FINISHED run counts: its answers, the answers the grading pass
  // gave full marks (validated gradings only), and its roster. A running
  // poll is still moving and is not a result yet.
  const runs = runRows.filter((r) => typeById.has(r.questionId));
  const finished = runs.filter((r) => r.evaluation.state !== "running");
  const finishedIds = finished.map((r) => r.evaluation.id);
  // An anonymous poll has no classroom, and so no roster to count.
  const classroomIds = [
    ...new Set(
      finished.flatMap((r) => (r.evaluation.classroomId === null ? [] : [r.evaluation.classroomId])),
    ),
  ];
  const [answeredRows, gradedRows, rosterRows] =
    finishedIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          db
            .select({ evaluationId: attempts.evaluationId, n: count() })
            .from(answers)
            .innerJoin(attempts, eq(answers.attemptId, attempts.id))
            .where(inArray(attempts.evaluationId, finishedIds))
            .groupBy(attempts.evaluationId),
          db
            .select({
              evaluationId: attempts.evaluationId,
              graded: count(),
              correct: sql<number>`(count(*) filter (where ${gradings.maxPoints} > 0 and ${gradings.points} >= ${gradings.maxPoints}))::int`,
            })
            .from(gradings)
            .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
            .where(
              and(
                inArray(attempts.evaluationId, finishedIds),
                eq(gradings.state, "validated"),
                isNotNull(gradings.answerId),
              ),
            )
            .groupBy(attempts.evaluationId),
          db
            .select({ classroomId: enrollments.classroomId, n: count() })
            .from(enrollments)
            .where(and(inArray(enrollments.classroomId, classroomIds), eq(enrollments.staff, false)))
            .groupBy(enrollments.classroomId),
        ]);
  const answeredOf = new Map(answeredRows.map((r) => [r.evaluationId, r.n]));
  const gradedOf = new Map(gradedRows.map((r) => [r.evaluationId, r]));
  const rosters = new Map(rosterRows.map((r) => [r.classroomId, r.n]));

  const usage = new Map<string, { lastUsedAt: Date; useCount: number; counts: PollRunCounts[] }>();
  for (const run of runs) {
    let entry = usage.get(run.questionId);
    if (!entry) {
      // Newest first: the first run seen is the last one.
      entry = { lastUsedAt: run.evaluation.createdAt, useCount: 0, counts: [] };
      usage.set(run.questionId, entry);
    }
    entry.useCount += 1;
    if (run.evaluation.state === "running") continue;
    const type = typeById.get(run.questionId)!;
    const keyed = hasKey(type, loadConfig(type, { config: run.config, configVersion: run.configVersion }));
    const answered = answeredOf.get(run.evaluation.id) ?? 0;
    const graded = gradedOf.get(run.evaluation.id);
    entry.counts.push({
      keyed,
      answered,
      // Nobody answered: nothing to grade, and zero is the truth. Otherwise
      // a run the grading pass has not reached is no result yet.
      correct: answered === 0 ? 0 : graded ? graded.correct : null,
      roster: rosterOfRun(
        pollSettingsOf(run.evaluation).anonymous,
        run.evaluation.classroomId,
        rosters,
      ),
    });
  }

  const picks: PollQuestionPick[] = [];
  for (const { question } of rows) {
    const version = latest.get(question.id);
    if (!version) continue; // a draft-only question is not runnable (F-EVAL-03)
    const stats = usage.get(question.id);
    const student = studentPayload(
      question.type,
      { config: version.config, configVersion: version.configVersion },
      question.id,
    ) as { prompt?: unknown };
    picks.push({
      id: question.id,
      type: question.type as PollType,
      internalName: question.internalName,
      prompt: typeof student.prompt === "string" ? student.prompt : "",
      lastUsedAt: stats ? iso(stats.lastUsedAt) : null,
      useCount: stats?.useCount ?? 0,
      saved: question.poolId !== null,
      outcome: pollOutcome(stats?.counts ?? []),
    });
  }
  // The last run first; the questions that never ran after them, the most
  // recently edited first.
  const touchedAt = new Map(
    rows.map((r) => [r.question.id, r.question.updatedAt.toISOString()] as const),
  );
  return picks.sort((a, b) => {
    if ((a.lastUsedAt === null) !== (b.lastUsedAt === null)) return a.lastUsedAt === null ? 1 : -1;
    const ka = a.lastUsedAt ?? touchedAt.get(a.id) ?? "";
    const kb = b.lastUsedAt ?? touchedAt.get(b.id) ?? "";
    if (ka === kb) return a.internalName.localeCompare(b.internalName);
    return ka < kb ? 1 : -1;
  });
}

/** The types a poll runs, as the search across pools restricts them. */
const POLLABLE_TYPES: readonly PollType[] = ["mcq", "short"];

/**
 * The launcher's "From pools" (issue #162): the pool screen's search over
 * every pool the caller reaches — `poolWhere`, their pool predicate — or,
 * with `courseId`, over the pools linked to that course. A poll is not
 * graded, so any reachable pool may lend it a question; `POST /polls` loads
 * the question through the same pool predicate. The statement is the one the
 * student would see, through `toStudent` like every other poll payload.
 */
export async function poolQuestionPage(
  db: Db,
  input: { poolWhere: SQL | undefined; courseId: string | null; search: PollPoolSearch },
): Promise<PollPoolPage> {
  const found = await searchReachableQuestions(db, {
    poolWhere: input.poolWhere,
    courseId: input.courseId,
    types: POLLABLE_TYPES,
    search: input.search,
  });
  return {
    items: found.items.map(({ question, pool, tags, latestNumber, latest }) => {
      let prompt = "";
      try {
        const student = studentPayload(question.type, latest, question.id) as { prompt?: unknown };
        if (typeof student.prompt === "string") prompt = student.prompt;
      } catch {
        // A version that no longer parses still shows its name; `POST /polls`
        // is where it would be refused.
      }
      return {
        id: question.id,
        type: question.type as PollType,
        internalName: question.internalName,
        prompt,
        pool,
        tags,
        difficulty: question.difficulty,
        latestNumber,
      };
    }),
    nextCursor: found.nextCursor,
    total: found.total,
    tags: found.tags,
  };
}

/** The teacher's own polls, newest first — "run again" reads this. */
export async function listPolls(db: Db, userId: string, limit = 50): Promise<PollSummary[]> {
  const rows = await db
    .select({
      evaluation: evaluations,
      item: evaluationItems,
      question: questions,
    })
    .from(evaluations)
    .innerJoin(evaluationItems, eq(evaluationItems.evaluationId, evaluations.id))
    .innerJoin(questionVersions, eq(questionVersions.id, evaluationItems.questionVersionId))
    .innerJoin(questions, eq(questions.id, questionVersions.questionId))
    .where(and(eq(evaluations.mode, "poll"), eq(evaluations.createdBy, userId)))
    .orderBy(desc(evaluations.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];

  const counts = await db
    .select({ evaluationId: attempts.evaluationId, n: count() })
    .from(answers)
    .innerJoin(attempts, eq(answers.attemptId, attempts.id))
    .where(
      inArray(
        attempts.evaluationId,
        rows.map((r) => r.evaluation.id),
      ),
    )
    .groupBy(attempts.evaluationId);
  const answered = new Map(counts.map((c) => [c.evaluationId, c.n]));

  return rows.map((row) => ({
    id: row.evaluation.id,
    classroomId: row.evaluation.classroomId,
    title: row.evaluation.title,
    state: row.evaluation.state,
    code: row.evaluation.accessCode,
    questionId: row.question.id,
    questionType: row.question.type as PollSummary["questionType"],
    answered: answered.get(row.evaluation.id) ?? 0,
    createdAt: iso(row.evaluation.createdAt),
  }));
}
