/**
 * Evaluation templates (ADR-031): an evaluation kept at the course level,
 * from which each classroom's evaluation is made.
 *
 * A template is a row of `evaluations` whose `course_id` is set — the same
 * table, the same items, the same copy ({@link copyEvaluation}) — so this
 * file holds only what is proper to a template: creating or saving one,
 * listing a course's, editing one in place under its revision counter,
 * deleting one, instantiating one into a classroom, and pulling a newer
 * revision into an instance (F-EVAL-26). The routes
 * import it directly; `service.ts` does not re-export it, which keeps the
 * import one-way (this file needs `service.ts` at load time for its errors).
 */
import { isDeepStrictEqual } from "node:util";

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import {
  categorizePolicyOf,
  conditionsOf,
  kioskOf,
  negativeMarkingOf,
  retakesOf,
  safeExamBrowserOf,
  type ConceptLang,
  type EvaluationMode,
  type EvaluationSettings,
  type EvaluationTemplate,
  type TemplateDetail,
  type TemplateItemRef,
  type TemplatePullItem,
  type TemplatePullPreview,
} from "@quiz/contracts";
import {
  calculatorOn,
  drillAllowedOn,
  evaluationTotal,
  itemListDiff,
  notepadOn,
  retakeScopeOf,
} from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { evaluationItems, evaluations } from "../../db/schema.js";
import type { Caller } from "../guards.js";
import {
  EvaluationError,
  assertItemListEditable,
  assertPoolsLinked,
  assertReady,
  attemptCount,
  byId,
  classroomIdOf,
  copyEvaluation,
  coursePoolIds,
  createEvaluation,
  deprecatedRefs,
  editableQuestionIdsOf,
  feedbackOf,
  itemCountsByEvaluation,
  inLinkedPool,
  itemConcepts,
  itemRef,
  itemRowsOf,
  joinedItems,
  replaceItems,
  scaleOf,
  settingsOf,
  staleOf,
  totalPointsByEvaluation,
  unlinkedRefs,
  type DbOrTx,
  type EvaluationRecord,
  type JoinedItem,
} from "./service.js";

/**
 * The template went between its load and the lock of a write. The routes
 * answer it with the loader's own 404 body (`notFound`), nothing more.
 */
export class TemplateGone extends EvaluationError {
  constructor() {
    super("not_found");
  }
}

/**
 * "Save as template": a copy of `row` into its course, without anything of a
 * run, and the source linked to it at revision 1 — relinked if it was an
 * instance already; the origin it loses is handed back for the audit log.
 * One transaction, the source locked `FOR NO KEY UPDATE` and re-read under
 * it (ADR-031, addendum of 2026-09-30, §3).
 */
export async function saveAsTemplate(
  db: Db,
  row: EvaluationRecord,
  input: { courseId: string; title: string; createdBy: string },
): Promise<{
  template: EvaluationRecord;
  previousOrigin: { templateId: string; revision: number | null } | null;
}> {
  if (row.mode === "poll") throw new EvaluationError("template_poll"); // nothing to keep (ADR-031 §2)
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(evaluations)
      .where(eq(evaluations.id, row.id))
      .for("no key update");
    // The evaluation went since its load: the loader's 404 all the same.
    if (!source) throw new TemplateGone();
    const template = await copyEvaluation(tx, source, {
      home: { courseId: input.courseId },
      title: input.title,
      createdBy: input.createdBy,
    });
    await tx
      .update(evaluations)
      .set({ originTemplateId: template.id, originRevision: template.revision, updatedAt: new Date() })
      .where(eq(evaluations.id, source.id));
    return {
      template,
      previousOrigin:
        source.originTemplateId === null
          ? null
          : { templateId: source.originTemplateId, revision: source.originRevision },
    };
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
  if (input.mode === "poll") throw new EvaluationError("template_poll");
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

/** How many templates each of these courses keeps; a course without one is absent. */
export async function countTemplates(db: Db, courseIds: string[]): Promise<Map<string, number>> {
  if (courseIds.length === 0) return new Map();
  const rows = await db
    .select({ courseId: evaluations.courseId, n: sql<number>`count(*)::int` })
    .from(evaluations)
    .where(inArray(evaluations.courseId, courseIds))
    .groupBy(evaluations.courseId);
  return new Map(rows.map((r) => [r.courseId!, r.n]));
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
  viewer: Caller,
  lang: ConceptLang,
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
  const totalPoints = evaluationTotal(items);
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
    concepts: await itemConcepts(db, rows, lang),
    totalPoints,
    staleItems: staleOf(rows),
    editableQuestionIds: await editableQuestionIdsOf(db, rows, viewer),
  };
}

