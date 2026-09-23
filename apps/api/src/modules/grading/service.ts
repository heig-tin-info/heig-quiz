/**
 * The `grading` module's business layer (PLAN-MVP §4.5 and §5.4).
 *
 * The invariants this file exists to hold:
 *
 *   - ONE writer. Every grading, whoever produced it — the job, a teacher
 *     validating a proposal, a manual override, a regrade — goes through
 *     {@link writeGrading}, which supersedes the previous one and links to it
 *     in a single transaction. The partial unique index of `db/grading.ts`
 *     makes a concurrent double-write fail loudly rather than silently
 *     producing two grades for one answer;
 *   - a manual override always wins and always carries a comment (F-GRADE-05);
 *   - nothing here reads the wall clock: `now` is always the caller's, which
 *     took it from `app.clock` (invariant 5);
 *   - a student payload is still only ever produced by
 *     `modules/live/studentView.ts` (invariant 4), including in the panel.
 */
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import type {
  Grading,
  GradingEntry,
  GradingHistoryEntry,
  GradingProgress,
  GradingQuery,
  GradingQueue,
  GradingSource,
  GradingState,
  Verdict,
} from "@quiz/contracts";
import { round2, uniquePseudonyms } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { answers, attempts, gradings, users } from "../../db/schema.js";
import {
  joinedItems,
  staffAttemptIds,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { solutionView, studentView } from "../live/studentView.js";

export type GradingRecord = typeof gradings.$inferSelect;

/**
 * "Newest first", made total. Two gradings written in the same millisecond —
 * the automatic pass and the override a teacher pressed right after it, on a
 * clock a test holds still — would otherwise come back in an arbitrary order.
 * A superseded grading is never newer than the one that replaced it, so that
 * is the tiebreaker.
 */
const NEWEST_FIRST = [
  desc(gradings.gradedAt),
  sql`case when ${gradings.state} = 'superseded' then 1 else 0 end`,
] as const;

// --- Failures -------------------------------------------------------------

export class GradingError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "GradingError";
  }
}

/** F-GRADE-05: overriding a correction without saying why is not allowed. */
export class CommentRequired extends GradingError {
  constructor() {
    super("comment_required", 422, "a manual override must carry a comment");
  }
}

class NotPending extends GradingError {
  constructor() {
    super("not_pending", 409, "this grading is not a proposal any more");
  }
}

// --- Keys -----------------------------------------------------------------

/** A grading addresses a CELL of the grid, not an answer: an absent answer is graded too. */
export type PairKey = `${string}:${string}`;
export const pairKey = (attemptId: string, itemId: string): PairKey =>
  `${attemptId}:${itemId}`;

// --- The single writer ----------------------------------------------------

interface WriteGradingInput {
  attemptId: string;
  itemId: string;
  /** Null when the student never answered (F-GRADE-01). */
  answerId: string | null;
  points: number;
  maxPoints: number;
  source: GradingSource;
  state: Exclude<GradingState, "superseded">;
  details?: unknown;
  confidence?: "low" | "medium" | "high" | undefined;
  comment?: string | undefined;
  gradedBy?: string | undefined;
  regradeNote?: string | undefined;
  now: Date;
}

/**
 * THE write (§5.4). In one transaction:
 *
 * ```sql
 * UPDATE gradings SET state='superseded' WHERE <cell> AND state <> 'superseded';
 * INSERT INTO gradings (…, supersedes_id = <the one just superseded>) VALUES (…);
 * ```
 *
 * A new `validated` grading supersedes everything still standing. A new
 * `proposed` one only supersedes a previous PROPOSAL: a proposal must never
 * quietly unseat a grade a teacher already validated, and the callers that
 * produce proposals skip a validated cell anyway (idempotency).
 */
