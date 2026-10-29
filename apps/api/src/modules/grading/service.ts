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

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import type {
  Grading,
  ParametersDraft,
  GradingEntry,
  GradingHistoryEntry,
  GradingProgress,
  GradingQuery,
  GradingQueue,
  GradingSteps,
  GradingConfidence,
  GradingSource,
  GradingState,
  Verdict,
} from "@quiz/contracts";
import {
  AI_KEY,
  aiOf,
  BREAKDOWN_KEY,
  JUSTIFICATION_KEY,
  reasonOf,
  RUNNER_WAITING_REASONS,
  type BreakdownEntry,
  type CriterionPointsBody,
} from "@quiz/contracts";
import {
  attemptTotal,
  countsForStudent,
  isBatchable,
  LLM_REGRADES_PER_ITEM_PER_DAY,
  SCHOOL_TIME_ZONE,
  itemStanding,
  outcomeOf,
  overridePointsRange,
  round2,
  scoresNegatively,
  type DeclaredCriterion,
  type ItemCounting,
  type StoodItem,
  validatedBreakdown,
} from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db, Tx } from "../../db/client.js";
import {
  answers,
  attempts,
  auditLog,
  evaluationItems,
  gradings,
  questionVersions,
  users,
} from "../../db/schema.js";
import { refusalClass, type Refusal } from "../http.js";
import {
  flagReleasedEvaluationsOf,
  setItemCounting,
  setModifiedAfterRelease,
  joinedItem,
  joinedItems,
  negativeMarkingEnabled,
  retargetItemVersion,
  clearGradingReady,
  type DbOrTx,
  staffAttemptIds,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { solutionViewOf, studentViewOf } from "../live/studentView.js";
import { typeOf } from "../pool/config.js";
import { formattedValues, sameTable } from "@quiz/domain/parameters";
import {
  explanationOrNull,
  isParameterized,
  parametersOf,
  readingPerAttempt,
  writtenConfig,
  type Reading,
} from "../pool/service.js";
import { watchReleasedGrades } from "../results/service.js";
import { keptAttempts, tallyByAttempt } from "./kept.js";

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

/**
 * Everything this module refuses, by code: its status and, where the
 * refusal reads the same wherever it is thrown, its message.
 */
const REFUSALS = {
  // F-GRADE-05: overriding a correction without saying why is not allowed.
  comment_required: [422, "a manual override must carry a comment"],
  // F-GRADE-05 (ADR-026): a manual score outside what the item can be worth —
  // `[0, max]`, or `[-max, max]` for a choice question under negative marking.
  points_out_of_range: [422],
  not_pending: [409, "this grading is not a proposal any more"],
  // A regrade with a version whose variables are not the item's (ADR-056 §5):
  // the values the students were served could not be read under it, so the
  // item keeps its version and nothing is regraded.
  variables_changed: [409, "the version declares other variables than the item's"],
  // Audit L2: an item the model grades is re-graded at most
  // `LLM_REGRADES_PER_ITEM_PER_DAY` times a day; the code is the gateway's.
  llm_budget_exhausted: [429, "this item was re-graded by the model as often as a day allows: try again tomorrow"],
  // ADR-118 §6: the points per criterion name every criterion of the item
  // exactly once, each within its maximum; an essay with criteria is graded
  // by them, never by a bare total; an item without criteria takes none.
  criteria_invalid: [422, "the points per criterion do not match the item's criteria"],
  // F-EXP-01 (ADR-121 §2): the Markdown export of an item whose type does not
  // render as text, or of a parameterized one; its JSON record still exists.
  not_exportable: [409, "this question does not export as text"],
} satisfies Record<string, Refusal>;

export class GradingError extends refusalClass("GradingError", REFUSALS) {}

/**
 * Whether an item's answers export as Markdown (F-EXP-01, ADR-121 §2): its
 * type renders a statement and an answer, and the question is not
 * parameterized — each attempt would have its own statement and key.
 */
export function exportsText(type: string, version: { variables: { rows: readonly unknown[] } | null }): boolean {
  const t = typeOf(type);
  return t.statementDoc !== undefined && t.answerDoc !== undefined && !isParameterized(version);
}

// --- Keys -----------------------------------------------------------------

/** A grading addresses a CELL of the grid, not an answer: an absent answer is graded too. */
export type PairKey = `${string}:${string}`;
export const pairKey = (attemptId: string, itemId: string): PairKey =>
  `${attemptId}:${itemId}`;

// --- The single writer ----------------------------------------------------

export interface WriteGradingInput {
  attemptId: string;
  itemId: string;
  /** Null when the student never answered (F-GRADE-01). */
  answerId: string | null;
  points: number;
  maxPoints: number;
  source: GradingSource;
  state: Exclude<GradingState, "superseded">;
  details?: unknown;
  confidence?: GradingConfidence | undefined;
  comment?: string | undefined;
  gradedBy?: string | undefined;
  regradeNote?: string | undefined;
  now: Date;
}

/**
 * THE write (§5.4), for one cell: {@link writeGradings} with a batch of one.
 */
export async function writeGrading(db: Db, input: WriteGradingInput): Promise<GradingRecord> {
  const [row] = await writeGradings(db, [input]);
  return row!;
}

/** Cells per transaction: well under PostgreSQL's 65 535 bind parameters (16 per row). */
const WRITE_CHUNK = 500;

/**
 * THE write (§5.4), for many cells. Per chunk of {@link WRITE_CHUNK}, in one
 * transaction and two statements:
 *
 * ```sql
 * UPDATE gradings SET state='superseded'
 *  WHERE state <> 'superseded' AND (attempt_id, item_id) IN (<cells>) …
 *  RETURNING id, attempt_id, item_id;
 * INSERT INTO gradings (…, supersedes_id = <what that cell just lost>) VALUES (…), (…);
 * ```
 *
 * A new `validated` grading supersedes everything still standing on its
 * cell. A new `proposed` one only supersedes a previous PROPOSAL: a proposal
 * must never quietly unseat a grade a teacher already validated, and the
 * callers that produce proposals skip a validated cell anyway (idempotency).
 * A cell appears at most once per batch — the supersede chain of a cell is
 * built from ONE row per cell, so a duplicate throws before anything is
 * written; `gradings_pair_validated_uq` still refuses a second validated
 * grading on one cell.
 *
 * The rows come back in the order of `inputs`.
 *
 * `guard`, when given, runs first inside each chunk's transaction and returns
 * the inputs to write: it may drop an input or amend its `details`, never its
 * cell, state or points (`results_updated` is read before it). The grading
 * jobs lock the attempts there and drop the cells of one reopened meanwhile
 * (ADR-067); an override keeps the proposal it replaces there (ADR-118 §6).
 * The rows of the dropped inputs are simply not returned.
 */
export async function writeGradings(
  db: Db,
  inputs: readonly WriteGradingInput[],
  guard?: WriteGuard,
): Promise<GradingRecord[]> {
  const seen = new Set<PairKey>();
  for (const input of inputs) {
    const key = pairKey(input.attemptId, input.itemId);
    if (seen.has(key)) {
      throw new Error(`writeGradings: cell ${key} appears twice in one batch`);
    }
    seen.add(key);
  }
  // `results_updated` (ADR-030 §h.4): the grade each student is shown on a
  // RELEASED evaluation, read before the write and compared after the
  // commit — once per write, not per cell, and never inside the transaction
  // (§1). Only a validated grading counts towards a grade.
  const watch = await watchReleasedGrades(
    db,
    inputs.filter((i) => i.state === "validated"),
  );
  const out: GradingRecord[] = [];
  for (let start = 0; start < inputs.length; start += WRITE_CHUNK) {
    out.push(...(await writeChunk(db, inputs.slice(start, start + WRITE_CHUNK), guard)));
  }
  await watch.announce();
  return out;
}

/**
 * The inputs to write, decided inside the write's transaction: it may drop
 * an input or amend its `details`, never its cell, state or points
 * (`results_updated` is read before it; see {@link writeGradings}).
 */
export type WriteGuard = (
  tx: Tx,
  inputs: readonly WriteGradingInput[],
) => Promise<readonly WriteGradingInput[]>;

async function writeChunk(
  db: Db,
  chunk: readonly WriteGradingInput[],
  guard: WriteGuard | undefined,
): Promise<GradingRecord[]> {
  return db.transaction(async (tx) => {
    const inputs = guard ? await guard(tx, chunk) : chunk;
    if (inputs.length === 0) return [];
    const cells = (state: WriteGradingInput["state"]) => {
      const pairs = inputs
        .filter((i) => i.state === state)
        .map((i) => sql`(${i.attemptId}::uuid, ${i.itemId}::uuid)`);
      return pairs.length === 0
        ? sql`false`
        : sql`(${gradings.attemptId}, ${gradings.itemId}) in (${sql.join(pairs, sql`, `)})`;
    };
    const superseded = await tx
      .update(gradings)
      .set({ state: "superseded" })
      .where(
        and(
          ne(gradings.state, "superseded"),
          or(cells("validated"), and(cells("proposed"), eq(gradings.state, "proposed"))),
        ),
      )
      .returning({
        id: gradings.id,
        attemptId: gradings.attemptId,
        itemId: gradings.itemId,
        gradedAt: gradings.gradedAt,
      });
    // The chain points at the grading this one REPLACES; when several were
    // still standing on a cell (a proposal next to nothing else), the newest
    // wins.
    const previous = new Map<PairKey, { id: string; gradedAt: Date }>();
    for (const row of superseded) {
      const key = pairKey(row.attemptId, row.itemId);
      const held = previous.get(key);
      if (!held || row.gradedAt >= held.gradedAt) previous.set(key, row);
    }
    const values = inputs.map((input) => ({
      id: randomUUID(),
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
      supersedesId: previous.get(pairKey(input.attemptId, input.itemId))?.id ?? null,
      regradeNote: input.regradeNote ?? null,
      createdAt: input.now,
    }));
    const rows = await tx.insert(gradings).values(values).returning();
    // A validated grading on a released evaluation changes a published
    // grade: F-GRADE-09's flag goes up here, in the same transaction, for
    // every caller at once (the panel, the automatic pass, the runner job).
    const validated = inputs.filter((i) => i.state === "validated");
    if (validated.length > 0) {
      await flagReleasedEvaluationsOf(
        tx,
        [...new Set(validated.map((i) => i.attemptId))],
        validated[0]!.now,
      );
    }
    // RETURNING order is not promised by SQL: put the rows back in input order.
    const byId = new Map(rows.map((r) => [r.id, r]));
    return values.map((v) => byId.get(v.id)!);
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
  return outcomeOf(row.points, row.maxPoints);
}

/** The cells of an evaluation a read is about: all of them, or one item's. */
interface CellScope {
  itemId?: string | undefined;
}

/** The `WHERE` of a {@link CellScope} on `gradings` joined to its attempts. */
const gradingsIn = (evaluationId: string, scope: CellScope) =>
  and(
    eq(attempts.evaluationId, evaluationId),
    scope.itemId ? eq(gradings.itemId, scope.itemId) : undefined,
  );

/**
 * Every grading of an evaluation that is still standing (`validated` or
 * `proposed`), keyed by cell. One query: the dashboard, the results and the
 * panel all need the same map and none of them may issue a query per cell.
 * The panel narrowed to one item reads only that item's cells.
 */
export async function standingGradings(
  db: Db,
  evaluationId: string,
  scope: CellScope = {},
): Promise<Map<PairKey, GradingRecord>> {
  const rows = await db
    .select({ grading: gradings })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .where(and(gradingsIn(evaluationId, scope), ne(gradings.state, "superseded")))
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
  // A neutralized item (ADR-108) awaits no grade: neither in the total nor done.
  const counted = new Set(items.filter((i) => countsForStudent(i.item.counting)).map((i) => i.item.id));
  const total = counted.size * attemptRows.length;
  const standing = await standingGradings(db, evaluationId);

  let done = 0;
  let runner = 0;
  let llm = 0;
  let failed = 0;
  for (const row of standing.values()) {
    if (!counted.has(row.itemId)) continue;
    if (row.state === "validated") {
      done += 1;
      continue;
    }
    const reason = reasonOf(row.details);
    if (reason === "llm_not_configured") llm += 1;
    else if ((RUNNER_WAITING_REASONS as readonly (string | null)[]).includes(reason)) runner += 1;
    else failed += 1;
  }
  return { done, total, pending: { runner, llm }, failed };
}


// --- The panel (F-GRADE-03) ----------------------------------------------

type AttemptRecord = typeof attempts.$inferSelect;

interface Roster {
  /** The name the panel shows when the teacher asks for names; null for a guest. */
  displayName: string | null;
  /** A guest's number among the evaluation's guests (ADR-014); null for an account. */
  guest: number | null;
  /** Which of the student's attempts this is; null for a student with one. */
  attemptNumber: number | null;
}

/**
 * The name and the attempt number of each attempt. `attemptRows` is EVERY
 * attempt of the evaluation, oldest first, as the caller already loaded
 * them: the guests' numbers and whether a student retook the exercise depend
 * on all of them, whatever the panel shows.
 *
 * No pseudonym any more (ADR-044): an anonymous panel carries no label at
 * all, and the retake number travels on its own (`GradingEntry.attemptNumber`)
 * instead of as a " · #2" suffix of a name it would outlive.
 */
async function rosterOf(
  db: Db,
  attemptRows: readonly Pick<AttemptRecord, "id" | "userId" | "attemptNumber">[],
): Promise<Map<string, Roster>> {
  const userIds = [
    ...new Set(attemptRows.map((r) => r.userId).filter((id): id is string => id !== null)),
  ];
  const people =
    userIds.length === 0
      ? []
      : await db
          .select({
            id: users.id,
            givenName: users.givenName,
            familyName: users.familyName,
            email: users.email,
          })
          .from(users)
          .where(inArray(users.id, userIds));
  const person = new Map(people.map((p) => [p.id, p]));
  const attemptsOf = new Map<string, number>();
  for (const r of attemptRows) {
    if (r.userId) attemptsOf.set(r.userId, (attemptsOf.get(r.userId) ?? 0) + 1);
  }
  // An attempt of a poll may belong to a GUEST, whose `user_id` is null
  // (ADR-014): it keeps its row, numbered among the guests, rather than
  // leave the panel a graded answer with no owner at all. The number, not a
  // name: the web words it in the reader's language.
  let guests = 0;
  return new Map(
    attemptRows.map((r): [string, Roster] => {
      if (r.userId === null) {
        guests += 1;
        return [r.id, { displayName: null, guest: guests, attemptNumber: null }];
      }
      const who = person.get(r.userId);
      return [
        r.id,
        {
          displayName:
            `${who?.givenName ?? ""} ${who?.familyName ?? ""}`.trim() || (who?.email ?? r.userId),
          guest: null,
          attemptNumber: (attemptsOf.get(r.userId) ?? 0) > 1 ? r.attemptNumber : null,
        },
      ];
    }),
  );
}

/** One line of a cell's history: the panel's and the cell route's, the same DTO. */
const historyEntry = (grading: GradingRecord): GradingHistoryEntry => ({
  id: grading.id,
  points: grading.points,
  maxPoints: grading.maxPoints,
  source: grading.source,
  state: grading.state,
  gradedAt: iso(grading.gradedAt),
  comment: grading.comment,
  regradeNote: grading.regradeNote,
});

async function historyOf(
  db: Db,
  evaluationId: string,
  scope: CellScope,
): Promise<Map<PairKey, GradingHistoryEntry[]>> {
  const rows = await db
    .select({ grading: gradings })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .where(gradingsIn(evaluationId, scope))
    .orderBy(...NEWEST_FIRST);
  const map = new Map<PairKey, GradingHistoryEntry[]>();
  for (const { grading } of rows) {
    const key = pairKey(grading.attemptId, grading.itemId);
    const list = map.get(key) ?? [];
    list.push(historyEntry(grading));
    map.set(key, list);
  }
  return map;
}

/** Everything the panel reads besides the items and the attempts, keyed by cell. */
interface QueueContext {
  answers: Map<PairKey, typeof answers.$inferSelect>;
  standing: Map<PairKey, GradingRecord>;
  history: Map<PairKey, GradingHistoryEntry[]>;
  roster: Map<string, Roster>;
  /** The teacher's own test walks (ADR-018). */
  staffAttempts: ReadonlySet<string>;
  /** The attempt that counts for each student who retook (ADR-025). */
  kept: ReadonlySet<string>;
  /**
   * Each item's config, parsed once for every attempt that shows it — per
   * attempt for a parameterized question, whose every attempt has its own
   * key and its own values (ADR-056, `readingPerAttempt`).
   */
  readings: Map<string, (attempt: AttemptRecord) => Reading>;
}

/**
 * The reads of the panel: one query each, never one per cell, and only for
 * the selected cells — a panel narrowed to one item does not load the
 * answers and the history of the whole evaluation.
 */
async function loadQueueContext(
  db: Db,
  evaluation: EvaluationRecord,
  attemptRows: readonly AttemptRecord[],
  selection: { items: readonly JoinedItem[]; scope: CellScope },
): Promise<QueueContext> {
  const { scope } = selection;
  const [answerRows, standing, history, roster, staffAttempts, kept] = await Promise.all([
    attemptRows.length === 0 || selection.items.length === 0
      ? []
      : db
          .select()
          .from(answers)
          .where(
            and(
              inArray(
                answers.attemptId,
                attemptRows.map((a) => a.id),
              ),
              scope.itemId ? eq(answers.itemId, scope.itemId) : undefined,
            ),
          ),
    standingGradings(db, evaluation.id, scope),
    historyOf(db, evaluation.id, scope),
    rosterOf(db, attemptRows),
    // The teacher's own test walk is corrected like any other — they asked
    // for it — but the panel says whose it is (ADR-018).
    staffAttemptIds(db, evaluation),
    // Only worth a read when somebody retook: otherwise every attempt counts.
    attemptRows.some((a) => a.attemptNumber > 1) ? keptAttempts(db, evaluation) : null,
  ]);
  return {
    answers: new Map(answerRows.map((a) => [pairKey(a.attemptId, a.itemId), a])),
    standing,
    history,
    roster,
    staffAttempts,
    kept: new Set(
      kept === null ? attemptRows.map((a) => a.id) : [...kept.values()].map((a) => a.id),
    ),
    // Only when some cell will show them: an empty panel never parsed a
    // config, and must not start failing on one that no longer loads.
    readings: new Map(
      (attemptRows.length === 0 ? [] : selection.items).map((i) => [
        i.item.id,
        readingPerAttempt(i),
      ]),
    ),
  };
}

/**
 * One cell of the panel. The views still come from `studentViewOf`/`solutionViewOf` (invariant 4).
 *
 * Anonymous (the default), nothing in it names the student: no label, no
 * user id. The attempt id stays — it names an attempt, and it is what every
 * write of the panel addresses.
 */
function entryOf(
  { attempt, item }: { attempt: AttemptRecord; item: JoinedItem },
  grading: GradingRecord | null,
  context: QueueContext,
  anonymous: boolean,
): GradingEntry {
  const key = pairKey(attempt.id, item.item.id);
  const answer = context.answers.get(key) ?? null;
  const who = context.roster.get(attempt.id);
  const reading = context.readings.get(item.item.id)?.(attempt);
  const config = reading?.config;
  const view = { seed: attempt.seed, itemId: item.item.id, shuffle: false };
  return {
    answerId: answer?.id ?? null,
    attemptId: attempt.id,
    itemId: item.item.id,
    label: anonymous ? null : (who?.displayName ?? null),
    guest: anonymous ? null : (who?.guest ?? null),
    staff: context.staffAttempts.has(attempt.id),
    attemptNumber: who?.attemptNumber ?? null,
    kept: context.kept.has(attempt.id),
    answer: answer?.payload ?? null,
    ...(reading?.values
      ? {
          values: formattedValues(parametersOf(item.version)!, reading.values),
          explanation: explanationOrNull(reading.explanation),
        }
      : {}),
    student: studentViewOf(item.question.type, config, view),
    solution: solutionViewOf(item.question.type, config, view),
    grading: grading ? toGrading(grading) : null,
    history: context.history.get(key) ?? [],
  };
}

/**
 * `GET /evaluations/:id/grading` (§4.5): every student's answer to one
 * question — which is how a teacher actually corrects, and the only way
 * through the panel since ADR-044 — or to every question, item after item.
 *
 * The counts are those of the SELECTION (the item): every state is sent,
 * and the panel filters in the browser.
 */
export async function gradingQueue(
  db: Db,
  evaluation: EvaluationRecord,
  query: GradingQuery,
): Promise<GradingQueue> {
  const [allItems, attemptRows] = await Promise.all([
    joinedItems(db, evaluation.id),
    db
      .select()
      .from(attempts)
      .where(eq(attempts.evaluationId, evaluation.id))
      .orderBy(asc(attempts.createdAt)),
  ]);
  const items = query.itemId ? allItems.filter((i) => i.item.id === query.itemId) : allItems;
  const context = await loadQueueContext(db, evaluation, attemptRows, {
    items,
    scope: { itemId: query.itemId },
  });

  const entries: GradingEntry[] = [];
  let validated = 0;
  let proposed = 0;
  for (const item of items) {
    // A neutralized item's answers stay on the panel, out of the counts (ADR-108).
    const counts = countsForStudent(item.item.counting);
    for (const attempt of attemptRows) {
      const grading = context.standing.get(pairKey(attempt.id, item.item.id)) ?? null;
      if (counts && grading?.state === "validated") validated += 1;
      else if (counts && grading?.state === "proposed") proposed += 1;
      entries.push(entryOf({ attempt, item }, grading, context, query.anonymous));
    }
  }

  const total = items.filter((i) => countsForStudent(i.item.counting)).length * attemptRows.length;
  return {
    items: items.map((i) => ({
      id: i.item.id,
      position: i.item.position,
      internalName: i.question.internalName,
      type: i.question.type,
      points: i.item.points,
      minPoints: pointsRangeOf(evaluation, i, i.item.points).min,
      // The declared fields only: a criterion's prompt stays in the key.
      criteria: criteriaOf(i).map(({ id, title, weight }) => ({ id, title, weight })),
      explanation: explanationOrNull(i.version.explanation),
      exportable: exportsText(i.question.type, i.version),
      ...(isParameterized(i.version) ? { parameters: writtenOf(i) } : {}),
    })),
    entries,
    counts: { total, validated, proposed, missing: total - validated - proposed },
  };
}

/**
 * A parameterized item's expected row (ADR-056 §9): its variables, and the
 * question as written — through the type's own views, seed 0 and no
 * shuffle, like every view of the panel. Staff-only, like the queue.
 */
function writtenOf(item: JoinedItem): NonNullable<GradingQueue["items"][number]["parameters"]> {
  const { config, example } = writtenConfig(item.question.type, item.version);
  const view = { seed: 0, itemId: item.item.id, shuffle: false };
  return {
    variables: parametersOf(item.version)!,
    template: {
      student: studentViewOf(item.question.type, config, view),
      solution: solutionViewOf(item.question.type, config, view),
      example,
    },
  };
}

/**
 * `GET /evaluations/:id/grading/steps` (#107). One step per question, in the
 * evaluation's order, with the state of its cells, for the question selector.
 *
 * Counted from the same validated gradings as the queue's `counts`, so a
 * step reads "2 to validate" here exactly when its queue would say so. No
 * answer, no view and no history is loaded: this is two counters per step.
 */
export async function gradingSteps(db: Db, evaluation: EvaluationRecord): Promise<GradingSteps> {
  const items = await joinedItems(db, evaluation.id);
  const attemptRows = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(eq(attempts.evaluationId, evaluation.id));
  // The validated cells and nothing else — not the details, the comment or
  // the history `standingGradings` carries for the queue: a question is done
  // when each of its cells holds a validated grading.
  const rows = await db
    .select({ attemptId: gradings.attemptId, itemId: gradings.itemId })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .where(and(eq(attempts.evaluationId, evaluation.id), eq(gradings.state, "validated")));
  const validated = new Set(rows.map((row) => pairKey(row.attemptId, row.itemId)));

  return {
    steps: items.map((item) => ({
      key: item.item.id,
      total: attemptRows.length,
      validated: attemptRows.filter((a) => validated.has(pairKey(a.id, item.item.id))).length,
    })),
  };
}

// --- Teacher writes -------------------------------------------------------

/**
 * The points a teacher may give an item of type `type` in `evaluation` by
 * hand (F-GRADE-05): `[0, max]`, or `[-max, max]` for a choice question when
 * the evaluation uses negative marking (ADR-026) — never for a bonus item,
 * which is floored at 0 (ADR-052). The grading panel receives the lower
 * bound (`GradingQueueItem.minPoints`), the routes enforce both.
 */
function pointsRangeOf(
  evaluation: EvaluationRecord,
  item: JoinedItem | null,
  maxPoints: number,
): { min: number; max: number } {
  const negative = scoresNegatively(
    item?.question.type ?? "",
    negativeMarkingEnabled(evaluation),
    item?.item.counting ?? "normal",
  );
  return overridePointsRange(maxPoints, negative);
}

/** Refuses a manual score outside {@link pointsRangeOf} with `422 points_out_of_range`. */
export function assertPointsInRange(
  evaluation: EvaluationRecord,
  item: JoinedItem | null,
  cell: { maxPoints: number },
  points: number,
): void {
  const range = pointsRangeOf(evaluation, item, cell.maxPoints);
  const value = round2(points);
  if (value < range.min || value > range.max) throw new GradingError("points_out_of_range", `the points must lie in [${range.min}, ${range.max}]`);
}

/**
 * F-GRADE-05. The comment is not optional and the previous grading is kept as
 * `superseded`: a manual correction must always be explainable afterwards.
 *
 * An essay with criteria (`target.criteria`, ADR-118 §6) is overridden
 * criterion by criterion: the total is derived from `input.criteria`, and
 * the details of the grading in force — the model's proposal, `ai` and
 * `justification` — survive beside the new breakdown. Every other item
 * writes `{ manual: true }`.
 */
export async function manualOverride(
  db: Db,
  target: {
    attemptId: string;
    itemId: string;
    answerId: string | null;
    maxPoints: number;
    /** The item's criteria ({@link criteriaOf}); none for an item graded by one total. */
    criteria: readonly DeclaredCriterion[];
  },
  input: { points?: number | undefined; criteria?: readonly CriterionPointsBody[] | undefined; comment: string },
  userId: string,
  now: Date,
): Promise<GradingRecord> {
  if (input.comment.trim().length === 0) throw new GradingError("comment_required");
  const graded = criteriaOutcome(target.criteria, target.maxPoints, input, null);
  const points = graded.points ?? input.points;
  // `ManualGradingBody` holds one of the two; a caller that sends neither is a bug.
  if (points === undefined) throw new Error("manualOverride: neither points nor criteria");
  const write: WriteGradingInput = {
    attemptId: target.attemptId,
    itemId: target.itemId,
    answerId: target.answerId,
    points,
    maxPoints: target.maxPoints,
    source: "manual",
    state: "validated",
    details: graded.breakdown ? { manual: true, [BREAKDOWN_KEY]: graded.breakdown } : { manual: true },
    comment: input.comment.trim(),
    gradedBy: userId,
    now,
  };
  if (!graded.breakdown) return writeGrading(db, write);
  // The details kept are read inside the write's transaction, the row locked
  // (`gradingInForce`): a correction of the cell committing at the same time
  // waits for this one, or this one reads after it. At worst, a correction
  // that supersedes the read row first leaves this override without the
  // proposal's `ai`; the override itself still wins (F-GRADE-05).
  const [row] = await writeGradings(db, [write], async (tx, inputs) => {
    const previous = await gradingInForce(tx, write.attemptId, write.itemId);
    return inputs.map((i) => ({ ...i, details: { ...teacherKept(previous?.details), ...(i.details as object) } }));
  });
  return row!;
}

/** What an override keeps of the details it replaces: the model's proposal, for the teacher. */
function teacherKept(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== "object") return {};
  const kept: Record<string, unknown> = {};
  for (const key of [AI_KEY, JUSTIFICATION_KEY]) {
    if (key in details) kept[key] = (details as Record<string, unknown>)[key];
  }
  return kept;
}

/** The newest grading of a cell that is not superseded, locked: what a correction replaces. */
async function gradingInForce(tx: Tx, attemptId: string, itemId: string): Promise<GradingRecord | null> {
  const [row] = await tx
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.itemId, itemId), ne(gradings.state, "superseded")))
    .orderBy(...NEWEST_FIRST)
    .limit(1)
    .for("update");
  return row ?? null;
}

