/**
 * The validation issues of a draft (decision D16), translated.
 *
 * `PUT /questions/:id/draft` stores whatever the teacher typed and answers
 * with `issues[]`; publication refuses with the same shape. A message is
 * either a key the question type's schema raised (`mcq.no_correct_choice`)
 * or a zod sentence, and only the first can be translated — hence the
 * lookup with a fallback rather than a `t()` call at the call site.
 */
import type { ConfigIssue } from "@quiz/core/client";
import type { ZodIssueLite } from "@quiz/contracts";

import type { Dict, TFunction } from "../i18n";

/** The schema messages this app knows how to say in French. */
const KNOWN: Record<string, keyof Dict> = {
  "mcq.no_correct_choice": "issue.mcq.no_correct_choice",
  "mcq.single_needs_one": "issue.mcq.single_needs_one",
  "mcq.max_below_correct": "issue.mcq.max_below_correct",
  "cloze.no_blank": "issue.cloze.no_blank",
  "cloze.too_many_blanks": "issue.cloze.too_many_blanks",
  "short.invalid_pattern": "issue.short.invalid_pattern",
  "short.integer_expected": "issue.short.integer_expected",
  "short.length_range": "issue.short.length_range",
  "short.number_range": "issue.short.number_range",
  "short.date_range": "issue.short.date_range",
};

export function issueMessage(t: TFunction, message: string): string {
  const key = KNOWN[message];
  return key ? t(key) : message;
}

/** The wire shape turned into what an editor's `issues` prop expects. */
export function toConfigIssues(t: TFunction, issues: readonly ZodIssueLite[]): ConfigIssue[] {
  return issues.map((issue) => ({
    path: issue.path,
    message: issueMessage(t, issue.message),
  }));
}

/** The `details` of a 422, when the server sent the issue list. */
export function issuesOfError(error: unknown): ZodIssueLite[] {
  const body = (error as { body?: { details?: unknown } } | undefined)?.body;
  const details = body?.details;
  return Array.isArray(details) ? (details as ZodIssueLite[]) : [];
}
