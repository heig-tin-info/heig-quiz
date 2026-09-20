/**
 * Events of the `grading` and `results` modules (PLAN-MVP §4.8 routing
 * table).
 *
 * Thin adapters over `modules/realtime/bus.ts`, exactly like
 * `modules/live/events.ts`: this file names the domain fact, the bus decides
 * the topics, the audience and the coalescing (§10, "never publish an event
 * directly").
 */
import { eq } from "drizzle-orm";

import type { GradingProgressEvent } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { classrooms, courseStaff } from "../../db/schema.js";
import * as bus from "../realtime/bus.js";
import type { EvaluationRecord } from "../evaluation/service.js";

/**
 * The teaching staff of the course an evaluation belongs to. They hold
 * `teacher:<id>` on every connection, so progress reaches them whether or not
 * the dashboard is the screen they are looking at.
 */
export async function staffOf(db: Db, evaluation: EvaluationRecord): Promise<string[]> {
  const rows = await db
    .select({ userId: courseStaff.userId })
    .from(courseStaff)
    .innerJoin(classrooms, eq(classrooms.courseId, courseStaff.courseId))
    .where(eq(classrooms.id, evaluation.classroomId));
  return [...new Set(rows.map((r) => r.userId))];
}

export function progress(
  evaluation: EvaluationRecord,
  teacherIds: readonly string[],
  input: { done: number; total: number; phase: GradingProgressEvent["phase"] },
): void {
  bus.gradingProgress({ evaluationId: evaluation.id, teacherIds, ...input });
  // The refresh hint the panel and the dashboard react to (ADR-005).
  bus.hint("grading", [
    `evaluation:${evaluation.id}`,
    `classroom:${evaluation.classroomId}`,
    ...teacherIds.map((id) => `teacher:${id}` as const),
  ]);
}

/** One grading changed: no payload, the panel re-reads what it is allowed to. */
export function gradingChanged(evaluation: EvaluationRecord): void {
  bus.hint("grading", [`evaluation:${evaluation.id}`, `classroom:${evaluation.classroomId}`]);
}

/** Results released or withdrawn: the students' own streams hear it too. */
export function resultsChanged(evaluation: EvaluationRecord, userIds: readonly string[]): void {
  bus.hint("results", [
    `evaluation:${evaluation.id}`,
    `classroom:${evaluation.classroomId}`,
    ...userIds.map((id) => `user:${id}` as const),
  ]);
}
