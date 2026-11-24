/**
 * The documents an evaluation provides (ADR-144 §7, F-EVAL-37): documents of
 * its course's library, at most `MAX_PROVIDED_DOCUMENTS`, in the teacher's
 * order. The one writer of `evaluation_provided_documents`.
 *
 * What a student may read of them is not decided here: the `library`
 * module's student view is the one exit (invariant 4). This file sets the
 * selection, reads it for the staff, counts it for the conditions' line
 * (ADR-079) and carries it into a copy.
 */
import { and, asc, count, eq, inArray } from "drizzle-orm";

import type { ProvidedDocument } from "@quiz/contracts";

import { classrooms, courseDocuments, evaluationProvidedDocuments } from "../../db/schema.js";
import { type DbOrTx, type EvaluationHome, type EvaluationRecord, EvaluationError } from "./shared.js";

/** The course an evaluation's documents must come from: a template's own, or its classroom's. */
async function courseOfHome(db: DbOrTx, home: EvaluationHome): Promise<string | null> {
  if ("courseId" in home) return home.courseId;
  const [room] = await db
    .select({ courseId: classrooms.courseId })
    .from(classrooms)
    .where(eq(classrooms.id, home.classroomId));
  return room?.courseId ?? null;
}

/** Where a row lives, for {@link courseOfHome}; null for an anonymous poll, which has no course. */
const homeOf = (row: EvaluationRecord): EvaluationHome | null =>
  row.courseId !== null
    ? { courseId: row.courseId }
    : row.classroomId !== null
      ? { classroomId: row.classroomId }
      : null;

/**
 * Replaces the selection of `row` with `ids`, in their order. Each must be a
 * document of the evaluation's own course: otherwise `422 document_unknown`,
 * the same answer for an id that names nothing and for another course's
 * document. The documents are read `FOR SHARE`: a delete of one of them
 * (which locks it `FOR UPDATE`, then reads who provides it) waits for this
 * write, or this write waits for the delete and finds the document gone.
 * The caller holds the transaction (`patchEvaluation`'s).
 */
export async function setProvidedDocuments(db: DbOrTx, row: EvaluationRecord, ids: readonly string[]): Promise<void> {
  if (ids.length > 0) {
    const home = homeOf(row);
    const courseId = home === null ? null : await courseOfHome(db, home);
    const found =
      courseId === null
        ? []
        : await db
            .select({ id: courseDocuments.id })
            .from(courseDocuments)
            .where(and(eq(courseDocuments.courseId, courseId), inArray(courseDocuments.id, [...ids])))
            .for("share");
    if (found.length !== new Set(ids).size) throw new EvaluationError("document_unknown");
  }
  await db.delete(evaluationProvidedDocuments).where(eq(evaluationProvidedDocuments.evaluationId, row.id));
  if (ids.length === 0) return;
  await db
    .insert(evaluationProvidedDocuments)
    .values(ids.map((documentId, position) => ({ evaluationId: row.id, documentId, position })));
}

/** The selection of an evaluation, in its order, as its staff read it. */
export async function providedDocumentsOf(db: DbOrTx, evaluationId: string): Promise<ProvidedDocument[]> {
  return db
    .select({ id: courseDocuments.id, title: courseDocuments.title, kind: courseDocuments.kind })
    .from(evaluationProvidedDocuments)
    .innerJoin(courseDocuments, eq(courseDocuments.id, evaluationProvidedDocuments.documentId))
    .where(eq(evaluationProvidedDocuments.evaluationId, evaluationId))
    .orderBy(asc(evaluationProvidedDocuments.position));
}

/** The ids of the selection, in its order: what a template's revision compares. */
export async function providedDocumentIds(db: DbOrTx, evaluationId: string): Promise<string[]> {
  return (await providedDocumentsOf(db, evaluationId)).map((d) => d.id);
}

/**
 * How many documents each of these evaluations provides, in one statement:
 * the count the conditions state (ADR-079, ADR-144 §7). An evaluation that
 * provides none is absent.
 */
export async function providedDocumentCounts(db: DbOrTx, evaluationIds: readonly string[]): Promise<Map<string, number>> {
  if (evaluationIds.length === 0) return new Map();
  const rows = await db
    .select({ evaluationId: evaluationProvidedDocuments.evaluationId, n: count() })
    .from(evaluationProvidedDocuments)
    .where(inArray(evaluationProvidedDocuments.evaluationId, [...evaluationIds]))
    .groupBy(evaluationProvidedDocuments.evaluationId);
  return new Map(rows.map((r) => [r.evaluationId, r.n]));
}

/** {@link providedDocumentCounts} of one evaluation. */
export async function providedDocumentCount(db: DbOrTx, evaluationId: string): Promise<number> {
  return (await providedDocumentCounts(db, [evaluationId])).get(evaluationId) ?? 0;
}

/**
 * The selection of `fromId` given to the copy `toId`, homed at `home`: the
 * documents of the copy's course only — all of them within the course (a
 * duplicate, a template saved, an instance), none into another course, whose
 * library is not this one (ADR-144 §7; the copy dialog says so).
 */
export async function copyProvidedDocuments(db: DbOrTx, fromId: string, toId: string, home: EvaluationHome): Promise<void> {
  const courseId = await courseOfHome(db, home);
  if (courseId === null) return;
  const kept = await db
    .select({ documentId: evaluationProvidedDocuments.documentId, position: evaluationProvidedDocuments.position })
    .from(evaluationProvidedDocuments)
    .innerJoin(courseDocuments, eq(courseDocuments.id, evaluationProvidedDocuments.documentId))
    .where(and(eq(evaluationProvidedDocuments.evaluationId, fromId), eq(courseDocuments.courseId, courseId)));
  if (kept.length === 0) return;
  await db.insert(evaluationProvidedDocuments).values(kept.map((k) => ({ ...k, evaluationId: toId })));
}