/**
 * The criteria an item is graded by (ADR-118 §6): its type's
 * `gradingCriteria` of the version it holds, as written. None for a missing
 * item, a type without the hook or an essay without criteria; a config that
 * does not read throws, as every reader of it does.
 */
export function criteriaOf(item: JoinedItem | null): readonly DeclaredCriterion[] {
  const hook = item ? typeOf(item.question.type).gradingCriteria : undefined;
  return hook ? hook(writtenConfig(item!.question.type, item!.version).config) : [];
}

/**
 * What a correction makes of an item's criteria (ADR-118 §6). With
 * criteria, the teacher's `input.criteria` give the total and the breakdown
 * (`validatedBreakdown`), a bare total is refused; without the teacher's,
 * a proposal whose every criterion names one of the item's is copied into
 * the breakdown and its total kept — a free rubric or an id that matches
 * nothing gives no breakdown, never a partial one. Without criteria,
 * `input.criteria` is refused and nothing changes.
 */
function criteriaOutcome(
  declared: readonly DeclaredCriterion[],
  maxPoints: number,
  input: { points?: number | undefined; criteria?: readonly CriterionPointsBody[] | undefined },
  details: unknown,
): { points?: number; breakdown?: BreakdownEntry[] } {
  if (declared.length === 0) {
    if (input.criteria !== undefined) throw new GradingError("criteria_invalid", "this item has no criteria");
    return {};
  }
  if (input.points !== undefined) {
    throw new GradingError("criteria_invalid", "an essay with criteria is graded criterion by criterion");
  }
  if (input.criteria !== undefined) {
    const result = validatedBreakdown(declared, maxPoints, input.criteria);
    if (!result) throw new GradingError("criteria_invalid");
    return { points: result.total, breakdown: result.breakdown };
  }
  const proposed = aiOf(details)?.criteria;
  if (!proposed || proposed.some((c) => c.id === undefined)) return {};
  const result = validatedBreakdown(
    declared,
    maxPoints,
    proposed.map((c) => ({ id: c.id!, points: c.points })),
  );
  return result ? { breakdown: result.breakdown } : {};
}

