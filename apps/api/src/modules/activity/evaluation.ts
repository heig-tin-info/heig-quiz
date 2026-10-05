/**
 * The evaluation kind of activity (exam, exercise, and poll as a mode,
 * ADR-014). An adapter, not new behaviour: each method is what the
 * evaluation module already answers. It lives here rather than in the
 * evaluation module so that the later members (the student's cards from
 * `live`, the gradebook entries from `results`) need no import the
 * evaluation module does not already make.
 *
 * The gradebook entries (M5-03a, F-GBOOK, ADR-074) read, never recompute:
 * the staff's cells are the evaluation's results (`resultsView`, the table
 * of the results page), the student's the rows of their Grades page
 * (`studentGrades`: F-RES-04's policy, the counted attempt of F-EVAL-15).
 * A released exam not taken is an absence (a1.0), an exercise not taken an
 * empty cell (`notTakenCell`); a poll never has a column.
 */
import type { EvaluationCard, EvaluationGradeRow, GradebookStudentCell } from "@quiz/contracts";
import { ABSENT_GRADE, gradeFromPoints, isFinishedAttempt, notTakenCell } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { gradebookEvaluations, listActivities, scaleOf, type EvaluationRecord } from "../evaluation/service.js";
import { ownEvaluationAccess } from "../guards.js";
import { studentGrades, studentHome } from "../live/service.js";
import { resultsView } from "../results/service.js";
import type {
  ActivityKind,
  CardOf,
  GradebookBeneath,
  GradebookEntryFacts,
  GradebookSeat,
  StudentGradebookEntry,
} from "./kind.js";

const tagged = (cards: EvaluationCard[]): CardOf<"evaluation">[] =>
  cards.map((card) => ({ kind: "evaluation", ...card }));

/** An exam or an exercise: the only modes with a column. */
const columnMode = (ev: EvaluationRecord) => (ev.mode === "exam" ? "exam" : "exercise");

function facts(ev: EvaluationRecord): GradebookEntryFacts {
  return {
    kind: "evaluation",
    activityId: ev.id,
    mode: columnMode(ev),
    title: ev.title,
    date: ev.opensAt ?? ev.createdAt,
    released: ev.releasedAt !== null,
    markGrade: (points, max) => gradeFromPoints(points, max, scaleOf(ev)),
  };
}

/**
 * The staff's cell of each seat: the results page's row, or what an
 * evaluation not taken is — an absence once released, for an exam.
 */
async function staffCells(
  db: Db,
  ev: EvaluationRecord,
  seats: readonly GradebookSeat[],
): Promise<Map<string, GradebookBeneath>> {
  const view = await resultsView(db, ev);
  const byUser = new Map(view.rows.filter((r) => !r.staff).map((r) => [r.userId, r]));
  const released = ev.releasedAt !== null;
  return new Map(
    seats.map(({ enrollmentId, userId }): [string, GradebookBeneath] => {
      const row = byUser.get(userId);
      if (row !== undefined && row.state !== "absent" && isFinishedAttempt(row.state)) {
        return [
          enrollmentId,
          {
            outcome: { kind: "grade", grade: row.grade },
            points: row.points,
            max: view.totalPoints,
            source: "results",
            changedAfterRelease: released && ev.modifiedAfterRelease,
            hasGrade: true,
          },
        ];
      }
      const outcome = released ? notTakenCell(columnMode(ev)) : ({ kind: "empty" } as const);
      return [
        enrollmentId,
        {
          outcome,
          points: null,
          max: null,
          source: outcome.kind === "absent" ? "derived" : null,
          changedAfterRelease: false,
          hasGrade: false,
        },
      ];
    }),
  );
}

const NOTHING = { grade: null, points: null, max: null } as const;

/**
 * The student's cell of one evaluation from their Grades row (F-RES-04):
 * before the release, indicative points where the feedback page shows them
 * and never a grade; once released, the grade the row carries — none under
 * the policy `none` (`withheld`) —; a released exam not taken is an absence.
 * A staff mark shows only on a released column that is not withheld.
 */
function studentCell(
  ev: EvaluationRecord,
  row: EvaluationGradeRow,
): { cell: GradebookStudentCell; markShown: boolean } {
  const score = row.score;
  if (ev.releasedAt === null) {
    return {
      cell: score
        ? { kind: "indicative", grade: null, points: score.points, max: score.totalPoints }
        : { kind: "empty", ...NOTHING },
      markShown: false,
    };
  }
  if (score === null || score.grade === null) return { cell: { kind: "withheld", ...NOTHING }, markShown: false };
  if (row.status === "missed") {
    const absent = notTakenCell(columnMode(ev)).kind === "absent";
    return {
      cell: absent ? { kind: "absent", grade: ABSENT_GRADE, points: null, max: null } : { kind: "empty", ...NOTHING },
      markShown: true,
    };
  }
  return { cell: { kind: "grade", grade: score.grade, points: score.points, max: score.totalPoints }, markShown: true };
}

export const evaluationActivity: ActivityKind<"evaluation"> = {
  kind: "evaluation",
  listForTeacher: (db, caller, now) => listActivities(db, ownEvaluationAccess(caller), now),
  /** The evaluations' board, every classroom or one: the same rows, sorted the same way. */
  async studentCards(db, caller, now, scope) {
    const home = await studentHome(db, caller.id, now, scope.classroomId);
    return {
      polls: home.polls,
      open: tagged(home.open),
      upcoming: tagged(home.upcoming),
      past: tagged(home.past),
    };
  },
  async gradebookEntries(db, classroomId) {
    return (await gradebookEvaluations(db, classroomId)).map((ev) => ({
      ...facts(ev),
      staffCells: (cellsDb, seats) => staffCells(cellsDb, ev, seats),
    }));
  },
  /** An evaluation the student has no Grades row for (open, or not theirs yet) has no column for them. */
  async studentGradebookEntries(db, userId, _seat, classroomId, now) {
    const [evaluations, groups] = await Promise.all([
      gradebookEvaluations(db, classroomId),
      studentGrades(db, userId, now, classroomId),
    ]);
    const rows = new Map<string, EvaluationGradeRow>();
    for (const row of groups.flatMap((g) => g.rows)) if (row.kind === "evaluation") rows.set(row.evaluationId, row);
    return evaluations.flatMap((ev): StudentGradebookEntry[] => {
      const row = rows.get(ev.id);
      return row === undefined ? [] : [{ ...facts(ev), ...studentCell(ev, row) }];
    });
  },
};
