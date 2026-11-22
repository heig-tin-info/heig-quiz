/**
 * Deleting what holds students' work is refused (ADR-141) — a pure rule
 * (invariant 8). The services read the facts under the row locks of the
 * delete's transaction; this decides, and sums what blocks for the 409
 * `holds_student_work`.
 *
 * Students' work is a REAL student's: a staff seat's attempt, repository or
 * mark (ADR-018) is none, and a poll holds votes, never grades.
 */
import type { EvaluationModeName } from "./evaluationConfig.js";

/** What blocks a deletion, by kind and how many: never a name. */
export interface StudentWork {
  /** The classrooms holding one of the activities below. */
  classrooms: number;
  /** The exams and exercises holding students' work. */
  evaluations: number;
  /** The projects holding a graded repository, a score in the gradebook, or released. */
  projects: number;
  /** The students' attempts on those evaluations: started, submitted, or a paper copy. */
  attempts: number;
  /** The students' graded repositories of those projects. */
  gradedRepos: number;
  /** The students' scores in the gradebook columns of those activities. */
  marks: number;
  /** Those evaluations and projects that are released. */
  released: number;
}

/** An exam's, an exercise's or a poll's facts, read under the delete's locks. */
export interface EvaluationWorkFacts {
  /** Null for a course template or an anonymous poll, which never block. */
  classroomId: string | null;
  mode: EvaluationModeName;
  released: boolean;
  /**
   * A student's attempts that hold work: started (`started_at`), submitted
   * (`submitted_at`) or a paper copy (`origin = 'paper'`, entered by the
   * teacher with neither start nor deadline). A staff seat's left out.
   */
  attemptsWithWork: number;
  /** The `score` marks of the evaluation's gradebook column, on a student's seat; an absence or an excuse is no grade. */
  scoreMarks: number;
}

/** A project's facts, read under the delete's locks. */
export interface ProjectWorkFacts {
  classroomId: string;
  released: boolean;
  /** Student repositories with a score, an adjustment, a validated criterion or any CI run. */
  gradedRepos: number;
  /** As {@link EvaluationWorkFacts.scoreMarks}, for the project's column. */
  scoreMarks: number;
}

/**
 * An exam or an exercise holds students' work once a student has started or
 * submitted an attempt (a paper copy included), once a student has a score
 * in its gradebook column, or once it was released. A poll never does.
 */
export function evaluationHoldsStudentWork(facts: Omit<EvaluationWorkFacts, "classroomId">): boolean {
  return facts.mode !== "poll" && (facts.released || facts.attemptsWithWork > 0 || facts.scoreMarks > 0);
}

/**
 * A project holds students' work once one of its student repositories is
 * graded, once a student has a score in its gradebook column, or once it
 * was released. A draft has none of them.
 */
export function projectHoldsStudentWork(facts: Omit<ProjectWorkFacts, "classroomId">): boolean {
  return facts.released || facts.gradedRepos > 0 || facts.scoreMarks > 0;
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
    attempts: evaluations.reduce((n, e) => n + e.attemptsWithWork, 0),
    gradedRepos: projects.reduce((n, p) => n + p.gradedRepos, 0),
    marks: blocking.reduce((n, a) => n + a.scoreMarks, 0),
    released: blocking.filter((a) => a.released).length,
  };
}