/** Whether a teacher's breakdown splits the points as the proposal did, criterion by criterion. */
const sameSplit = (given: readonly BreakdownEntry[], proposed: readonly BreakdownEntry[] | undefined): boolean =>
  proposed !== undefined && given.every((line, i) => line.points === proposed[i]?.points);

type ValidationInput = {
  points?: number | undefined;
  criteria?: readonly CriterionPointsBody[] | undefined;
  comment?: string | undefined;
};

/**
 * F-GRADE-04. Validating a proposal keeps its details and its source: what
 * changes is that it now counts. Adjusting the points on the way makes it a
 * `manual` grading, because a teacher's number is not a machine's. An essay
 * with criteria (`criteria`, {@link criteriaOf}) is adjusted criterion by
 * criterion (ADR-118 §6).
 */
export async function validateGrading(
  db: Db,
  grading: GradingRecord,
  criteria: readonly DeclaredCriterion[],
  input: ValidationInput,
  userId: string,
  now: Date,
): Promise<GradingRecord> {
  return writeGrading(db, validationOf(grading, input, criteria, userId, now));
}

/**
 * The write that validates `grading`: {@link validateGrading}'s, and each of
 * {@link batchValidate}'s. The validated breakdown of an essay with criteria
 * joins the details here, whichever path validates it. A teacher's points
 * per criterion make the grading `manual` when they change the total or
 * only move points between criteria (ADR-118, amendment of 2026-10-27).
 */