export async function writeGrading(db: Db, input: WriteGradingInput): Promise<GradingRecord> {
  const id = randomUUID();
  return db.transaction(async (tx) => {
    const target =
      input.state === "validated"
        ? ne(gradings.state, "superseded")
        : eq(gradings.state, "proposed");
    const superseded = await tx
      .update(gradings)
      .set({ state: "superseded" })
      .where(
        and(
          eq(gradings.attemptId, input.attemptId),
          eq(gradings.itemId, input.itemId),
          target,
        ),
      )
      .returning({ id: gradings.id, state: gradings.state });
    // The chain points at the grading this one REPLACES; when several were
    // still standing (a proposal next to nothing else), the newest wins.
    const previous = superseded.at(-1)?.id ?? null;
    const [row] = await tx
      .insert(gradings)
      .values({
        id,
        answerId: input.answerId,
        attemptId: input.attemptId,
        itemId: input.itemId,
        points: round2(input.points),
        maxPoints: round2(input.maxPoints),
        source: input.source,
        state: input.state,
        details: input.details ?? null,
        confidence: input.confidence ?? null,
        comment: input.comment ?? null,
        gradedBy: input.gradedBy ?? null,
        gradedAt: input.now,
        supersedesId: previous,
        regradeNote: input.regradeNote ?? null,
        createdAt: input.now,
      })
      .returning();
    return row!;
  });
}

// --- Reads ----------------------------------------------------------------

export const toGrading = (row: GradingRecord): Grading => ({
  id: row.id,
  answerId: row.answerId,
  attemptId: row.attemptId,
  itemId: row.itemId,
  points: row.points,
  maxPoints: row.maxPoints,
  source: row.source,
  state: row.state,
  details: row.details ?? null,
  confidence: row.confidence,
  comment: row.comment,
  gradedBy: row.gradedBy,
  gradedAt: iso(row.gradedAt),
  supersedesId: row.supersedesId,
  regradeNote: row.regradeNote,
});

/** The verdict a grid cell shows (F-DASH-01, F-RES-04). */
export function verdictOf(row: Pick<GradingRecord, "points" | "maxPoints" | "state">): Verdict {
  if (row.state === "proposed") return "pending";
  if (row.maxPoints > 0 && row.points >= row.maxPoints) return "correct";
  return row.points > 0 ? "partial" : "wrong";
}

/**
 * Every grading of an evaluation that is still standing (`validated` or
 * `proposed`), keyed by cell. One query: the dashboard, the results and the
 * panel all need the same map and none of them may issue a query per cell.
 */
export async function standingGradings(
  db: Db,
  evaluationId: string,
): Promise<Map<PairKey, GradingRecord>> {
  const rows = await db
    .select({ grading: gradings })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .where(and(eq(attempts.evaluationId, evaluationId), ne(gradings.state, "superseded")))
    .orderBy(asc(gradings.gradedAt));
  const map = new Map<PairKey, GradingRecord>();
  for (const row of rows) {
    const key = pairKey(row.grading.attemptId, row.grading.itemId);
    const current = map.get(key);
    // A validated grading always outranks a proposal on the same cell.
    if (!current || current.state !== "validated") map.set(key, row.grading);
  }
  return map;
}

/** The validated half, which is the only one that counts towards a grade. */
export async function validatedGradings(
  db: Db,
  evaluationId: string,
): Promise<Map<PairKey, GradingRecord>> {
  const standing = await standingGradings(db, evaluationId);
  const map = new Map<PairKey, GradingRecord>();
  for (const [key, row] of standing) if (row.state === "validated") map.set(key, row);
  return map;
}

/** `GET /evaluations/:id/grading/progress`. */
export async function progressOf(db: Db, evaluationId: string): Promise<GradingProgress> {
  const items = await joinedItems(db, evaluationId);
  const attemptRows = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(eq(attempts.evaluationId, evaluationId));
  const total = items.length * attemptRows.length;
  const standing = await standingGradings(db, evaluationId);

  let done = 0;
  let runner = 0;
  let llm = 0;
  let failed = 0;
  for (const row of standing.values()) {
    if (row.state === "validated") {
      done += 1;
      continue;
    }
    const reason = reasonOf(row.details);
    if (reason === "llm_not_configured") llm += 1;
    else if (reason === "runner_unavailable" || reason === "runner_busy") runner += 1;
    else failed += 1;
  }
  return { done, total, pending: { runner, llm }, failed };
}

/** `details.reason`, the one field every machine-written grading carries. */
export function reasonOf(details: unknown): string | null {
  if (details && typeof details === "object" && "reason" in details) {
    const reason = (details as { reason: unknown }).reason;
    return typeof reason === "string" ? reason : null;
  }
  return null;
}

