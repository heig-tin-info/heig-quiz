/**
 * The student's Grades page (`GET /student/results`, F-RES-04, F-ORG-14):
 * the home's Past (`studentBoard`), every classroom's, archived ones
 * included, by classroom. Depends on `attempt.ts` only.
 */
import { isFinishedAttempt } from "@quiz/domain";
import type { CardResults, EvaluationGradeRow, GradeGroup, GradeStatus, StudentGrades } from "@quiz/contracts";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { gradeReadable } from "../results/service.js";
import { studentBoard, type PastEntry } from "./attempt.js";

/**
 * The classroom of the newest row first, each newest first. A row says where
 * it stands; it carries points and a grade only where the student may read
 * them (`gradeReadable`), the indicative points alone where the feedback
 * page already shows them before the release (`PastEntry.early`), and opens
 * the feedback page only where it has something to show. A staff seat that
 * took no attempt is not listed (ADR-018 §3).
 */
export async function studentGrades(db: Db, userId: string, now: Date): Promise<StudentGrades> {
  const { past } = await studentBoard(db, userId, now);
  const groups = new Map<string, GradeGroup>();
  for (const entry of past) {
    if (entry.row.staff && entry.row.attempt === null) continue;
    const id = entry.card.classroomId;
    const group = groups.get(id) ?? {
      classroom: {
        id,
        name: entry.row.classroomName,
        courseCode: entry.row.courseCode,
        courseName: entry.row.courseName,
        period: entry.row.period,
        archived: entry.row.archivedAt !== null,
      },
      rows: [],
    };
    group.rows.push(gradeRow(entry));
    groups.set(id, group);
  }
  const newest = (g: GradeGroup) => g.rows[0]!.date;
  return [...groups.values()]
    .map((g) => ({ ...g, rows: g.rows.sort((a, b) => b.date.localeCompare(a.date)) }))
    .sort((a, b) => newest(b).localeCompare(newest(a)));
}

/**
 * Where a finished evaluation stands for the student; see `GradeStatus`. A
 * released evaluation whose feedback policy will never show anything
 * (results `none`) is `withheld`: released, and its grade not shared.
 */
export function gradeStatus(fact: {
  handedIn: boolean;
  released: boolean;
  results: CardResults;
}): GradeStatus {
  if (!fact.handedIn) return "missed";
  if (fact.released) return fact.results === "none" ? "withheld" : "released";
  if (fact.results === "available") return "available";
  if (fact.results === "pending") return "pending";
  return "submitted";
}

/**
 * The released points and grade where the student may read them; before the
 * release, the feedback page's points, indicative, no grade, and its count
 * of questions still pending.
 */
function scoreOf({ row, counted, released, early }: PastEntry): EvaluationGradeRow["score"] {
  if (released && gradeReadable(row.evaluation, counted?.state ?? null)) {
    return {
      points: released.points,
      totalPoints: released.totalPoints,
      grade: released.grade,
      pendingCount: 0,
    };
  }
  if (early) {
    const { points, totalPoints, pendingCount } = early;
    return { points, totalPoints, grade: null, pendingCount };
  }
  return null;
}

function gradeRow(entry: PastEntry): EvaluationGradeRow {
  const { row, card, counted } = entry;
  const { evaluation, attempt } = row;
  return {
    kind: "evaluation",
    evaluationId: evaluation.id,
    title: evaluation.title,
    mode: evaluation.mode,
    date: iso(
      attempt?.submittedAt ??
        attempt?.closedAt ??
        evaluation.closedAt ??
        evaluation.closesAt ??
        evaluation.createdAt,
    ),
    status: gradeStatus({
      handedIn: attempt !== null && isFinishedAttempt(attempt.state),
      released: evaluation.releasedAt !== null,
      results: card.results,
    }),
    // `results` is the counted attempt's own (`resultsState`).
    feedbackAttemptId: card.results === "available" ? (counted?.id ?? null) : null,
    score: scoreOf(entry),
  };
}