function validationOf(
  grading: GradingRecord,
  input: ValidationInput,
  declared: readonly DeclaredCriterion[],
  userId: string,
  now: Date,
): WriteGradingInput {
  if (grading.state !== "proposed") throw new GradingError("not_pending");
  const graded = criteriaOutcome(declared, grading.maxPoints, input, grading.details);
  const resplit =
    input.criteria !== undefined &&
    !sameSplit(graded.breakdown!, criteriaOutcome(declared, grading.maxPoints, {}, grading.details).breakdown);
  // The proposal's own split sent back keeps the proposal's total: the sum
  // of its rounded parts may be 0.01 off (ADR-118 §3).
  const points = input.criteria !== undefined && !resplit ? grading.points : (graded.points ?? input.points ?? grading.points);
  const adjusted = round2(points) !== grading.points || resplit;
  // The proposal's details, the model's `ai` included, live on beside it.
  const details = graded.breakdown
    ? { ...(grading.details as Record<string, unknown> | null), [BREAKDOWN_KEY]: graded.breakdown }
    : grading.details;
  return {
    attemptId: grading.attemptId,
    itemId: grading.itemId,
    answerId: grading.answerId,
    points,
    maxPoints: grading.maxPoints,
    source: adjusted ? "manual" : grading.source,
    state: "validated",
    details,
    confidence: grading.confidence ?? undefined,
    comment: input.comment ?? grading.comment ?? undefined,
    gradedBy: userId,
    regradeNote: grading.regradeNote ?? undefined,
    now,
  };
}

