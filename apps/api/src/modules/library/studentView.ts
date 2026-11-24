/**
 * The student view of the `library` module (ADR-144 §7, F-LIVE-15,
 * invariant 4): THE one exit of a course document toward a student.
 *
 * A student reaches a document only as one the evaluation of their own
 * attempt provides, a document of that evaluation's own course, while the
 * read rule holds (`providedDocumentsReadable`, `@quiz/domain`): an exam's
 * official attempt in progress while the exam runs and before its deadline
 * plus the grace; an exercise's open attempt, its practice after the due
 * date included; never in the lobby, during a pause, once it is over, nor
 * in an exam's blank practice. The caller hands the rows it loaded as the
 * caller's own (`live`'s attempt loader); the rule is applied here, so no
 * caller can forget it.
 *
 * What leaves is the title and the kind ({@link providedDocuments}), a PDF's
 * bytes named after its title ({@link providedFile}) and a Markdown
 * document's rendered HTML ({@link providedHtml}), of the row
 * {@link providedDocument} found — never the uploaded file name, the hash,
 * the uploader, the Markdown source or the warnings. Nothing is audited and
 * no attempt event is written for a reading (ADR-144 §7, as ADR-069 §7).
 *
 * This module does not write `evaluation_provided_documents` (the
 * `evaluation` module does); it reads it by join.
 */
import { and, asc, eq } from "drizzle-orm";
import type { PgSelect } from "drizzle-orm/pg-core";

import type { DocumentHtml, ProvidedDocument } from "@quiz/contracts";
import { providedDocumentsReadable, type EvaluationModeName, type GatedAttempt } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { classrooms, courseDocuments, evaluationProvidedDocuments, evaluations } from "../../db/schema.js";
import { documentFile, type DocumentRow as Row } from "./files.js";

/** The caller's own attempt and its evaluation, as the student route loaded them. */
export interface ReadingAttempt {
  evaluation: { id: string; mode: EvaluationModeName; state: string };
  attempt: GatedAttempt;
}

const readable = ({ evaluation, attempt }: ReadingAttempt, now: Date) =>
  providedDocumentsReadable({ mode: evaluation.mode, evaluationState: evaluation.state, attempt }, now);

/**
 * The provided documents of the evaluation, in their order, joined to its
 * classroom's course: a row whose document is of another course is never
 * one (the writer refuses it; this read does not trust it). `documentId`
 * narrows it to one. The one join both reads below build on, each from its
 * own `select … from evaluation_provided_documents`: the fields stay typed,
 * so the compiler checks what leaves.
 */
function selection<T extends PgSelect>(query: T, evaluationId: string, documentId?: string) {
  return query
    .innerJoin(courseDocuments, eq(courseDocuments.id, evaluationProvidedDocuments.documentId))
    .innerJoin(evaluations, eq(evaluations.id, evaluationProvidedDocuments.evaluationId))
    .innerJoin(classrooms, eq(classrooms.id, evaluations.classroomId))
    .where(
      and(
        eq(evaluationProvidedDocuments.evaluationId, evaluationId),
        eq(courseDocuments.courseId, classrooms.courseId),
        documentId === undefined ? undefined : eq(evaluationProvidedDocuments.documentId, documentId),
      ),
    )
    .orderBy(asc(evaluationProvidedDocuments.position));
}

/** The documents the attempt may read now, in the teacher's order; `[]` while the rule is false. */
export async function providedDocuments(db: Db, scope: ReadingAttempt, now: Date): Promise<ProvidedDocument[]> {
  if (!readable(scope, now)) return [];
  const fields = { id: courseDocuments.id, title: courseDocuments.title, kind: courseDocuments.kind };
  return selection(db.select(fields).from(evaluationProvidedDocuments).$dynamic(), scope.evaluation.id);
}

/** One document the attempt may read now, to serve; null — the route's 404 — otherwise. */
export async function providedDocument(
  db: Db,
  scope: ReadingAttempt,
  documentId: string,
  now: Date,
): Promise<Row | null> {
  if (!readable(scope, now)) return null;
  const query = db.select({ document: courseDocuments }).from(evaluationProvidedDocuments).$dynamic();
  const [row] = await selection(query, scope.evaluation.id, documentId);
  return row?.document ?? null;
}

/** A PDF's file, to stream, named after its title: the uploaded file name is the staff's alone. */
export async function providedFile(assetsDir: string, row: Row): Promise<Awaited<ReturnType<typeof documentFile>>> {
  return { ...(await documentFile(assetsDir, row)), filename: `${row.title}.pdf` };
}

/** A Markdown document as a viewer shows it: its HTML rendered at upload and its outline. */
export function providedHtml(row: Row): DocumentHtml {
  return { html: row.html ?? "", toc: row.toc ?? [] };
}