// --- The panel (F-GRADE-03) ----------------------------------------------

interface Roster {
  userId: string;
  displayName: string;
  pseudonym: string;
}

async function rosterOf(db: Db, evaluationId: string): Promise<Map<string, Roster>> {
  // LEFT JOIN, not INNER: an attempt of a poll may belong to a GUEST, whose
  // `user_id` is null (ADR-014). An inner join silently dropped those rows
  // and the panel showed a graded answer with no owner at all.
  const rows = await db
    .select({
      attemptId: attempts.id,
      userId: attempts.userId,
      givenName: users.givenName,
      familyName: users.familyName,
      email: users.email,
    })
    .from(attempts)
    .leftJoin(users, eq(attempts.userId, users.id))
    .where(eq(attempts.evaluationId, evaluationId))
    .orderBy(asc(attempts.createdAt));
  const pseudonyms = uniquePseudonyms(
    evaluationId,
    rows.map((r) => r.userId).filter((id): id is string => id !== null),
  );
  let guests = 0;
  return new Map(
    rows.map((r) => {
      if (r.userId === null) {
        guests += 1;
        const name = `Guest ${guests}`;
        return [r.attemptId, { userId: r.attemptId, displayName: name, pseudonym: name }];
      }
      return [
        r.attemptId,
        {
          userId: r.userId,
          displayName: `${r.givenName ?? ""} ${r.familyName ?? ""}`.trim() || (r.email ?? ""),
          pseudonym: pseudonyms.get(r.userId) ?? "—",
        },
      ];
    }),
  );
}

async function historyOf(
  db: Db,
  evaluationId: string,
): Promise<Map<PairKey, GradingHistoryEntry[]>> {
  const rows = await db
    .select({ grading: gradings })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .where(eq(attempts.evaluationId, evaluationId))
    .orderBy(...NEWEST_FIRST);
  const map = new Map<PairKey, GradingHistoryEntry[]>();
  for (const { grading } of rows) {
    const key = pairKey(grading.attemptId, grading.itemId);
    const list = map.get(key) ?? [];
    list.push({
      id: grading.id,
      points: grading.points,
      maxPoints: grading.maxPoints,
      source: grading.source,
      state: grading.state,
      gradedAt: iso(grading.gradedAt),
      comment: grading.comment,
      regradeNote: grading.regradeNote,
    });
    map.set(key, list);
  }
  return map;
}

type AttemptRecord = typeof attempts.$inferSelect;

/** Everything the panel reads besides the items and the attempts, keyed by cell. */
interface QueueContext {
  answers: Map<PairKey, typeof answers.$inferSelect>;
  standing: Map<PairKey, GradingRecord>;
  history: Map<PairKey, GradingHistoryEntry[]>;
  roster: Map<string, Roster>;
  /** The teacher's own test walks (ADR-018). */
  staffAttempts: ReadonlySet<string>;
}

/** The five whole-evaluation reads of the panel: one query each, never one per cell. */
async function loadQueueContext(
  db: Db,
  evaluation: EvaluationRecord,
  attemptRows: readonly AttemptRecord[],
): Promise<QueueContext> {
  const answerRows =
    attemptRows.length === 0
      ? []
      : await db
          .select()
          .from(answers)
          .where(
            inArray(
              answers.attemptId,
              attemptRows.map((a) => a.id),
            ),
          );
  return {
    answers: new Map(answerRows.map((a) => [pairKey(a.attemptId, a.itemId), a])),
    standing: await standingGradings(db, evaluation.id),
    history: await historyOf(db, evaluation.id),
    roster: await rosterOf(db, evaluation.id),
    // The teacher's own test walk is corrected like any other — they asked
    // for it — but the panel says whose it is (ADR-018).
    staffAttempts: await staffAttemptIds(db, evaluation),
  };
}