interface BatchFilter {
  itemId?: string | undefined;
  source?: GradingSource | undefined;
  confidence?: GradingConfidence | undefined;
}

/**
 * F-GRADE-04, the "validate every high-confidence proposal of question 3"
 * button — for the proposals `isBatchable` (`@quiz/domain`) accepts. Each proposal becomes the very write a click would make
 * ({@link validationOf}), and they all go through {@link writeGradings} at
 * once — one transaction per chunk, not one per cell — so a batch leaves the
 * same history a click would.
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
  // The placeholders (0 points, no confidence: an essay, a manual circuit,
  // no runner) are left to a person — the same rule the panel counts by, so
  // it is read here in TypeScript rather than restated in SQL.
  const batchable = rows.filter(({ grading }) => isBatchable(grading)).map(({ grading }) => grading);
  const criteria = new Map((await joinedItems(db, evaluationId)).map((i) => [i.item.id, criteriaOf(i)]));
  const written = await writeGradings(
    db,
    batchable.map((grading) => validationOf(grading, {}, criteria.get(grading.itemId) ?? [], userId, now)),
  );
  return written.length;
}

/**
 * Readies ONE item for a regrade (F-GRADE-06): repoints it at version
 * `toVersionNumber` of its question when one is asked for, then stands down
 * every standing grading of it — the pass skips a cell that already holds a
 * validated grading, and nothing is deleted: the history of §4.5 is the whole
 * chain. Returns the note the pass writes on every new grading, or `null`
 * when the question has no such version (the route's 404).
 */
