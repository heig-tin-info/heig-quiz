/** Moving questions between pools (ADR-017). */
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import {
  classrooms,
  coursePools,
  courseStaff,
  courses,
  evaluationItems,
  evaluations,
  questionVersions,
  questions,
} from "../../db/schema.js";
import type { QuestionRecord } from "./shared.js";
import { ensurePoolTags } from "./tags.js";
import { tagsOf } from "./questionList.js";

/**
 * A move would land two live questions on the same internal name in the
 * target pool (`questions_pool_name_uq`). A move KEEPS the name it moves —
 * unlike a copy, which invents one (ADR-017) — so the answer is a 409 that
 * names the offenders rather than a silent rename.
 */
export class MoveNameTaken extends Error {
  constructor(readonly names: string[]) {
    super("an internal name is already taken in the target pool");
    this.name = "MoveNameTaken";
  }
}
/** One course that plays a question being moved, with its classrooms. */
export interface UsingCourse {
  courseId: string;
  courseName: string;
  courseCode: string;
  classrooms: { id: string; name: string }[];
}

/**
 * Which COURSES play one of these questions, through an evaluation item
 * frozen on one of their versions.
 *
 * `evaluation_items`, `evaluations` and `classrooms` belong to other modules;
 * they are read by join here and never written (CLAUDE.md, Conventions) —
 * exactly as `isQuestionInUse` above already does.
 *
 * A move does not break those items: the version rows stay, and the item
 * points at a version, not at a pool. What it DOES break is the course's
 * ability to reach the question again — to add it to the next evaluation, to
 * re-freeze it on a newer version — because that goes through `course_pools`.
 * Hence the list, and the 409 the route builds from it.
 */
export async function coursesUsingQuestions(
  db: Db,
  questionIds: readonly string[],
): Promise<UsingCourse[]> {
  if (questionIds.length === 0) return [];
  const rows = await db
    .selectDistinct({
      courseId: courses.id,
      courseName: courses.name,
      courseCode: courses.code,
      classroomId: classrooms.id,
      classroomName: classrooms.name,
    })
    .from(evaluationItems)
    .innerJoin(questionVersions, eq(evaluationItems.questionVersionId, questionVersions.id))
    .innerJoin(evaluations, eq(evaluationItems.evaluationId, evaluations.id))
    .innerJoin(classrooms, eq(evaluations.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(inArray(questionVersions.questionId, [...questionIds]))
    .orderBy(asc(courses.code), asc(classrooms.name));
  const byCourse = new Map<string, UsingCourse>();
  for (const row of rows) {
    const found = byCourse.get(row.courseId) ?? {
      courseId: row.courseId,
      courseName: row.courseName,
      courseCode: row.courseCode,
      classrooms: [],
    };
    if (!found.classrooms.some((c) => c.id === row.classroomId)) {
      found.classrooms.push({ id: row.classroomId, name: row.classroomName });
    }
    byCourse.set(row.courseId, found);
  }
  return [...byCourse.values()];
}

/** Which of these courses already draw from the pool (`course_pools`). */
export async function coursesLinkedToPool(
  db: Db,
  poolId: string,
  courseIds: readonly string[],
): Promise<Set<string>> {
  if (courseIds.length === 0) return new Set();
  const rows = await db
    .select({ courseId: coursePools.courseId })
    .from(coursePools)
    .where(and(eq(coursePools.poolId, poolId), inArray(coursePools.courseId, [...courseIds])));
  return new Set(rows.map((r) => r.courseId));
}

/** The course ids, among these, the user holds a staff seat on. */
export async function staffSeatsOf(
  db: Db,
  userId: string,
  courseIds: readonly string[],
): Promise<Set<string>> {
  if (courseIds.length === 0) return new Set();
  const rows = await db
    .select({ courseId: courseStaff.courseId })
    .from(courseStaff)
    .where(and(eq(courseStaff.userId, userId), inArray(courseStaff.courseId, [...courseIds])));
  return new Set(rows.map((r) => r.courseId));
}

/**
 * Moves questions into a pool, with their tags, in ONE transaction.
 *
 * The question keeps its id, its internal name, its versions, its draft and
 * its history: only `pool_id` and `category_id` change. That is the whole
 * point — an evaluation item frozen on version 3 of this very question goes
 * on resolving, and a teacher who moved a question by mistake moves it back.
 *
 * Three things travel with it and are worth naming:
 *   - the TAGS stay on `question_tags` (they are the question's), and the
 *     target pool's vocabulary learns them through `ensurePoolTags`, the same
 *     way a copy teaches them (ADR-017). The source pool keeps its `pool_tags`
 *     rows — a teacher's one-line description of "pointeurs" is documentation
 *     of the pool, not of the question that left;
 *   - the ASSETS keep their `assets.pool_id`: they are addressed by id and
 *     served by the asset route, which authorizes through the ATTEMPT or the
 *     pool the caller reaches — moving the rows would be a second, silent
 *     write into the source pool for no gain;
 *   - the CATEGORY of the source pool is dropped; the caller passes a
 *     category OF THE TARGET, or null for its root.
 *
 * `linkCourseIds` is the explicit second half of the operation (`linkCourses`
 * of `MoveBody`): the courses the route decided the caller may link, added to
 * `course_pools` in the same transaction as the move, so a question is never
 * momentarily out of the reach of the classroom that plays it.
 */
export async function moveQuestions(
  db: Db,
  input: {
    questions: QuestionRecord[];
    targetPoolId: string;
    categoryId: string | null;
    linkCourseIds?: readonly string[];
  },
): Promise<void> {
  const ids = input.questions.map((q) => q.id);
  if (ids.length === 0) return;
  await assertNamesFree(db, input.targetPoolId, input.questions);
  const tags = [...new Set([...(await tagsOf(db, ids)).values()].flat())];
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(questions)
      .set({ poolId: input.targetPoolId, categoryId: input.categoryId, updatedAt: now })
      .where(inArray(questions.id, ids));
    await ensurePoolTags(tx, input.targetPoolId, tags);
    const links = [...new Set(input.linkCourseIds ?? [])];
    if (links.length) {
      await tx
        .insert(coursePools)
        .values(links.map((courseId) => ({ courseId, poolId: input.targetPoolId })))
        .onConflictDoNothing();
    }
  });
}

/**
 * `questions_pool_name_uq` is per pool and case-insensitive. Checked here
 * rather than caught as a unique violation, because the answer has to NAME
 * the questions that clash, and because a batch can clash with itself: two
 * questions called `ptr-01` coming from two different pools.
 */
async function assertNamesFree(
  db: Db,
  targetPoolId: string,
  moving: QuestionRecord[],
): Promise<void> {
  const seen = new Map<string, string>();
  const clashing = new Set<string>();
  for (const q of moving) {
    const key = q.internalName.toLowerCase();
    if (seen.has(key)) clashing.add(q.internalName);
    else seen.set(key, q.internalName);
  }
  const taken = await db
    .select({ internalName: questions.internalName })
    .from(questions)
    .where(
      and(
        eq(questions.poolId, targetPoolId),
        isNull(questions.deletedAt),
        inArray(sql`lower(${questions.internalName})`, [...seen.keys()]),
        // A question already in the target pool is being re-filed, not moved
        // in: it cannot clash with itself.
        notInArray(questions.id, moving.map((q) => q.id)),
      ),
    );
  for (const row of taken) clashing.add(row.internalName);
  if (clashing.size) throw new MoveNameTaken([...clashing].sort());
}
