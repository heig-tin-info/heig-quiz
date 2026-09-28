/** The item list of an evaluation, the pools it draws from, and the copy. */
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { ItemPatch, ItemRow, PoolSummary, TemplateItemRef } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import {
  coursePools,
  classrooms,
  evaluationItems,
  evaluations,
  pools,
  questionVersions,
  questions,
} from "../../db/schema.js";
import { listPools } from "../pool/service.js";
import {
  type EvaluationRecord,
  type DbOrTx,
  AttemptsExist,
  assertItemListEditable,
  NoPublishedVersion,
  QuestionKeyless,
  QuestionNotInCourse,
  PoolUnlinked,
} from "./shared.js";
import { classroomIdOf, attemptCount, type JoinedItem, joinedItems, itemRows } from "./reads.js";
import { byId } from "./writes.js";

/**
 * THE pools a home may draw questions from (F-EVAL-01, ADR-031 addendum c):
 * those linked to its course — a template's own, or its classroom's. The one
 * source behind `addItems`, the picker, every copy into a classroom and a
 * template's `poolUnlinked` flag.
 */
export async function coursePoolIds(db: DbOrTx, home: CopyHome): Promise<Set<string>> {
  const rows =
    "courseId" in home
      ? await db
          .select({ poolId: coursePools.poolId })
          .from(coursePools)
          .where(eq(coursePools.courseId, home.courseId))
      : await db
          .select({ poolId: coursePools.poolId })
          .from(classrooms)
          .innerJoin(coursePools, eq(coursePools.courseId, classrooms.courseId))
          .where(eq(classrooms.id, home.classroomId));
  return new Set(rows.map((r) => r.poolId));
}

/** THE test of F-EVAL-01: the question sits in one of the course's pools. */
export function inLinkedPool(question: { poolId: string | null }, linked: Set<string>): boolean {
  return question.poolId !== null && linked.has(question.poolId);
}

/** Where a row lives: its course for a template, its classroom otherwise. */
function homeOf(row: EvaluationRecord): CopyHome {
  return row.courseId !== null ? { courseId: row.courseId } : { classroomId: classroomIdOf(row) };
}

/**
 * The pools the question picker offers (F-EVAL-01): exactly the ones linked
 * to the course, the same set `addItems` enforces — a pool the teacher
 * reaches but the course does not draw from would only end in
 * `422 question_not_in_course`.
 */
export async function listCoursePools(
  db: Db,
  home: CopyHome,
  viewer: { id: string; role: string },
): Promise<PoolSummary[]> {
  const ids = await coursePoolIds(db, home);
  if (ids.size === 0) return [];
  return listPools(db, inArray(pools.id, [...ids]), viewer);
}

