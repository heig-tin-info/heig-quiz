/**
 * Deleting what holds students' work is refused (ADR-141) — a pure rule
 * (invariant 8). The services read the facts under the row locks of the
 * delete's transaction; this decides, and sums what blocks for the 409
 * `holds_student_work`.
 *
 * Students' work is a REAL student's: a staff seat's attempt or repository
 * (ADR-018) is none, and a poll holds votes, never grades.
 */
import type { EvaluationModeName } from "./evaluationConfig.js";

/** What blocks a deletion, by kind and how many: never a name. */
export interface StudentWork {
  /** The classrooms holding one of the activities below. */
  classrooms: number;
  /** The exams and exercises holding students' work. */
  evaluations: number;
  /** The projects holding a graded repository or released. */
  projects: number;
  /** The students' started attempts on those evaluations. */
  attempts: number;
  /** The students' graded repositories of those projects. */
  gradedRepos: number;
  /** Those evaluations and projects that are released. */
  released: number;
}

/** An exam's, an exercise's or a poll's facts, read under the delete's locks. */
export interface EvaluationWorkFacts {
  /** Null for a course template or an anonymous poll, which never block. */
  classroomId: string | null;
  mode: EvaluationModeName;
  released: boolean;
  /** Attempts with a `started_at`, a staff seat's left out. */
  startedStudentAttempts: number;
}

/** A project's facts, read under the delete's locks. */
export interface ProjectWorkFacts {
  classroomId: string;
  released: boolean;
  /** Student repositories with a score, an adjustment, a validated criterion or a counted run. */
  gradedRepos: number;
}

/**
 * An exam or an exercise holds students' work once a student has started an
 * attempt or once it was released. A poll never does.
 */
export function evaluationHoldsStudentWork(facts: Omit<EvaluationWorkFacts, "classroomId">): boolean {
  return facts.mode !== "poll" && (facts.released || facts.startedStudentAttempts > 0);
}

/**
 * A project holds students' work once one of its student repositories is
 * graded or once it was released. A draft has neither.
 */
export function projectHoldsStudentWork(facts: Omit<ProjectWorkFacts, "classroomId">): boolean {
  return facts.released || facts.gradedRepos > 0;
}

/**
 * What blocks deleting the evaluations and projects given (one of them, a
 * classroom's, a course's), or null when nothing does and the deletion may
 * go ahead. A course template holds no attempt and is never released: it
 * never blocks, and the callers leave it out.
 */
export function studentWorkOf(input: {
  evaluations: readonly EvaluationWorkFacts[];
  projects: readonly ProjectWorkFacts[];
}): StudentWork | null {
  const evaluations = input.evaluations.filter(evaluationHoldsStudentWork);
  const projects = input.projects.filter(projectHoldsStudentWork);
  if (evaluations.length + projects.length === 0) return null;
  const blocking = [...evaluations, ...projects];
  return {
    classrooms: new Set(blocking.map((a) => a.classroomId)).size,
    evaluations: evaluations.length,
    projects: projects.length,
    attempts: evaluations.reduce((n, e) => n + e.startedStudentAttempts, 0),
    gradedRepos: projects.reduce((n, p) => n + p.gradedRepos, 0),
    released: blocking.filter((a) => a.released).length,
  };
}
