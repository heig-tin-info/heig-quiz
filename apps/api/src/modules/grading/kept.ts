/**
 * The KEPT attempt of each student (F-EVAL-15, ADR-025): which of several
 * attempts on an exercise is the student's result, `best` or `last`.
 *
 * The rule is `@quiz/domain#keptAttempt`; this file only feeds it the
 * validated points of each attempt. The results, the CSV, the release, the
 * per-question statistics and the student's own cards all read it from here,
 * so they can never disagree on which attempt counts. An evaluation where
 * every student holds one attempt — every exam, every exercise without
 * retakes — costs one query and no points at all.
 *
 * Imported through `./service.ts`. It reads `attempts` (the `live` module's)
 * by select and `gradings` (this module's), and writes nothing.
 */
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";

import type { AttemptScore } from "@quiz/contracts";
import { attemptTotal, keptAttempt } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { attempts, gradings } from "../../db/schema.js";
import { retakePolicyOf, type EvaluationRecord } from "../evaluation/service.js";

type AttemptRecord = typeof attempts.$inferSelect;

/**
 * The validated points of an attempt and how many of its cells they cover.
 * `points` is the attempt's TOTAL (`attemptTotal`): floored at 0, so a
 * negative sum under negative marking (ADR-026) is 0 here, in the kept rule
 * and on every screen that reads it.
 */
export interface AttemptTally {
  points: number;
  graded: number;
}

/** {@link AttemptTally} per attempt, in one grouped query. Absent = nothing validated. */
export async function tallyByAttempt(
  db: Db,
  attemptIds: readonly string[],
): Promise<Map<string, AttemptTally>> {
  if (attemptIds.length === 0) return new Map();
  const rows = await db
    .select({
      attemptId: gradings.attemptId,
      points: sql<string>`sum(${gradings.points})`,
      graded: count(),
    })
    .from(gradings)
    .where(and(inArray(gradings.attemptId, [...attemptIds]), eq(gradings.state, "validated")))
    .groupBy(gradings.attemptId);
  return new Map(
    rows.map((r) => [r.attemptId, { points: attemptTotal([Number(r.points)]), graded: r.graded }]),
  );
}

/**
 * The score a student reads between two attempts (ADR-025): the validated
 * points, and whether some item has none yet.
 */
export function scoreOf(
  tally: AttemptTally | undefined,
  itemCount: number,
  totalPoints: number,
): AttemptScore {
  return {
    points: tally?.points ?? 0,
    totalPoints,
    pending: (tally?.graded ?? 0) < itemCount,
  };
}

/** One student's attempts, the kept one among them by the evaluation's rule. */
function keptAmong(
  evaluation: EvaluationRecord,
  rows: readonly AttemptRecord[],
  tallies: ReadonlyMap<string, AttemptTally>,
): AttemptRecord | null {
  if (rows.length <= 1) return rows[0] ?? null;
  const scored = rows.map((row) => ({ ...row, points: tallies.get(row.id)?.points ?? 0 }));
  const kept = keptAttempt(scored, retakePolicyOf(evaluation).keep);
  return kept === null ? null : (rows.find((r) => r.id === kept.id) ?? null);
}

/** Groups attempt rows by their owning account; a guest's rows are left out. */
function byUser(rows: readonly AttemptRecord[]): Map<string, AttemptRecord[]> {
  const map = new Map<string, AttemptRecord[]>();
  for (const row of rows) {
    if (row.userId === null) continue;
    const list = map.get(row.userId) ?? [];
    list.push(row);
    map.set(row.userId, list);
  }
  return map;
}

/** Points are only needed for the students who hold more than one attempt. */
async function talliesFor(
  db: Db,
  groups: Iterable<readonly AttemptRecord[]>,
): Promise<Map<string, AttemptTally>> {
  const ids: string[] = [];
  for (const group of groups) if (group.length > 1) ids.push(...group.map((a) => a.id));
  return tallyByAttempt(db, ids);
}

/**
 * The kept attempt of every account that took `evaluation`, keyed by user
 * id. With one attempt per student it is simply that attempt.
 */
export async function keptAttempts(
  db: Db,
  evaluation: EvaluationRecord,
): Promise<Map<string, AttemptRecord>> {
  const rows = await db
    .select()
    .from(attempts)
    .where(eq(attempts.evaluationId, evaluation.id))
    .orderBy(asc(attempts.attemptNumber));
  const groups = byUser(rows);
  const tallies = await talliesFor(db, groups.values());
  const kept = new Map<string, AttemptRecord>();
  for (const [userId, list] of groups) {
    const row = keptAmong(evaluation, list, tallies);
    if (row) kept.set(userId, row);
  }
  return kept;
}

/** One student's attempts on one evaluation, and the one that counts. */
export interface StudentAttempts {
  all: AttemptRecord[];
  kept: AttemptRecord | null;
}

/**
 * {@link keptAttempts} for ONE student across several evaluations — the
 * student home and the results cards — in two queries whatever their number.
 */
export async function studentAttempts(
  db: Db,
  userId: string,
  rows: readonly EvaluationRecord[],
): Promise<Map<string, StudentAttempts>> {
  if (rows.length === 0) return new Map();
  const found = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.userId, userId), inArray(attempts.evaluationId, rows.map((r) => r.id))))
    .orderBy(asc(attempts.attemptNumber));
  const groups = new Map<string, AttemptRecord[]>();
  for (const row of found) {
    const list = groups.get(row.evaluationId) ?? [];
    list.push(row);
    groups.set(row.evaluationId, list);
  }
  const tallies = await talliesFor(db, groups.values());
  const out = new Map<string, StudentAttempts>();
  for (const evaluation of rows) {
    const all = groups.get(evaluation.id) ?? [];
    out.set(evaluation.id, { all, kept: keptAmong(evaluation, all, tallies) });
  }
  return out;
}
