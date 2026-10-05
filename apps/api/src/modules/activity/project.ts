/**
 * The project kind of activity (F-PROJ, ADR-035 §2). An adapter, like
 * `evaluation.ts`: each method is what the `project` module answers.
 *
 * - `listForTeacher` (M3-02): the projects of every classroom the caller
 *   holds a staff seat on, drafts included, archived ones and archived
 *   classrooms left out — `staffAccess` in the WHERE (invariant 6).
 * - `studentCards` (M3-09a): the published projects of the classrooms where
 *   the caller holds a claimed seat, through the project's student view
 *   (`studentProjectCards`), its one exit (N-SEC-20) — never a draft, never
 *   an archived project, nothing of another student; none at all to a
 *   confined session, whose exam leads nowhere else.
 * - `gradebookEntries`, `studentGradebookEntries` (M5-03a, F-GBOOK): the
 *   graded projects that are no draft. The staff read the LIVE final score
 *   of each seat's repository with its source (I42); a student reads the
 *   release's snapshot of their own seat alone, and no column of a project
 *   not released yet (F-GBOOK-05). A seat that never accepted has no score:
 *   an empty cell, which a staff mark fills (spec 06 no. 48).
 */
import { projectGrade } from "@quiz/domain";

import {
  gradebookProjects,
  projectLiveScores,
  projectReleasedScore,
  studentProjectCards,
  teacherProjects,
  type ProjectRow,
} from "../project/service.js";
import type { ActivityKind, GradebookBeneath, GradebookEntryFacts, StudentGradebookEntry } from "./kind.js";

function facts(project: ProjectRow): GradebookEntryFacts {
  return {
    kind: "project",
    activityId: project.id,
    mode: "project",
    title: project.name,
    date: project.startAt,
    released: project.releasedAt !== null,
    markGrade: (points, max) => projectGrade(points, max, project.gradingScale).grade,
  };
}

const NO_SCORE: GradebookBeneath = {
  outcome: { kind: "empty" },
  points: null,
  max: null,
  source: null,
  changedAfterRelease: false,
  hasGrade: false,
};

export const projectActivity: ActivityKind<"project"> = {
  kind: "project",
  listForTeacher: (db, caller) => teacherProjects(db, caller),
  studentCards: async (db, caller, now, scope) => ({
    polls: [],
    ...(scope.confined ? { open: [], upcoming: [], past: [] } : await studentProjectCards(db, caller.id, now, scope.classroomId)),
  }),
  async gradebookEntries(db, classroomId) {
    return (await gradebookProjects(db, classroomId)).map((project) => ({
      ...facts(project),
      async staffCells(cellsDb, seats) {
        const live = await projectLiveScores(cellsDb, project, seats.map((s) => s.enrollmentId));
        return new Map(
          seats.map(({ enrollmentId }): [string, GradebookBeneath] => {
            const score = live.get(enrollmentId);
            return [
              enrollmentId,
              score === undefined
                ? NO_SCORE
                : {
                    outcome: { kind: "grade", grade: score.grade },
                    points: score.points,
                    max: score.max,
                    source: score.source,
                    changedAfterRelease: score.changedAfterRelease,
                    hasGrade: true,
                  },
            ];
          }),
        );
      },
    }));
  },
  async studentGradebookEntries(db, _userId, seat, classroomId) {
    const released = (await gradebookProjects(db, classroomId)).filter((p) => p.releasedAt !== null);
    return Promise.all(
      released.map(async (project): Promise<StudentGradebookEntry> => {
        const score = await projectReleasedScore(db, project, seat.enrollmentId);
        return {
          ...facts(project),
          cell: score
            ? { kind: "grade", grade: score.grade, points: score.points, max: score.max }
            : { kind: "empty", grade: null, points: null, max: null },
          markShown: true,
        };
      }),
    );
  },
};
