import { z } from "zod";

/**
 * Reports on a question (issue #680, lot 3): a reader of the pool tells its
 * writers that a question is wrong. Teacher-only data in its own table;
 * nothing of it reaches an attempt or `toStudent` (invariant 4).
 */

export const REPORT_MESSAGE_MAX = 1000;
export const REPORT_REPLY_MAX = 1000;

/** `POST /app/api/questions/:id/reports`. */
export const ReportCreate = z.object({ message: z.string().trim().min(1).max(REPORT_MESSAGE_MAX) });
export type ReportCreate = z.infer<typeof ReportCreate>;

/** `POST /app/api/questions/:id/reports/:reportId/resolve`: the reply is optional. */
export const ReportResolve = z.object({ reply: z.string().trim().max(REPORT_REPLY_MAX).default("") });
export type ReportResolve = z.input<typeof ReportResolve>;

export const ReportParam = z.object({ id: z.uuid(), reportId: z.uuid() });

export const QuestionReportRow = z.object({
  id: z.uuid(),
  questionId: z.uuid(),
  /** The reporter as displayed; null once their account is gone. */
  reporterName: z.string().nullable(),
  /** The CALLER wrote it. */
  mine: z.boolean(),
  message: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  /** Who resolved it; null when open, or closed by the question's deletion. */
  resolvedByName: z.string().nullable(),
  /** The writer's reply; empty when none. */
  resolution: z.string(),
});
export type QuestionReportRow = z.infer<typeof QuestionReportRow>;

/** `GET /app/api/questions/:id/reports`: the reports the caller may read, open ones first. */
export const QuestionReports = z.array(QuestionReportRow);
export type QuestionReports = z.infer<typeof QuestionReports>;