export async function regradeItem(
  db: Db,
  item: {
    evaluationId: string;
    itemId: string;
    questionId: string;
    /** The variables of the version the item holds now (ADR-056 §5). */
    variables: ParametersDraft | null;
  },
  input: { note: string; toVersionNumber?: number | undefined },
): Promise<string | null> {
  return db.transaction(async (tx) => {
    let note = input.note.trim();
    if (input.toVersionNumber !== undefined) {
      const [version] = await tx
        .select({ id: questionVersions.id, variables: questionVersions.variables })
        .from(questionVersions)
        .where(
          and(
            eq(questionVersions.questionId, item.questionId),
            eq(questionVersions.number, input.toVersionNumber),
          ),
        )
        .limit(1);
      if (!version) return null;
      // The values the students had are kept, and the new version's derived
      // rows replayed from them (ADR-056 §5): only under the same names.
      if (!sameTable(parametersOf(item), parametersOf(version))) throw new GradingError("variables_changed");
      await retargetItemVersion(tx, item.itemId, version.id);
      note = `${note} (re-graded with version ${input.toVersionNumber})`;
    }
    await tx
      .update(gradings)
      .set({ state: "superseded" })
      .where(and(eq(gradings.itemId, item.itemId), ne(gradings.state, "superseded")));
    // The item's cells are empty again: the pass that refills them completes a
    // new grid, and the staff hear of it (`ready.ts`, #286).
    await clearGradingReady(tx, item.evaluationId);
    return note;
  });
}