/** One cell of the panel. The views still come from `studentView`/`solutionView` (invariant 4). */
function entryOf(
  { attempt, item }: { attempt: AttemptRecord; item: JoinedItem },
  grading: GradingRecord | null,
  context: QueueContext,
  anonymous: boolean,
): GradingEntry {
  const key = pairKey(attempt.id, item.item.id);
  const answer = context.answers.get(key) ?? null;
  const who = context.roster.get(attempt.id);
  const version = { config: item.version.config, configVersion: item.version.configVersion };
  return {
    answerId: answer?.id ?? null,
    attemptId: attempt.id,
    itemId: item.item.id,
    // A guest has no account behind it: `rosterOf` names it "Guest n".
    label: anonymous ? (who?.pseudonym ?? "—") : (who?.displayName ?? attempt.userId ?? "—"),
    staff: context.staffAttempts.has(attempt.id),
    answer: answer?.payload ?? null,
    student: studentView({
      type: item.question.type,
      version,
      seed: attempt.seed,
      itemId: item.item.id,
      shuffle: false,
    }),
    solution: solutionView({
      type: item.question.type,
      version,
      seed: attempt.seed,
      itemId: item.item.id,
    }),
    grading: grading ? toGrading(grading) : null,
    history: context.history.get(key) ?? [],
  };
}

/**
 * `GET /evaluations/:id/grading` (§4.5). Ordered by question (every student's
 * answer to one question, which is how a teacher actually corrects) or by
 * student (the quiz in order, for a dispute).
 *
 * The counts are those of the SELECTION (item, attempt), before the state
 * filter: they are accumulated in the same walk that builds the entries.
 */
export async function gradingQueue(
  db: Db,
  evaluation: EvaluationRecord,
  query: GradingQuery,
): Promise<GradingQueue> {
  const allItems = await joinedItems(db, evaluation.id);
  const items = query.itemId ? allItems.filter((i) => i.item.id === query.itemId) : allItems;
  const attemptRows = await db
    .select()
    .from(attempts)
    .where(eq(attempts.evaluationId, evaluation.id))
    .orderBy(asc(attempts.createdAt));
  const selected = query.attemptId
    ? attemptRows.filter((a) => a.id === query.attemptId)
    : attemptRows;
  const context = await loadQueueContext(db, evaluation, attemptRows);

  const pairs: { attempt: AttemptRecord; item: JoinedItem }[] =
    query.by === "student"
      ? selected.flatMap((attempt) => items.map((item) => ({ attempt, item })))
      : items.flatMap((item) => selected.map((attempt) => ({ attempt, item })));

  const entries: GradingEntry[] = [];
  let validated = 0;
  let proposed = 0;
  for (const pair of pairs) {
    const grading = context.standing.get(pairKey(pair.attempt.id, pair.item.item.id)) ?? null;
    if (grading?.state === "validated") validated += 1;
    else if (grading?.state === "proposed") proposed += 1;
    if (query.state && grading?.state !== query.state) continue;
    entries.push(entryOf(pair, grading, context, query.anonymous));
  }

  const total = items.length * selected.length;
  return {
    order: query.by,
    items: items.map((i) => ({
      id: i.item.id,
      position: i.item.position,
      internalName: i.question.internalName,
      type: i.question.type,
      points: i.item.points,
    })),
    entries,
    counts: { total, validated, proposed, missing: total - validated - proposed },
  };
}

// --- Teacher writes -------------------------------------------------------

/**
 * F-GRADE-05. The comment is not optional and the previous grading is kept as
 * `superseded`: a manual correction must always be explainable afterwards.
 */
export async function manualOverride(
  db: Db,
  target: { attemptId: string; itemId: string; answerId: string | null; maxPoints: number },
  input: { points: number; comment: string; details?: unknown },
  userId: string,
  now: Date,
): Promise<GradingRecord> {
  if (input.comment.trim().length === 0) throw new CommentRequired();
  return writeGrading(db, {
    attemptId: target.attemptId,
    itemId: target.itemId,
    answerId: target.answerId,
    points: input.points,
    maxPoints: target.maxPoints,
    source: "manual",
    state: "validated",
    details: input.details ?? { manual: true },
    comment: input.comment.trim(),
    gradedBy: userId,
    now,
  });
}

/**
 * F-GRADE-04. Validating a proposal keeps its details and its source: what
 * changes is that it now counts. Adjusting the points on the way makes it a
 * `manual` grading, because a teacher's number is not a machine's.
 */
