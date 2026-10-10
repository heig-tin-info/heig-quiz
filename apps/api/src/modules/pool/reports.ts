/**
 * Reports on a question (issue #680, lot 3): whoever reads a question in the
 * pool tells its writers it is wrong, with a message; a writer resolves the
 * report with an optional reply the reporter is told of.
 *
 * Teacher-only data: nothing here is ever read by an attempt or by
 * `toStudent` (invariant 4). Who may REPORT is decided by the route's loader
 * (`poolAccess`); who may READ is decided here: the pool's writers see every
 * report, anyone else only their own.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { QuestionReportRow } from "@quiz/contracts";
import { displayName } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { questionReports, users } from "../../db/schema.js";
import { DomainError, notFoundError } from "../http.js";
import { notifyMany } from "../notifications/service.js";
import { poolAudience } from "./members.js";
import type { PoolRow, QuestionRecord } from "./shared.js";

/** Who is asking: their reach of the reports. */
export interface ReportViewer {
  id: string;
  /** A writer of the pool (or Super Powers): every report, not only their own. */
  seesAll: boolean;
}

type ReportRow = typeof questionReports.$inferSelect;

/** The reports a viewer may read, as a `where`. */
const readable = (viewer: ReportViewer) =>
  viewer.seesAll ? undefined : eq(questionReports.reporterId, viewer.id);

/** A report not resolved yet. */
const open = isNull(questionReports.resolvedAt);

/** The display names of some accounts, in one lookup for the page. */
async function namesOf(db: Db, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, givenName: users.givenName, familyName: users.familyName, email: users.email })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((u) => [u.id, displayName(u)]));
}

function reportJson(row: ReportRow, viewer: ReportViewer, names: Map<string, string>): QuestionReportRow {
  return {
    id: row.id,
    questionId: row.questionId,
    reporterName: row.reporterId ? (names.get(row.reporterId) ?? null) : null,
    mine: row.reporterId === viewer.id,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByName: row.resolvedBy ? (names.get(row.resolvedBy) ?? null) : null,
    resolution: row.resolution,
  };
}

/** `GET /questions/:id/reports`: the reports the viewer may read, open ones first, then newest first. */
export async function listReports(db: Db, questionId: string, viewer: ReportViewer): Promise<QuestionReportRow[]> {
  const rows = await db
    .select()
    .from(questionReports)
    .where(and(eq(questionReports.questionId, questionId), readable(viewer)))
    .orderBy(sql`${questionReports.resolvedAt} is not null`, desc(questionReports.createdAt));
  const names = await namesOf(db, rows.flatMap((r) => [r.reporterId, r.resolvedBy]));
  return rows.map((r) => reportJson(r, viewer, names));
}

/** The open reports the viewer may read, per question: the pool list's indicator. */
export async function openReportCounts(
  db: Db,
  questionIds: readonly string[],
  viewer: ReportViewer,
): Promise<Map<string, number>> {
  if (questionIds.length === 0) return new Map();
  const rows = await db
    .select({ questionId: questionReports.questionId, n: sql<number>`count(*)::int` })
    .from(questionReports)
    .where(and(inArray(questionReports.questionId, [...questionIds]), open, readable(viewer)))
    .groupBy(questionReports.questionId);
  return new Map(rows.map((r) => [r.questionId, r.n]));
}

/**
 * Files a report on `question` and tells the writers of its pool, folded per
 * question. The notification is best-effort: the report is already written.
 */
export async function createReport(
  db: Db,
  input: { question: QuestionRecord; pool: PoolRow; reporterId: string; message: string },
): Promise<ReportRow> {
  const [row] = await db
    .insert(questionReports)
    .values({
      id: randomUUID(),
      questionId: input.question.id,
      reporterId: input.reporterId,
      message: input.message,
    })
    .returning();
  try {
    const writers = (await poolAudience(db, input.pool, ["contributor", "owner"])).filter(
      (id) => id !== input.reporterId,
    );
    await notifyMany(
      db,
      writers.map((userId) => ({
        userId,
        payload: {
          kind: "question_reported" as const,
          poolId: input.pool.id,
          poolName: input.pool.name,
          questionId: input.question.id,
          questionName: input.question.internalName,
          count: 1,
        },
      })),
    );
  } catch (err) {
    console.error(`pool: telling the writers of a report on ${input.question.id} failed`, err);
  }
  return row!;
}

/**
 * A writer resolves one report with an optional reply, and the reporter is
 * told (unless they resolve their own). 404 for a report of another
 * question, 409 `report_resolved` for one already closed.
 */
export async function resolveReport(
  db: Db,
  input: { question: QuestionRecord; pool: PoolRow; reportId: string; resolverId: string; reply: string; now: Date },
): Promise<ReportRow> {
  const [row] = await db
    .update(questionReports)
    .set({ resolvedAt: input.now, resolvedBy: input.resolverId, resolution: input.reply })
    .where(
      and(
        eq(questionReports.id, input.reportId),
        eq(questionReports.questionId, input.question.id),
        open,
      ),
    )
    .returning();
  if (!row) {
    const [existing] = await db
      .select({ id: questionReports.id })
      .from(questionReports)
      .where(and(eq(questionReports.id, input.reportId), eq(questionReports.questionId, input.question.id)))
      .limit(1);
    if (!existing) throw notFoundError("report");
    throw new DomainError("report_resolved", 409, "This report is already resolved");
  }
  if (row.reporterId && row.reporterId !== input.resolverId) {
    try {
      await notifyMany(db, [
        {
          userId: row.reporterId,
          payload: {
            kind: "question_report_resolved",
            poolId: input.pool.id,
            poolName: input.pool.name,
            questionId: input.question.id,
            questionName: input.question.internalName,
          },
        },
      ]);
    } catch (err) {
      console.error(`pool: telling the reporter of report ${row.id} failed`, err);
    }
  }
  return row;
}

/**
 * A question moved to the deleted: its open reports close with it, without a
 * resolver and without a reply (`resolved_by` null), and nobody is told.
 * Inside the deleting transaction.
 */
export async function closeReportsOf(tx: Tx | Db, questionId: string, now: Date): Promise<void> {
  await tx
    .update(questionReports)
    .set({ resolvedAt: now })
    .where(and(eq(questionReports.questionId, questionId), open));
}