/**
 * The payload of a `grading.regrade` audit entry: written by the regrade
 * route, and read back by {@link checkLlmRegradeBudget} — one shape, so a
 * renamed key cannot silently reset the budgets.
 */
export const RegradeAudit = z.object({
  itemId: z.string(),
  note: z.string(),
  toVersionNumber: z.number().nullable(),
  modifiedAfterRelease: z.boolean(),
  /** The re-grade asked the model again: what the budget counts. */
  llm: z.literal(true).optional(),
});
export type RegradeAudit = z.infer<typeof RegradeAudit>;
const REGRADE_KEY = RegradeAudit.keyof().enum;

/**
 * Whether a re-grade of this item asks the model again — it did grade one of
 * its answers — and, then, the item's daily budget (audit L2): past
 * {@link LLM_REGRADES_PER_ITEM_PER_DAY} such re-grades today (Europe/Zurich,
 * the server's clock), `429 llm_budget_exhausted`. The count is the audit
 * log's: the regrade route records each one with `llm: true`. Two re-grades
 * of one item pressed at the same instant may both pass the count; the
 * budget bounds a day, not a race (ADR-058, amendment of 2026-10-11).
 */
export async function checkLlmRegradeBudget(db: Db, evaluationId: string, itemId: string, now: Date): Promise<boolean> {
  const [graded] = await db
    .select({ id: gradings.id })
    .from(gradings)
    .where(and(eq(gradings.itemId, itemId), eq(gradings.source, "llm")))
    .limit(1);
  if (!graded) return false;
  const [today] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "grading.regrade"),
        eq(auditLog.subjectId, evaluationId),
        sql`${auditLog.payload}->>${REGRADE_KEY.itemId} = ${itemId}`,
        sql`${auditLog.payload}->>${REGRADE_KEY.llm} = 'true'`,
        sql`${auditLog.createdAt} >= date_trunc('day', ${now.toISOString()}::timestamptz, ${SCHOOL_TIME_ZONE})`,
      ),
    );
  if ((today?.n ?? 0) >= LLM_REGRADES_PER_ITEM_PER_DAY) throw new GradingError("llm_budget_exhausted");
  return true;
}

/**
 * Stands down the AUTOMATIC gradings of one attempt (ADR-067): a reopened
 * exercise attempt was graded at its hand-in, and the pass never touches a
 * validated cell, so without this what the student rewrites would keep its
 * first grades. Every standing grading the machine alone wrote (`source`
 * `auto`, the runner's included, no `gradedBy`) is superseded with no
 * successor, the way {@link regradeItem} stands a cell down: the next hand-in
 * grades the cell again, and nothing is deleted (F-GRADE-05). What a teacher
 * settled stays: an override (`manual`), a proposal they validated (it keeps
 * its source but carries their `gradedBy`), and a model's proposal (`llm`,
 * never written while an evaluation runs).
 *
 * The caller holds the attempt's row lock (`reopenAttempt`): a grading write
 * of the jobs takes the same lock and re-reads the attempt's state under it,
 * so a pass that loaded the attempt finished never lands after this.
 */
export async function standDownAutomaticGradings(db: DbOrTx, attemptId: string): Promise<void> {
  await db
    .update(gradings)
    .set({ state: "superseded" })
    .where(
      and(
        eq(gradings.attemptId, attemptId),
        eq(gradings.source, "auto"),
        isNull(gradings.gradedBy),
        ne(gradings.state, "superseded"),
      ),
    );
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
  return rows.map(historyEntry);
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
  /** The item, for its range and its criteria (ADR-118 §6). */
  item: JoinedItem;
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
  const item = await joinedItem(db, row.evaluationId, row.itemId);
  if (!item) return null;
  return {
    evaluationId: row.evaluationId,
    attemptId: row.attemptId,
    itemId: row.itemId,
    answerId,
    maxPoints: item.item.points,
    item,
  };
}

/**
 * The TOTAL of each attempt — the validated points summed and floored at 0
 * (`attemptTotal`, ADR-026) — in one query. The same numbers as
 * {@link tallyByAttempt}, of which it is the points half.
 */
export async function pointsByAttempt(
  db: Db,
  attemptIds: readonly string[],
): Promise<Map<string, number>> {
  const tallies = await tallyByAttempt(db, attemptIds);
  return new Map([...tallies].map(([id, tally]) => [id, tally.points]));
}

/**
 * The grading-time counting act (ADR-108): `itemId` of `evaluation` becomes
 * `normal`, `bonus` or `neutralized`. The write is the evaluation module's
 * (`setItemCounting`: the frozen-list gate, the total that must stay above
 * 0); this orchestrates around it what a grading write does after the
 * release (ADR-030 §h): the grades the students are shown are read before,
 * the evaluation is marked modified after publication in the same
 * transaction as the change (so the frozen snapshot stops being served), and
 * the students whose shown grade moved are told after the commit. Stored
 * gradings are never touched. Null for an item the evaluation does not hold.
 */
export async function changeItemCounting(
  db: Db,
  evaluation: EvaluationRecord,
  itemId: string,
  counting: ItemCounting,
  now: Date,
): Promise<CountingChange | null> {
  const watch = await watchCounting(db, evaluation, itemId);
  const outcome = await db.transaction(async (tx): Promise<CountingChange | null> => {
    const before = await setItemCounting(tx, evaluation, itemId, counting);
    if (before === null) return null;
    // Choosing the counting it already has changes nothing, and flags nothing.
    if (before === counting) return { changed: false, before, modifiedAfterRelease: false };
    return { changed: true, before, modifiedAfterRelease: await setModifiedAfterRelease(tx, evaluation.id, now) };
  });
  if (outcome?.changed) await watch.announce();
  return outcome;
}