export async function validateGrading(
  db: Db,
  grading: GradingRecord,
  input: { points?: number | undefined; comment?: string | undefined },
  userId: string,
  now: Date,
): Promise<GradingRecord> {
  if (grading.state !== "proposed") throw new NotPending();
  const adjusted = input.points !== undefined && round2(input.points) !== grading.points;
  return writeGrading(db, {
    attemptId: grading.attemptId,
    itemId: grading.itemId,
    answerId: grading.answerId,
    points: input.points ?? grading.points,
    maxPoints: grading.maxPoints,
    source: adjusted ? "manual" : grading.source,
    state: "validated",
    details: grading.details,
    confidence: grading.confidence ?? undefined,
    comment: input.comment ?? grading.comment ?? undefined,
    gradedBy: userId,
    regradeNote: grading.regradeNote ?? undefined,
    now,
  });
}

interface BatchFilter {
  itemId?: string | undefined;
  source?: GradingSource | undefined;
  confidence?: "low" | "medium" | "high" | undefined;
}

/**
 * F-GRADE-04, the "validate every high-confidence proposal of question 3"
 * button. It validates proposals one by one through {@link writeGrading}, so a
 * batch leaves the same history a click would.
 */
export async function batchValidate(
  db: Db,
  evaluationId: string,
  filter: BatchFilter,
  userId: string,
  now: Date,
): Promise<number> {
  const rows = await db
    .select({ grading: gradings })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .where(
      and(
        eq(attempts.evaluationId, evaluationId),
        eq(gradings.state, "proposed"),
        filter.itemId ? eq(gradings.itemId, filter.itemId) : undefined,
        filter.source ? eq(gradings.source, filter.source) : undefined,
        filter.confidence ? eq(gradings.confidence, filter.confidence) : undefined,
      ),
    )
    .orderBy(asc(gradings.gradedAt));
  let validated = 0;
  for (const { grading } of rows) {
    await validateGrading(db, grading, {}, userId, now);
    validated += 1;
  }
  return validated;
}

/** The full history of one cell, newest first (F-GRADE-05, F-GRADE-06). */
export async function historyOfCell(
  db: Db,
  attemptId: string,
  itemId: string,
): Promise<GradingHistoryEntry[]> {
  const rows = await db
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.itemId, itemId)))
    .orderBy(...NEWEST_FIRST);
  return rows.map((g) => ({
    id: g.id,
    points: g.points,
    maxPoints: g.maxPoints,
    source: g.source,
    state: g.state,
    gradedAt: iso(g.gradedAt),
    comment: g.comment,
    regradeNote: g.regradeNote,
  }));
}

/**
 * The cell a route addresses by `answerId`, with the item's point scale. An
 * answer nobody can reach is `null`, and the route answers 404 (invariant 6).
 */
export async function cellOfAnswer(
  db: Db,
  answerId: string,
): Promise<{
  evaluationId: string;
  attemptId: string;
  itemId: string;
  answerId: string;
  maxPoints: number;
} | null> {
  const [row] = await db
    .select({
      attemptId: answers.attemptId,
      itemId: answers.itemId,
      evaluationId: attempts.evaluationId,
    })
    .from(answers)
    .innerJoin(attempts, eq(answers.attemptId, attempts.id))
    .where(eq(answers.id, answerId))
    .limit(1);
  if (!row) return null;
  const items = await joinedItems(db, row.evaluationId);
  const item = items.find((i) => i.item.id === row.itemId);
  if (!item) return null;
  return {
    evaluationId: row.evaluationId,
    attemptId: row.attemptId,
    itemId: row.itemId,
    answerId,
    maxPoints: item.item.points,
  };
}

/** `sum(points)` of the validated gradings, per attempt, in one query. */
export async function pointsByAttempt(
  db: Db,
  attemptIds: readonly string[],
): Promise<Map<string, number>> {
  if (attemptIds.length === 0) return new Map();
  const rows = await db
    .select({
      attemptId: gradings.attemptId,
      points: sql<string>`sum(${gradings.points})`,
    })
    .from(gradings)
    .where(and(inArray(gradings.attemptId, [...attemptIds]), eq(gradings.state, "validated")))
    .groupBy(gradings.attemptId);
  return new Map(rows.map((r) => [r.attemptId, round2(Number(r.points))]));
}
