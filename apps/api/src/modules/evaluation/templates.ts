/**
 * Evaluation templates (ADR-031): an evaluation kept at the course level,
 * from which each classroom's evaluation is made.
 *
 * A template is a row of `evaluations` whose `course_id` is set — the same
 * table, the same items, the same copy ({@link copyEvaluation}) — so this
 * file holds only what is proper to a template: creating or saving one,
 * listing a course's, editing one in place under its revision counter,
 * deleting one, and instantiating one into a classroom. The routes
 * import it directly; `service.ts` does not re-export it, which keeps the
 * import one-way (this file needs `service.ts` at load time for its errors).
 */
import { isDeepStrictEqual } from "node:util";

import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";

import type {
  EvaluationMode,
  EvaluationTemplate,
  TemplateDetail,
  TemplateItemRef,
} from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { evaluationItems, evaluations } from "../../db/schema.js";
import {
  EvaluationError,
  byId,
  copyEvaluation,
  coursePoolIds,
  createEvaluation,
  editableQuestionIdsOf,
  feedbackOf,
  itemCountsByEvaluation,
  inLinkedPool,
  itemRef,
  itemRowsOf,
  joinedItems,
  scaleOf,
  settingsOf,
  staleOf,
  totalPointsByEvaluation,
  totalPointsOf,
  type DbOrTx,
  type EvaluationRecord,
} from "./service.js";

/** A poll is created and started in one call; it has nothing to keep (ADR-031 §2). */
class TemplatePoll extends EvaluationError {
  constructor() {
    super("template_poll", 422, "a poll cannot be a template");
  }
}

/**
 * The template went between its load and the lock of a write. The routes
 * answer it with the loader's own 404 body (`notFound`), nothing more.
 */
export class TemplateGone extends EvaluationError {
  constructor() {
    super("not_found", 404);
  }
}

/** "Save as template": a copy of `row` into its course, without anything of a run. */
export async function saveAsTemplate(
  db: Db,
  row: EvaluationRecord,
  input: { courseId: string; title: string; createdBy: string },
): Promise<EvaluationRecord> {
  if (row.mode === "poll") throw new TemplatePoll();
  return copyEvaluation(db, row, {
    home: { courseId: input.courseId },
    title: input.title,
    createdBy: input.createdBy,
  });
}

/**
 * F-EVAL-24: a new, EMPTY template of a course, at revision 1 — the same
 * creation as a classroom's draft (presets, the creator's MCQ policy), in
 * the course.
 */
export async function createTemplate(
  db: Db,
  input: {
    courseId: string;
    title: string;
    mode: EvaluationMode;
    preset?: "exam" | "exercise" | undefined;
    createdBy: string;
  },
): Promise<EvaluationRecord> {
  if (input.mode === "poll") throw new TemplatePoll();
  return createEvaluation(db, input);
}

/** A template row in the list's shape. */
function toTemplate(row: EvaluationRecord, itemCount: number, totalPoints: number): EvaluationTemplate {
  // The CHECK of the schema makes all three true of every template row.
  if (row.courseId === null || row.revision === null || row.mode === "poll") {
    throw new Error(`evaluation ${row.id} is not a template`);
  }
  return {
    id: row.id,
    courseId: row.courseId,
    title: row.title,
    mode: row.mode,
    revision: row.revision,
    itemCount,
    totalPoints,
  };
}

/** Template rows in the list's shape, with the counts the list shows. */
async function withStats(db: Db, rows: EvaluationRecord[]): Promise<EvaluationTemplate[]> {
  const ids = rows.map((r) => r.id);
  const [itemCounts, points] = await Promise.all([
    itemCountsByEvaluation(db, ids),
    totalPointsByEvaluation(db, ids),
  ]);
  return rows.map((row) => toTemplate(row, itemCounts.get(row.id) ?? 0, points.get(row.id) ?? 0));
}

/** The templates of a course, newest first. */
export async function listTemplates(db: Db, courseId: string): Promise<EvaluationTemplate[]> {
  const rows = await db
    .select()
    .from(evaluations)
    .where(eq(evaluations.courseId, courseId))
    .orderBy(desc(evaluations.createdAt));
  return withStats(db, rows);
}

/** One template in the list's shape, after a write. */
export async function templateOf(db: Db, row: EvaluationRecord): Promise<EvaluationTemplate> {
  const [template] = await withStats(db, [row]);
  return template!;
}

/**
 * What the template's editor reads (F-EVAL-25): its configuration, and its
 * items with the flags *Instantiate* would act on — a newer published version
 * (`staleItems`), a deprecated one (`deprecated`, a warning there) and a pool
 * the course no longer links (`poolUnlinked`, a refusal there).
 */
export async function templateDetail(
  db: Db,
  row: EvaluationRecord,
  viewer: { id: string; role: string },
): Promise<TemplateDetail> {
  const [joined, linked] = await Promise.all([
    joinedItems(db, row.id),
    coursePoolIds(db, { courseId: row.courseId! }),
  ]);
  const rows = await itemRowsOf(db, joined);
  const unlinked = new Set(
    joined.filter((j) => !inLinkedPool(j.question, linked)).map((j) => j.item.id),
  );
  const items = rows.map((r) => ({ ...r, poolUnlinked: unlinked.has(r.id) }));
  const totalPoints = totalPointsOf(items);
  return {
    template: {
      ...toTemplate(row, items.length, totalPoints),
      settings: settingsOf(row),
      gradingScale: scaleOf(row),
      feedbackPolicy: feedbackOf(row),
      mcqPolicy: row.mcqPolicy,
      durationS: row.durationS,
    },
    items,
    totalPoints,
    staleItems: staleOf(rows),
    editableQuestionIds: await editableQuestionIdsOf(db, rows, viewer),
  };
}