// --- Editing in place (F-EVAL-25, ADR-031 addendum d) -----------------------

/**
 * The settings as they take effect: each optional key (ADR-026, ADR-069 —
 * optional so that no stored row needed a migration) read through its
 * accessor, so a row that never set `kiosk` equals one that stores
 * `kiosk: false`. What is stored is untouched; only the comparison sees this.
 */
function effectiveSettings(row: EvaluationRecord): EvaluationSettings {
  const settings = settingsOf(row);
  const retakes = retakesOf(settings);
  return {
    ...settings,
    retakes: { ...retakes, scope: retakeScopeOf(retakes) },
    negativeMarking: negativeMarkingOf(settings),
    categorizePolicy: categorizePolicyOf(settings),
    safeExamBrowser: safeExamBrowserOf(settings),
    kiosk: kioskOf(settings),
    calculator: calculatorOn(row.mode, settings.calculator),
    notepad: notepadOn(row.mode, settings.notepad),
    conditions: conditionsOf(settings),
    allowDrill: drillAllowedOn(row.mode, settings.allowDrill),
  };
}

/**
 * Everything of a template whose change is a new revision — its whole
 * content but the title: the configuration, read through the same parsers
 * as everywhere and the settings through their accessors (so a stored row
 * missing a defaulted or optional key equals the same row spelling its
 * default), and the items with their versions, points, order, milestones,
 * bonus flags (ADR-052) and intros (ADR-084).
 */
async function contentOf(db: DbOrTx, row: EvaluationRecord) {
  return {
    mode: row.mode,
    settings: effectiveSettings(row),
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
        bonus: evaluationItems.bonus,
        intro: evaluationItems.intro,
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
    return { evaluation, deprecatedItems: deprecatedRefs(await joinedItems(tx, locked.id)) };
  });
}

// --- Pulling a revision into an instance (F-EVAL-26) -------------------------


/**
 * The template of an instance's origin, provided it is a template of
 * `courseId` — the instance's classroom's course, as the route loaded it
 * (defence in depth: a template of another course is no template). With
 * `share`, the row is locked `FOR SHARE` for the rest of the transaction.
 * The same same-course rule as `templateRevisionsOf` (`service.ts`), which
 * the badge reads: a change to it changes both.
 */
async function originTemplate(
  db: DbOrTx,
  row: EvaluationRecord,
  courseId: string,
  lock?: "share",
): Promise<EvaluationRecord> {
  if (row.originTemplateId === null) throw new EvaluationError("no_template");
  const query = db
    .select()
    .from(evaluations)
    .where(and(eq(evaluations.id, row.originTemplateId), eq(evaluations.courseId, courseId)));
  const [template] = lock === "share" ? await query.for("share") : await query;
  if (!template || template.revision === null) throw new EvaluationError("no_template");
  return template;
}

/** An item as the summary of a pull names it. */
const pullItem = (j: JoinedItem): TemplatePullItem => ({
  ...itemRef(j),
  versionNumber: j.version.number ?? 0,
  points: j.item.points,
  milestone: j.item.milestone,
  bonus: j.item.bonus,
  intro: j.item.intro,
});

