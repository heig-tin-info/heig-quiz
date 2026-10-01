/**
 * The student's Grades page (`GET /student/results`, F-RES-04, F-ORG-14):
 * the home's Past (`studentBoard`), every classroom's, archived ones
 * included, by classroom. Depends on `attempt.ts` only.
 */
import { isFinishedAttempt } from "@quiz/domain";
import type { CardResults, GradeGroup, GradeRow, GradeStatus, StudentGrades } from "@quiz/contracts";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { totalPointsByEvaluation } from "../evaluation/service.js";
import { tallyByAttempt } from "../grading/service.js";
import { gradeReadable } from "../results/service.js";
import { studentBoard, type PastEntry } from "./attempt.js";

/** The indicative points of an `available` row, by its counted attempt's id. */
type Indicative = ReadonlyMap<string, { points: number; totalPoints: number }>;

/**
 * The classroom of the newest row first, each newest first. A row says where
 * it stands; it carries points and a grade only where the student may read
 * them (`gradeReadable`), the indicative points alone where the feedback
 * page already shows them before the release (`available`), and opens the
 * feedback page only where it has something to show. A staff seat that took
 * no attempt is not listed (ADR-018 §3).
 */
export async function studentGrades(db: Db, userId: string, now: Date): Promise<StudentGrades> {
  const { past } = await studentBoard(db, userId, now);
  const listed = past.filter((entry) => !(entry.row.staff && entry.row.attempt === null));
  const indicative = await indicativePoints(db, listed);
  const groups = new Map<string, GradeGroup>();
  for (const entry of listed) {
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
    group.rows.push(gradeRow(entry, indicative));
    groups.set(id, group);
  }
  const newest = (g: GradeGroup) => g.rows[0]!.date;
  return [...groups.values()]
    .map((g) => ({ ...g, rows: g.rows.sort((a, b) => b.date.localeCompare(a.date)) }))
    .sort((a, b) => newest(b).localeCompare(newest(a)));
}

/**
 * The points the feedback page shows before the release, for every row that
 * has one to show: the validated points of the counted attempt over the
 * evaluation's total — `studentFeedback`'s, read the way the home's kept
 * score reads them (`tallyByAttempt`, `totalPointsByEvaluation`). Two
 * grouped queries for the page, none when no row is `available`.
 */
async function indicativePoints(db: Db, entries: readonly PastEntry[]): Promise<Indicative> {
  const shown = entries.filter(
    (e) => e.counted !== null && e.row.evaluation.releasedAt === null && e.card.results === "available",
  );
  const [tallies, totals] = await Promise.all([
    tallyByAttempt(db, shown.map((e) => e.counted!.id)),
    totalPointsByEvaluation(db, [...new Set(shown.map((e) => e.row.evaluation.id))]),
  ]);
  return new Map(
    shown.map((e) => [
      e.counted!.id,
      {
        points: tallies.get(e.counted!.id)?.points ?? 0,
        totalPoints: totals.get(e.row.evaluation.id) ?? 0,
      },
    ]),
  );
}

/**
 * Where a finished evaluation stands for the student; see `GradeStatus`. A
 * released evaluation whose feedback page shows nothing (the policy `none`)
 * is `withheld`: released, and its grade not shared.
 */
export function gradeStatus(fact: {
  handedIn: boolean;
  released: boolean;
  results: CardResults;
}): GradeStatus {
  if (!fact.handedIn) return "missed";
  if (fact.released) return fact.results === "available" ? "released" : "withheld";
  if (fact.results === "available") return "available";
  if (fact.results === "pending") return "pending";
  return "submitted";
}

function gradeRow({ row, card, counted, released }: PastEntry, indicative: Indicative): GradeRow {
  const { evaluation, attempt } = row;
  const status = gradeStatus({
    handedIn: attempt !== null && isFinishedAttempt(attempt.state),
    released: evaluation.releasedAt !== null,
    results: card.results,
  });
  const early = status === "available" && counted ? indicative.get(counted.id) : undefined;
  return {
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
    status,
    // `results` is the counted attempt's own (`resultsState`).
    feedbackAttemptId: card.results === "available" ? (counted?.id ?? null) : null,
    score:
      released && gradeReadable(evaluation, counted?.state ?? null)
        ? { points: released.points, totalPoints: released.totalPoints, grade: released.grade }
        : early
          ? { ...early, grade: null }
          : null,
  };
}