// --- Editing in place (F-EVAL-25, ADR-031 addendum d) -----------------------

/**
 * Everything of a template whose change is a new revision — its whole
 * content but the title: the configuration, read through the same parsers
 * as everywhere (so a stored row missing a defaulted key equals the same row
 * with it), and the items with their versions, points, order and milestones.
 */
async function contentOf(db: DbOrTx, row: EvaluationRecord) {
  return {
    mode: row.mode,
    settings: settingsOf(row),
    gradingScale: scaleOf(row),
    feedbackPolicy: feedbackOf(row),
    mcqPolicy: row.mcqPolicy,
    durationS: row.durationS,
    items: await db
      .select({
        id: evaluationItems.id,
        position: evaluationItems.position,
        questionVersionId: evaluationItems.questionVersionId,
        points: evaluationItems.points,
        milestone: evaluationItems.milestone,
      })
      .from(evaluationItems)
      .where(eq(evaluationItems.evaluationId, row.id))
      .orderBy(asc(evaluationItems.position)),
  };
}

/**
 * THE move of a template's revision (ADR-031, addendum d): `+ 1` in SQL,
 * never read-modify-write, inside the transaction of the write it records.
 * Only {@link editTemplate} calls it.
 */
async function bumpTemplateRevision(tx: DbOrTx, templateId: string): Promise<void> {
  await tx
    .update(evaluations)
    .set({ revision: sql`${evaluations.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(evaluations.id, templateId), isNotNull(evaluations.courseId)));
}

/**
 * One write to a template, through the SAME service function an
 * evaluation's write uses (`patchEvaluation`, `addItems`, …), in one
 * transaction that locks the template row, compares its content before and
 * after, and bumps the revision exactly once when that content moved. A
 * title-only or no-op write commits without a bump. A template has no
 * attempt and stays `draft`, so every item and configuration rule of an
 * evaluation holds as for an untouched draft.
 */
export async function editTemplate(
  db: Db,
  template: EvaluationRecord,
  write: (tx: DbOrTx, row: EvaluationRecord, ctx: { attemptCount: number }) => Promise<unknown>,
): Promise<{ row: EvaluationRecord; revised: boolean }> {
  return db.transaction(async (tx) => {
    const locked = await lockTemplate(tx, template.id);
    const before = await contentOf(tx, locked);
    await write(tx, locked, { attemptCount: 0 });
    const written = (await byId(tx, locked.id))!;
    const revised = !isDeepStrictEqual(before, await contentOf(tx, written));
    if (!revised) return { row: written, revised };
    await bumpTemplateRevision(tx, locked.id);
    return { row: (await byId(tx, locked.id))!, revised };
  });
}

/** The template row, locked for the rest of the transaction (`SELECT … FOR UPDATE`). */
async function lockTemplate(tx: DbOrTx, templateId: string): Promise<EvaluationRecord> {
  const [row] = await tx
    .select()
    .from(evaluations)
    .where(and(eq(evaluations.id, templateId), isNotNull(evaluations.courseId)))
    .for("update");
  if (!row) throw new TemplateGone();
  return row;
}

/** The instances keep running; their `origin_template_id` is nulled by the FK. */
export async function deleteTemplate(db: Db, template: EvaluationRecord): Promise<void> {
  await db.delete(evaluations).where(eq(evaluations.id, template.id));
}

/**
 * "Instantiate": a new draft in `classroomId` — a classroom of the template's
 * course, which the route has checked — recording the template and its
 * revision. A question in a pool the course no longer links blocks it; a
 * deprecated version is handed back as a warning.
 *
 * The template row is locked for the whole copy (ADR-031, addendum e), so the
 * `origin_revision` recorded is the revision whose content was copied, even
 * while a colleague edits the template: their write waits, or this one does.
 */
export async function instantiateTemplate(
  db: Db,
  template: EvaluationRecord,
  input: { classroomId: string; title: string; createdBy: string },
): Promise<{ evaluation: EvaluationRecord; deprecatedItems: TemplateItemRef[] }> {
  return db.transaction(async (tx) => {
    const locked = await lockTemplate(tx, template.id);
    // The copy itself refuses a question whose pool the course no longer
    // links (F-EVAL-01, `copyEvaluation`); the course's links are read, not
    // locked: a pool unlinked in that instant leaves one draft still playing
    // it, like one authored just before.
    const evaluation = await copyEvaluation(tx, locked, {
      home: { classroomId: input.classroomId },
      origin: { templateId: locked.id, revision: locked.revision! },
      title: input.title,
      createdBy: input.createdBy,
    });
    return {
      evaluation,
      deprecatedItems: (await joinedItems(tx, locked.id))
        .filter((j) => j.version.deprecatedAt !== null)
        .map(itemRef),
    };
  });
}