/** What {@link changeItemCounting} did: whether anything moved, from what, and the release flag. */
export interface CountingChange {
  changed: boolean;
  before: ItemCounting;
  modifiedAfterRelease: boolean;
}

/** The grades shown before a counting change; nothing to read on an evaluation not released. */
async function watchCounting(db: Db, evaluation: EvaluationRecord, itemId: string) {
  if (evaluation.releasedAt === null) return { announce: async () => {} };
  const owners = await db
    .select({ attemptId: attempts.id })
    .from(attempts)
    .where(eq(attempts.evaluationId, evaluation.id));
  return watchReleasedGrades(
    db,
    owners.map((o) => ({ attemptId: o.attemptId, itemId })),
    pointsByAttempt,
  );
}

/**
 * {@link pointsByAttempt} as the student saw it BEFORE a regrade touched
 * `cells`: on each of those cells that holds no validated grading, the
 * grading a regrade stood down counts instead — the newest `superseded` row
 * of the cell that nothing supersedes (`regradeItem` stands a cell down
 * without writing a successor; every other supersession links one). The
 * cells outside `cells` count as they stand. `results_updated` reads its
 * "before" through it, so a regrade that gives a student the same points
 * back tells nobody (ADR-030 §h, step 8).
 *
 * The state a stood-down row had is not kept: a PROPOSAL a regrade stood
 * down counts here as if it had been validated. It only matters for a cell
 * still a proposal when it was regraded, which the page did not count.
 */
export function pointsAcrossRegrade(
  cells: readonly { attemptId: string; itemId: string }[],
): (db: Db, attemptIds: readonly string[]) => Promise<Map<string, number>> {
  const touched = new Set(cells.map((c) => pairKey(c.attemptId, c.itemId)));
  return async (db, attemptIds) => {
    if (attemptIds.length === 0) return new Map();
    const rows = await db
      .select({
        attemptId: gradings.attemptId,
        itemId: gradings.itemId,
        points: gradings.points,
        state: gradings.state,
        counting: evaluationItems.counting,
      })
      .from(gradings)
      .innerJoin(evaluationItems, eq(evaluationItems.id, gradings.itemId))
      .where(
        and(
          inArray(gradings.attemptId, [...attemptIds]),
          or(
            eq(gradings.state, "validated"),
            and(
              eq(gradings.state, "superseded"),
              sql`not exists (select 1 from ${gradings} as successor where successor.attempt_id = ${gradings.attemptId} and successor.supersedes_id = ${gradings.id})`,
            ),
          ),
        ),
      )
      .orderBy(asc(gradings.gradedAt));
    // Per cell: a validated grading wins; otherwise, on a touched cell, the
    // newest stood-down one (ascending order: the last one read).
    const byCell = new Map<PairKey, { attemptId: string; points: number; counting: ItemCounting; validated: boolean }>();
    for (const row of rows) {
      const key = pairKey(row.attemptId, row.itemId);
      const validated = row.state === "validated";
      if (!validated && !touched.has(key)) continue;
      if (byCell.get(key)?.validated) continue;
      byCell.set(key, { attemptId: row.attemptId, points: row.points, counting: row.counting, validated });
    }
    const perAttempt = new Map<string, { points: number; counting: ItemCounting }[]>();
    for (const cell of byCell.values()) {
      const list = perAttempt.get(cell.attemptId);
      if (list) list.push(cell);
      else perAttempt.set(cell.attemptId, [cell]);
    }
    return new Map([...perAttempt].map(([id, points]) => [id, attemptTotal(points)]));
  };
}

// The kept attempt of each student (F-EVAL-15, ADR-025), in `./kept.ts`.
export {
  keptAttempts,
  scoreOf,
  studentAttempts,
  tallyByAttempt,
  type StudentAttempts,
} from "./kept.js";

// --- The partial retake (ADR-091) -------------------------------------------

/** The VALIDATED gradings of one attempt: what a partial retake reads, once. */
export async function validatedOfAttempt(db: DbOrTx, attemptId: string): Promise<GradingRecord[]> {
  return db
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.state, "validated")));
}

/**
 * Each item's standing in one attempt (ADR-091 §2), in the order of
 * `items`, computed ONCE from that attempt's validated gradings
 * (`validatedOfAttempt`): the retake and the results page read it, and
 * `acquiredItems` / `partialRetakeRefusal` take it as it is.
 */
export function standingsOf(
  items: readonly JoinedItem[],
  validated: readonly Pick<GradingRecord, "itemId" | "points">[],
): StoodItem[] {
  const points = new Map(validated.map((g) => [g.itemId, g.points]));
  return items.map((item) => ({
    id: item.item.id,
    standing: itemStanding({ maxPoints: item.item.points, validatedPoints: points.get(item.item.id) ?? null }),
  }));
}

/**
 * Copies validated gradings of attempt n onto the partial retake n + 1
 * (ADR-091 §3) — exactly the `rows` the retake read, inside its
 * transaction, so no override can slip between the read and the copy. A
 * frozen snapshot: new ids, the copied answer (`answerIds`, item → the
 * copy's id, `null` for an item that had none), a chain of its own
 * (`supersedesId` null).
 *
 * The cell then holds a validated grading, so the hand-in pass skips it like
 * any settled cell; a regrade of the item (`regradeItem`) stands it down and
 * grades the copied answer again. The evaluation is running, so no released
 * grade can move and `flagReleasedEvaluationsOf` has nothing to do.
 */
export async function copyGradings(
  tx: DbOrTx,
  input: {
    rows: readonly GradingRecord[];
    toAttemptId: string;
    answerIds: ReadonlyMap<string, string | null>;
    now: Date;
  },
): Promise<void> {
  if (input.rows.length === 0) return;
  await tx.insert(gradings).values(
    input.rows.map((row) => ({
      ...row,
      id: randomUUID(),
      attemptId: input.toAttemptId,
      answerId: input.answerIds.get(row.itemId) ?? null,
      supersedesId: null,
      createdAt: input.now,
    })),
  );
}