/** The latest PUBLISHED version of each question, or null when there is none. */
export async function latestPublished(
  db: DbOrTx,
  questionIds: string[],
): Promise<Map<string, typeof questionVersions.$inferSelect>> {
  if (questionIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(questionVersions)
    .where(
      and(inArray(questionVersions.questionId, questionIds), isNotNull(questionVersions.number)),
    )
    .orderBy(asc(questionVersions.questionId), desc(questionVersions.number));
  const out = new Map<string, typeof questionVersions.$inferSelect>();
  for (const row of rows) if (!out.has(row.questionId)) out.set(row.questionId, row);
  return out;
}

async function nextPosition(db: DbOrTx, evaluationId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${evaluationItems.position})` })
    .from(evaluationItems)
    .where(eq(evaluationItems.evaluationId, evaluationId));
  return (row?.max === null || row?.max === undefined ? -1 : Number(row.max)) + 1;
}

/**
 * Adds questions at the end, each frozen on its current published version
 * (F-EVAL-03). Points default to `type.defaultPoints` and the presence of a
 * key to `type.hasKey` — both supplied by the caller, so this file never
 * imports the registry. A version without a key is refused
 * (`422 question_keyless`): only a poll runs one.
 */
export async function addItems(
  db: DbOrTx,
  row: EvaluationRecord,
  questionIds: string[],
  defaultPoints: (type: string, version: typeof questionVersions.$inferSelect) => number,
  ctx: { attemptCount: number },
  keyed: (type: string, version: typeof questionVersions.$inferSelect) => boolean = () => true,
): Promise<ItemRow[]> {
  assertItemListEditable(row, ctx);
  const allowed = await coursePoolIds(db, homeOf(row));
  const found = await db.select().from(questions).where(inArray(questions.id, questionIds));
  const byQuestion = new Map(found.map((q) => [q.id, q]));
  const versions = await latestPublished(db, questionIds);

  let position = await nextPosition(db, row.id);
  const values: (typeof evaluationItems.$inferInsert)[] = [];
  for (const questionId of questionIds) {
    const question = byQuestion.get(questionId);
    if (!question || question.deletedAt !== null || !inLinkedPool(question, allowed)) {
      throw new QuestionNotInCourse(questionId);
    }
    const version = versions.get(questionId);
    if (!version) throw new NoPublishedVersion(questionId);
    if (!keyed(question.type, version)) throw new QuestionKeyless(questionId);
    values.push({
      id: randomUUID(),
      evaluationId: row.id,
      position: position++,
      questionVersionId: version.id,
      points: defaultPoints(question.type, version),
      milestone: false,
    });
  }
  if (values.length > 0) await db.insert(evaluationItems).values(values);
  return itemRows(db, row.id);
}

export async function patchItem(
  db: DbOrTx,
  row: EvaluationRecord,
  itemId: string,
  patch: ItemPatch,
  ctx: { attemptCount: number },
): Promise<ItemRow[]> {
  assertItemListEditable(row, ctx);
  const next: Partial<typeof evaluationItems.$inferInsert> = {};
  if (patch.points !== undefined) next.points = patch.points;
  if (patch.milestone !== undefined) next.milestone = patch.milestone;
  await db
    .update(evaluationItems)
    .set(next)
    .where(and(eq(evaluationItems.id, itemId), eq(evaluationItems.evaluationId, row.id)));
  return itemRows(db, row.id);
}

export async function deleteItem(
  db: DbOrTx,
  row: EvaluationRecord,
  itemId: string,
  ctx: { attemptCount: number },
): Promise<ItemRow[]> {
  assertItemListEditable(row, ctx);
  await db
    .delete(evaluationItems)
    .where(and(eq(evaluationItems.id, itemId), eq(evaluationItems.evaluationId, row.id)));
  // Positions stay dense: the grid, the CSV export and `forward_only` all
  // read `position` as an index, not as an opaque sort key.
  const remaining = await db
    .select()
    .from(evaluationItems)
    .where(eq(evaluationItems.evaluationId, row.id))
    .orderBy(asc(evaluationItems.position));
  await renumber(db, row.id, remaining.map((r) => r.id));
  return itemRows(db, row.id);
}

/**
 * Two-phase renumbering: every row is first pushed out of the way, then
 * given its final position. `(evaluation_id, position)` is unique and NOT
 * deferrable (see `db/evaluation.ts`), so a one-pass UPDATE would collide
 * with itself on any swap.
 */
async function renumber(db: DbOrTx, evaluationId: string, orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;
  await db.transaction(async (tx) => {
    await tx
      .update(evaluationItems)
      .set({ position: sql`${evaluationItems.position} + 100000` })
      .where(eq(evaluationItems.evaluationId, evaluationId));
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(evaluationItems)
        .set({ position: index })
        .where(
          and(eq(evaluationItems.id, id), eq(evaluationItems.evaluationId, evaluationId)),
        );
    }
  });
}

export async function reorderItems(
  db: DbOrTx,
  row: EvaluationRecord,
  itemIds: string[],
  ctx: { attemptCount: number },
): Promise<ItemRow[]> {
  assertItemListEditable(row, ctx);
  const existing = await db
    .select({ id: evaluationItems.id })
    .from(evaluationItems)
    .where(eq(evaluationItems.evaluationId, row.id));
  const known = new Set(existing.map((e) => e.id));
  // Anything the caller forgot keeps its relative place at the end, so a
  // stale browser tab can never drop an item by omitting it.
  const ordered = [...itemIds.filter((id) => known.has(id))];
  for (const id of existing.map((e) => e.id)) if (!ordered.includes(id)) ordered.push(id);
  await renumber(db, row.id, ordered);
  return itemRows(db, row.id);
}

/**
 * The one-click "update to the latest version" of F-EVAL-03. Refused as soon
 * as an attempt exists — a student who already answered would silently be
 * answering another question — and once the evaluation is opened (#79).
 */
export async function updateVersions(
  db: DbOrTx,
  row: EvaluationRecord,
  itemIds: string[] | undefined,
  ctx: { attemptCount: number },
): Promise<ItemRow[]> {
  assertItemListEditable(row, ctx, () => new AttemptsExist());
  const joined = await joinedItems(db, row.id);
  const targets = itemIds === undefined ? joined : joined.filter((j) => itemIds.includes(j.item.id));
  const versions = await latestPublished(db, [...new Set(targets.map((j) => j.question.id))]);
  for (const target of targets) {
    const latest = versions.get(target.question.id);
    if (!latest || latest.id === target.version.id) continue;
    await db
      .update(evaluationItems)
      .set({ questionVersionId: latest.id })
      .where(eq(evaluationItems.id, target.item.id));
  }
  return itemRows(db, row.id);
}

/** An item as a refusal names it: where it sits and which question it plays. */
export function itemRef(j: JoinedItem): TemplateItemRef {
  return { position: j.item.position, questionId: j.question.id, internalName: j.question.internalName };
}

/**
 * Where a copy lives: a classroom (a duplicate, F-EVAL-14, or an instance of
 * a template) or a course (a template, ADR-031).
 */
export type CopyHome = { classroomId: string } | { courseId: string };

/**
 * THE copy of an evaluation into a new draft: its settings, grade scale,
 * feedback and MCQ policies, duration, and its items — the SAME frozen
 * versions, points, order and milestones. Duplicate, "Save as template" and
 * "Instantiate" differ only in the home and the origin. A copy into a
 * course is a template, at revision 1, and carries nothing of a run (dates,
 * access code, IP list); a copy into a classroom keeps them — a template
 * has none to give. One transaction: a copy is never half-made.
 */
export async function copyEvaluation(
  db: DbOrTx,
  row: EvaluationRecord,
  target: {
    home: CopyHome;
    title: string;
    createdBy: string;
    /** An instance records the template and the revision it came from. */
    origin?: { templateId: string; revision: number };
  },
): Promise<EvaluationRecord> {
  const id = randomUUID();
  const joined = await joinedItems(db, row.id);
  if ("classroomId" in target.home) {
    // F-EVAL-01, the rule `addItems` enforces: a copy into a classroom —
    // of this course or of another — draws only from the pools its course
    // links. Checked outside the transaction, like an item added just before.
    const linked = await coursePoolIds(db, target.home);
    const unlinked = joined.filter((j) => !inLinkedPool(j.question, linked));
    if (unlinked.length > 0) throw new PoolUnlinked(unlinked.map(itemRef));
  }
  const items = joined.map((j) => j.item);
  const home =
    "courseId" in target.home
      ? { courseId: target.home.courseId, revision: 1 }
      : {
          classroomId: target.home.classroomId,
          opensAt: row.opensAt,
          closesAt: row.closesAt,
          accessCode: row.accessCode,
          ipAllowlist: row.ipAllowlist,
          originTemplateId: target.origin?.templateId ?? null,
          originRevision: target.origin?.revision ?? null,
        };
  await db.transaction(async (tx) => {
    await tx.insert(evaluations).values({
      id,
      ...home,
      title: target.title,
      mode: row.mode,
      state: "draft",
      settings: row.settings,
      gradingScale: row.gradingScale,
      feedbackPolicy: row.feedbackPolicy,
      mcqPolicy: row.mcqPolicy,
      durationS: row.durationS,
      createdBy: target.createdBy,
    });
    if (items.length > 0) {
      await tx.insert(evaluationItems).values(
        items.map((item) => ({
          id: randomUUID(),
          evaluationId: id,
          position: item.position,
          // The copy points at the SAME frozen versions: copying an
          // evaluation must not silently upgrade its questions.
          questionVersionId: item.questionVersionId,
          points: item.points,
          milestone: item.milestone,
        })),
      );
    }
  });
  return (await byId(db, id))!;
}