/**
 * What pulling the template's current revision would do to the instance's
 * questions — the confirmation's two-way summary — and what would refuse it
 * (`unlinkedItems`) or only warn (`deprecatedItems`). A read: no lock, and
 * no gate on the state, which the pull itself checks.
 */
export async function templatePullPreview(
  db: Db,
  row: EvaluationRecord,
  courseId: string,
): Promise<TemplatePullPreview> {
  const template = await originTemplate(db, row, courseId);
  const [mine, theirs, linked] = await Promise.all([
    joinedItems(db, row.id),
    joinedItems(db, template.id),
    coursePoolIds(db, { classroomId: classroomIdOf(row) }),
  ]);
  return {
    templateId: template.id,
    templateTitle: template.title,
    from: row.originRevision,
    to: template.revision!,
    ...itemListDiff(mine.map(pullItem), theirs.map(pullItem)),
    deprecatedItems: deprecatedRefs(theirs),
    unlinkedItems: unlinkedRefs(theirs, linked),
  };
}

/**
 * "Pull": the instance's QUESTIONS replaced by the template's current ones —
 * frozen versions, points, order, milestones — and `origin_revision` moved to
 * the revision copied. Nothing else of the instance changes: title, dates,
 * IP list, settings, scale, policies, duration and state stay
 * (F-EVAL-26), so a template that moved only in its settings is pulled as a
 * bare record of the revision.
 *
 * One transaction, and the locks in the order every other writer takes
 * them — the TEMPLATE first (`FOR SHARE`: an edit or a delete of it waits),
 * THEN the instance (`FOR UPDATE`: the ticker's `scheduled → lobby` waits) —
 * which is the order `deleteTemplate` takes too (the template's row, then its
 * instances' through the FK), so the two never deadlock. Everything the gate
 * reads is re-read under the instance's lock: the origin (a delete may have
 * nulled it), the state and the attempts. Replacing the items gives them new
 * ids, and answers and gradings hang on an item id by cascade: a pull past
 * the gate would silently delete a student's work.
 */
export async function pullTemplate(
  db: Db,
  row: EvaluationRecord,
  input: { courseId: string; revision: number },
): Promise<{
  row: EvaluationRecord;
  templateId: string;
  from: number | null;
  to: number;
  deprecatedItems: TemplateItemRef[];
}> {
  return db.transaction(async (tx) => {
    const template = await originTemplate(tx, row, input.courseId, "share");
    const [locked] = await tx
      .select()
      .from(evaluations)
      .where(eq(evaluations.id, row.id))
      .for("update");
    // The evaluation went since its load: the loader's 404 all the same.
    if (!locked) throw new TemplateGone();
    if (locked.originTemplateId !== template.id) throw new EvaluationError("no_template");
    if (template.revision !== input.revision) throw new EvaluationError("template_moved", undefined, { revision: template.revision! });
    // The item-list gate itself (issue #79): draft or scheduled, no attempt
    // of anybody — a teacher's own test walk included (ADR-018).
    assertItemListEditable(locked, { attemptCount: await attemptCount(tx, locked.id) });
    const theirs = await joinedItems(tx, template.id);
    await assertPoolsLinked(tx, { classroomId: classroomIdOf(locked) }, theirs);
    // A scheduled evaluation stays scheduled: what it now holds must still
    // pass the move to `scheduled` (no question is `no_items`). The timing is
    // the instance's own and is not touched.
    if (locked.state === "scheduled") {
      assertReady(locked, "scheduled", theirs.map((j) => j.item));
    }
    await replaceItems(tx, locked.id, theirs.map((j) => j.item));
    await tx
      .update(evaluations)
      .set({ originRevision: template.revision, updatedAt: new Date() })
      .where(eq(evaluations.id, locked.id));
    return {
      row: (await byId(tx, locked.id))!,
      templateId: template.id,
      from: locked.originRevision,
      to: template.revision!,
      deprecatedItems: deprecatedRefs(theirs),
    };
  });
}
