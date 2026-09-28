/**
 * `results_updated` (ADR-030, addendum §c and §h.4–5; F-NOTIF-07): a student
 * is told when a correction after the release changes their FINAL GRADE on
 * the evaluation's scale — the grade the results page shows
 * (`shownGrades`, the one rule), read before the grading write and again
 * after it has committed. Points that move without changing the rounded
 * grade tell nobody, and nothing is stored: the "before" lives in memory for
 * the length of one write.
 *
 * The hook is the single grading writer (`grading.writeGradings`), so every
 * path that validates a grading — a click, an override, a batch, the
 * automatic pass, a runner job, the pass of a regrade — goes through it, once
 * per WRITE and never once per cell: a batch of twenty cells across five
 * students reads five grades before and five after, and tells at most five
 * students once each.
 *
 * Best-effort, as every notification a user's action raises (§h): a failure
 * here is logged and never fails the grading write, which has committed.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { attempts, evaluations } from "../../db/schema.js";
import { byId, staffAttemptIds, type EvaluationRecord } from "../evaluation/service.js";
import { notifyMany, type Delivery } from "../notifications/service.js";
import { shownGrades, type ShownGrade } from "./service.js";

/** What a grading write holds between its "before" and its commit. */
export interface GradeWatch {
  /** After the commit: tells the students whose shown grade changed. Never throws. */
  announce(): Promise<void>;
}

const NOTHING: GradeWatch = { announce: async () => {} };

interface Watched {
  evaluation: EvaluationRecord;
  before: Map<string, ShownGrade>;
}

/**
 * Reads, BEFORE a grading write, the grade each owner of `attemptIds` is
 * shown on every RELEASED evaluation those attempts belong to. One query
 * finds them; an unreleased evaluation — every write of an ordinary grading
 * session — costs nothing more.
 */
export async function watchReleasedGrades(
  db: Db,
  attemptIds: readonly string[],
): Promise<GradeWatch> {
  if (attemptIds.length === 0) return NOTHING;
  try {
    const rows = await db
      .select({ evaluation: evaluations, userId: attempts.userId })
      .from(attempts)
      .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
      .where(
        and(
          inArray(attempts.id, [...attemptIds]),
          isNotNull(evaluations.releasedAt),
          isNotNull(attempts.userId),
        ),
      );
    if (rows.length === 0) return NOTHING;
    const owners = new Map<string, { evaluation: EvaluationRecord; userIds: Set<string> }>();
    for (const row of rows) {
      const entry = owners.get(row.evaluation.id) ?? {
        evaluation: row.evaluation,
        userIds: new Set<string>(),
      };
      entry.userIds.add(row.userId!);
      owners.set(row.evaluation.id, entry);
    }
    const watched: Watched[] = [];
    for (const { evaluation, userIds } of owners.values()) {
      watched.push({ evaluation, before: await shownGrades(db, evaluation, [...userIds]) });
    }
    return { announce: () => announceChanges(db, watched) };
  } catch (err) {
    // The service layer has no logger (as `realtime/bus.ts`): stderr, which
    // the process log collects.
    console.error("results: reading the grades before a grading write failed", err);
    return NOTHING;
  }
}

/**
 * The students whose shown grade differs, told once each per write. The
 * evaluation is read again: a release withdrawn meanwhile tells nobody, and
 * the grade after is the one the page serves now (`modified_after_release`,
 * raised by the write, stops serving the frozen one). A teacher's own test
 * (ADR-018) is not a result anybody is told about.
 */
async function announceChanges(db: Db, watched: readonly Watched[]): Promise<void> {
  for (const { evaluation, before } of watched) {
    try {
      const current = await byId(db, evaluation.id);
      if (!current || current.releasedAt === null) continue;
      const [after, staff] = await Promise.all([
        shownGrades(db, current, [...before.keys()]),
        staffAttemptIds(db, current),
      ]);
      const deliveries: Delivery[] = [];
      for (const [userId, shown] of after) {
        if (!shown.visible || shown.attemptId === null || staff.has(shown.attemptId)) continue;
        if (shown.grade === before.get(userId)?.grade) continue;
        deliveries.push({
          userId,
          payload: {
            kind: "results_updated",
            evaluationId: current.id,
            evaluationTitle: current.title,
            attemptId: shown.attemptId,
            count: 1,
          },
        });
      }
      await notifyMany(db, deliveries);
    } catch (err) {
      console.error(`results: telling the students of ${evaluation.id} of a new grade failed`, err);
    }
  }
}
