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
 * What is new here is the PARTICIPANT: a poll has no roster. Whoever holds
 * the code answers — an account, or (when the poll is anonymous) a browser
 * identified by the `quiz_guest` cookie and a row in `guest_participants`.
 */
import { randomBytes } from "node:crypto";

import { and, asc, count, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import {
  POLL_SHORT_CAP,
  type PollPublicView,
  type PollQuestionPick,
  type PollSettings,
  type PollSummary,
  type PollTally,
  type PollTeacherView,
} from "@quiz/contracts";
import { pollTally, type PollType } from "@quiz/domain";

import { iso } from "../../clock.js";
import { isUniqueViolation, type Db } from "../../db/client.js";
import {
  answers,
  attempts,
  classrooms,
  courses,
  evaluationItems,
  evaluations,
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
import { loadConfig, typeOf } from "../pool/config.js";
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
 * teacher comments it; two hours later the code no longer answers. Only
 * the running polls hold their code exclusively (the unique index); should a
 * new poll draw the code of one in its grace period — one chance in 10^9 —
 * {@link byCode} answers with the newer one.
 */
const ENDED_GRACE_MS = 2 * 60 * 60 * 1000;

/** One uniformly drawn session code. Six characters is 32^6 ≈ 10^9 codes. */
export function drawCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

/** How many codes `createPoll` draws before giving up; one collision is already rare. */
const CODE_DRAWS = 20;

function stillAddressable(now: Date) {
  return or(
    eq(evaluations.state, "running"),
    gte(evaluations.closedAt, new Date(now.getTime() - ENDED_GRACE_MS)),
  );
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

export function pollSettingsOf(evaluation: EvaluationRecord): PollSettings {
  const settings = settingsOf(evaluation);
  return settings.poll ?? { anonymous: false, revealed: false };
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

/** The teacher-side loader: an evaluation that is a poll, or nothing. */
export async function pollById(db: Db, evaluationId: string): Promise<EvaluationRecord | null> {
  const row = await byId(db, evaluationId);
  return row && row.mode === "poll" ? row : null;
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
 */
export async function createPoll(
  db: Db,
  input: {
    classroomId: string;
    questionId: string;
    anonymous: boolean;
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
  // No check-then-insert: the partial unique index on the codes of the
  // running polls refuses a collision, even between two concurrent creates,
  // and the draw starts over.
  const draw = input.drawCode ?? drawCode;
  let created: Awaited<ReturnType<typeof createPollEvaluation>> | undefined;
  for (let n = 0; created === undefined; n += 1) {
    if (n === CODE_DRAWS) {
      throw new PollError("code_exhausted", 503, "could not draw a free session code");
    }
    try {
      created = await createPollEvaluation(db, {
        classroomId: input.classroomId,
        title: question?.internalName ?? "Poll",
        createdBy: input.createdBy,
        questionId: input.questionId,
        accessCode: draw(),
        anonymous: input.anonymous,
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
 * The reveal (F-LIVE-13). ONE fact, written in two places on purpose:
 * `settings.poll.revealed` is what the projection and the phones read, and
 * `feedbackPolicy.showKey` is what the ordinary feedback route of a signed-in
 * participant obeys. Leaving the second one behind would publish the key to
 * `GET /attempts/:id/feedback` before the teacher revealed anything.
 */
export async function setRevealed(
  db: Db,
  evaluation: EvaluationRecord,
  revealed: boolean,
  now: Date,
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
    { settings: { ...settings, poll: { ...pollSettingsOf(evaluation), revealed } }, feedbackPolicy },
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
 * Joining: an attempt, started. No roster seat is consulted — `participantOf`
 * is bypassed for a poll on purpose (ADR-014): whoever holds the code takes
 * part, which is the whole point of F-AUTH-05.
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
  classroomId: string,
): Promise<{ classroomName: string; courseName: string }> {
  const [row] = await db
    .select({ classroomName: classrooms.name, courseName: courses.name })
    .from(classrooms)
    .innerJoin(courses, eq(courses.id, classrooms.courseId))
    .where(eq(classrooms.id, classroomId))
    .limit(1);
  return row ?? { classroomName: "", courseName: "" };
}

export async function teacherView(
  db: Db,
  scope: PollScope,
  webUrl: string,
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
 * The pollable questions of one pool, most recently USED first and never
 * used last. "Used" is read from the poll evaluations that froze a version
 * of the question — no column is added to `questions` for it.
 */
export async function questionPicks(db: Db, poolId: string): Promise<PollQuestionPick[]> {
  const rows = await db
    .select({ question: questions })
    .from(questions)
    .where(
      and(
        eq(questions.poolId, poolId),
        inArray(questions.type, ["mcq", "short"]),
        sql`${questions.deletedAt} is null`,
      ),
    )
    .orderBy(asc(questions.internalName));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.question.id);

  const versions = await db
    .select()
    .from(questionVersions)
    .where(and(inArray(questionVersions.questionId, ids), sql`${questionVersions.number} is not null`))
    .orderBy(asc(questionVersions.questionId), desc(questionVersions.number));
  const latest = new Map<string, (typeof versions)[number]>();
  for (const version of versions) if (!latest.has(version.questionId)) latest.set(version.questionId, version);

  const usage = await db
    .select({
      questionId: questionVersions.questionId,
      lastUsedAt: sql<Date | null>`max(${evaluations.createdAt})`,
      useCount: count(),
    })
    .from(evaluationItems)
    .innerJoin(evaluations, eq(evaluations.id, evaluationItems.evaluationId))
    .innerJoin(questionVersions, eq(questionVersions.id, evaluationItems.questionVersionId))
    .where(and(eq(evaluations.mode, "poll"), inArray(questionVersions.questionId, ids)))
    .groupBy(questionVersions.questionId);
  const used = new Map(usage.map((u) => [u.questionId, u]));

  const picks: PollQuestionPick[] = [];
  for (const { question } of rows) {
    const version = latest.get(question.id);
    if (!version) continue; // a draft-only question is not runnable (F-EVAL-03)
    const stats = used.get(question.id);
    const student = studentPayload(
      question.type,
      { config: version.config, configVersion: version.configVersion },
      question.id,
    ) as { prompt?: unknown };
    const lastUsedAt = stats?.lastUsedAt ? new Date(stats.lastUsedAt) : null;
    picks.push({
      id: question.id,
      type: question.type as PollType,
      internalName: question.internalName,
      prompt: typeof student.prompt === "string" ? student.prompt : "",
      lastUsedAt: lastUsedAt === null ? null : iso(lastUsedAt),
      useCount: stats?.useCount ?? 0,
    });
  }
  // Most recently TOUCHED first: the last run when there was one, else the
  // last edit. A question published a minute ago has never run, and it is
  // the one the teacher came back to the launcher for — it must be on top,
  // not under every question that ever ran (the create-then-return flow of
  // the launcher relies on this and on nothing else).
  const touchedAt = new Map(
    rows.map((r) => [r.question.id, r.question.updatedAt.toISOString()] as const),
  );
  const keyOf = (pick: PollQuestionPick) => pick.lastUsedAt ?? touchedAt.get(pick.id) ?? "";
  return picks.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka === kb) return a.internalName.localeCompare(b.internalName);
    return ka < kb ? 1 : -1;
  });
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
