/**
 * Evaluation templates (ADR-031): an evaluation kept at the course level,
 * from which each classroom's evaluation is made.
 *
 * A template is a row of `evaluations` whose `course_id` is set — the same
 * table, the same items, the same copy ({@link copyEvaluation}) — so this
 * file holds only what is proper to a template: saving one, listing a
 * course's, deleting one, and instantiating one into a classroom. The routes
 * import it directly; `service.ts` does not re-export it, which keeps the
 * import one-way (this file needs `service.ts` at load time for its errors).
 */
import { desc, eq, type SQL } from "drizzle-orm";

import type { EvaluationTemplate, TemplateItemRef } from "@quiz/contracts";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { coursePools, evaluations } from "../../db/schema.js";
import {
  EvaluationError,
  copyEvaluation,
  itemCountsByEvaluation,
  joinedItems,
  totalPointsByEvaluation,
  type EvaluationRecord,
} from "./service.js";

/** A poll is created and started in one call; it has nothing to keep (ADR-031 §2). */
class TemplatePoll extends EvaluationError {
  constructor() {
    super("template_poll", 422, "a poll cannot be saved as a template");
  }
}

/**
 * Some items of the template play a question whose pool is no longer linked
 * to the course: the instance could not have been authored with them
 * (F-EVAL-01), so instantiation is refused and names them.
 */
class TemplatePoolUnlinked extends EvaluationError {
  constructor(items: TemplateItemRef[]) {
    super(
      "template_pool_unlinked",
      422,
      "some questions of the template are in a pool no longer linked to the course",
      { items },
    );
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
    as: { template: { courseId: input.courseId } },
    title: input.title,
    createdBy: input.createdBy,
  });
}

/** The templates `where` selects, newest first, with the counts the list shows. */
async function summaries(db: Db, where: SQL): Promise<EvaluationTemplate[]> {
  const rows = await db
    .select()
    .from(evaluations)
    .where(where)
    .orderBy(desc(evaluations.createdAt));
  const ids = rows.map((r) => r.id);
  const [itemCounts, points] = await Promise.all([
    itemCountsByEvaluation(db, ids),
    totalPointsByEvaluation(db, ids),
  ]);
  return rows.map((row) => {
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
      itemCount: itemCounts.get(row.id) ?? 0,
      totalPoints: points.get(row.id) ?? 0,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  });
}

/** The templates of a course. */
export function listTemplates(db: Db, courseId: string): Promise<EvaluationTemplate[]> {
  return summaries(db, eq(evaluations.courseId, courseId));
}

/** One template in the list's shape, after a write. */
export async function templateSummary(db: Db, row: EvaluationRecord): Promise<EvaluationTemplate> {
  const [found] = await summaries(db, eq(evaluations.id, row.id));
  if (!found) throw new Error(`template ${row.id} vanished`);
  return found;
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
 */
export async function instantiateTemplate(
  db: Db,
  template: EvaluationRecord,
  input: { classroomId: string; title: string; createdBy: string },
): Promise<{ evaluation: EvaluationRecord; deprecatedItems: TemplateItemRef[] }> {
  const items = await joinedItems(db, template.id);
  const linked = new Set(
    (
      await db
        .select({ poolId: coursePools.poolId })
        .from(coursePools)
        .where(eq(coursePools.courseId, template.courseId!))
    ).map((r) => r.poolId),
  );
  const ref = (j: (typeof items)[number]): TemplateItemRef => ({
    position: j.item.position,
    questionId: j.question.id,
    internalName: j.question.internalName,
  });
  const unlinked = items.filter((j) => j.question.poolId === null || !linked.has(j.question.poolId));
  if (unlinked.length > 0) throw new TemplatePoolUnlinked(unlinked.map(ref));

  // Checked outside the copy's transaction: a pool unlinked in that instant
  // leaves one draft still playing it, like one authored just before.
  const evaluation = await copyEvaluation(db, template, {
    as: {
      instance: {
        classroomId: input.classroomId,
        origin: { templateId: template.id, revision: template.revision! },
      },
    },
    title: input.title,
    createdBy: input.createdBy,
  });
  return {
    evaluation,
    deprecatedItems: items.filter((j) => j.version.deprecatedAt !== null).map(ref),
  };
}
