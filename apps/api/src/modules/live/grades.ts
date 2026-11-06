/**
 * The student's Grades page (`GET /student/results`, F-RES-04, F-ORG-14):
 * the home's Past (`studentBoard`), every classroom's, archived ones
 * included, by classroom, and the released projects of those classrooms.
 * Depends on `attempt.ts` and, for the projects, on the `project` module's
 * service (`studentProjectGrades`) only; its rows carry the gradebook
 * column's `counts` (ADR-074 §6, amendment of 2026-10-13).
 */
import { countsByDefault, evaluationColumnKind, isFinishedAttempt } from "@quiz/domain";
import type {
  CardResults,
  EvaluationGradeRow,
  GradeGroup,
  GradeRow,
  GradeStatus,
  ProjectGradeRow,
  StudentGrades,
} from "@quiz/contracts";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { studentProjectGrades, type StudentProjectGrade } from "../project/service.js";
import { gradeReadable } from "../results/service.js";
import { studentBoard, type PastEntry } from "./attempt.js";

/**
 * The classroom of the newest row first, each newest first. A row says where
 * it stands; it carries points and a grade only where the student may read
 * them (`gradeReadable`), the indicative points alone where the feedback
 * page already shows them before the release (`PastEntry.early`), and opens
 * the feedback page only where it has something to show. A staff seat that
 * took no attempt is not listed (ADR-018 §3). A project is listed once
 * released, with the release's snapshot ({@link projectRow}).
 */
export async function studentGrades(db: Db, userId: string, now: Date): Promise<StudentGrades> {
  const [evaluations, projects] = await Promise.all([
    evaluationRows(db, userId, now),
    studentProjectGrades(db, userId),
  ]);
  return grouped([
    ...evaluations,
    ...projects.flatMap((project) => {
      const row = projectRow(project);
      return row === null ? [] : [{ classroom: classroomHeader(project.project.classroomId, project), row }];
    }),
  ]);
}

/**
 * {@link studentGrades}' evaluation rows alone. `classroomId` narrows them
 * to one classroom the caller has loaded through `readableClassroom`: the
 * gradebook's student cells (M5-03a) read the same rows, never a second rule.
 */
export async function studentEvaluationGrades(db: Db, userId: string, now: Date, classroomId?: string): Promise<StudentGrades> {
  return grouped(await evaluationRows(db, userId, now, classroomId));
}

/** A row and the classroom it is listed under. */
interface Placed {
  classroom: GradeGroup["classroom"];
  row: GradeRow;
}

async function evaluationRows(db: Db, userId: string, now: Date, classroomId?: string): Promise<Placed[]> {
  const { past } = await studentBoard(db, userId, now, classroomId);
  return past
    .filter((entry) => !(entry.row.staff && entry.row.attempt === null))
    .map((entry) => ({ classroom: classroomHeader(entry.card.classroomId, entry.row), row: gradeRow(entry, countsOf(entry)) }));
}

/** A group's header (F-ORG-14), archived classrooms included and marked. */
function classroomHeader(
  id: string,
  facts: { classroomName: string; courseCode: string; courseName: string; period: string; archivedAt: Date | null },
): GradeGroup["classroom"] {
  const { classroomName: name, courseCode, courseName, period, archivedAt } = facts;
  return { id, name, courseCode, courseName, period, archived: archivedAt !== null };
}

/** By classroom, the classroom of the newest row first, each newest first. */
function grouped(placed: Placed[]): StudentGrades {
  const groups = new Map<string, GradeGroup>();
  for (const { classroom, row } of placed) {
    const group = groups.get(classroom.id) ?? { classroom, rows: [] };
    group.rows.push(row);
    groups.set(classroom.id, group);
  }
  const newest = (g: GradeGroup) => g.rows[0]!.date;
  return [...groups.values()]
    .map((g) => ({ ...g, rows: g.rows.sort((a, b) => b.date.localeCompare(a.date)) }))
    .sort((a, b) => newest(b).localeCompare(newest(a)));
}

/**
 * A released project's row: the release's snapshot, never recomputed; dated
 * by the release. None where the seat had no repository or no score at the
 * release — unless the teacher excused the student, which says so with no
 * score and counts nowhere (#969; product owner, 2026-11-06). Whether it
 * counts: the stored column's flag, else a project's default, as the
 * classroom's Grades tab reads it (`gradebook.db.test.ts`).
 */
function projectRow({ project, storedCounts, excused, score }: StudentProjectGrade): ProjectGradeRow | null {
  const facts = { kind: "project", projectId: project.id, title: project.name, date: iso(project.releasedAt!) } as const;
  if (excused) return { ...facts, status: "excused", counts: false, score: null };
  if (score === null) return null;
  return {
    ...facts,
    status: "released",
    counts: storedCounts ?? countsByDefault("project"),
    score: { points: score.points, totalPoints: score.max, grade: score.grade },
  };
}

/**
 * Whether the evaluation counts toward the mean: the teacher's flag on its
 * stored gradebook column (`storedCounts`, joined by `studentEvaluationRows`),
 * else its mode's default. The flag alone ever reaches the student, never the
 * weight (ADR-074, amendment of 2026-10-13). The classroom's Grades tab takes
 * the same flag from the gradebook's own `settingsOf` instead;
 * `gradebook.db.test.ts` ("tells the student whether each column counts…")
 * guards that the two agree.
 */
const countsOf = ({ row }: PastEntry): boolean =>
  row.storedCounts ?? countsByDefault(evaluationColumnKind(row.evaluation.mode));

/**
 * Where a finished evaluation stands for the student; see `GradeStatus`. A
 * released evaluation whose feedback policy will never show anything
 * (results `none`) is `withheld`: released, and its grade not shared. A
 * released one the teacher excused the student from is `excused`, whatever
 * else (#969): a mark is the staff's alone until the release (ADR-074).
 */
export function gradeStatus(fact: {
  handedIn: boolean;
  released: boolean;
  results: CardResults;
  excused: boolean;
}): GradeStatus {
  if (fact.released && fact.excused) return "excused";
  if (!fact.handedIn) return "missed";
  if (fact.released) return fact.results === "none" ? "withheld" : "released";
  if (fact.results === "available") return "available";
  if (fact.results === "pending") return "pending";
  return "submitted";
}

/**
 * The released points and grade where the student may read them; before the
 * release, the feedback page's points, indicative, no grade, and its count
 * of questions still pending. An excused row has none: it counts nowhere.
 */
function scoreOf({ row, counted, released, early }: PastEntry, status: GradeStatus): EvaluationGradeRow["score"] {
  if (status === "excused") return null;
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

function gradeRow(entry: PastEntry, counts: boolean): EvaluationGradeRow {
  const { row, card, counted } = entry;
  const { evaluation, attempt } = row;
  const status = gradeStatus({
    handedIn: attempt !== null && isFinishedAttempt(attempt.state),
    released: evaluation.releasedAt !== null,
    results: card.results,
    excused: row.excusedMarkId !== null,
  });
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
    status,
    // `results` is the counted attempt's own (`resultsState`).
    feedbackAttemptId: card.results === "available" ? (counted?.id ?? null) : null,
    // An excused row counts in no mean: never drawn with what counts (#969).
    counts: counts && status !== "excused",
    score: scoreOf(entry, status),
  };
}
