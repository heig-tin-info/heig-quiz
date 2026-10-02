/**
 * The validation issues of a draft (decision D16), translated.
 *
 * `PUT /questions/:id/draft` stores whatever the teacher typed and answers
 * with `issues[]`; publication refuses with the same shape. A message is
 * either a key the question type's schema raised (`mcq.no_correct_choice`)
 * or a generic zod issue (`too_small`, `invalid_type`…), which is said from
 * its `code`, `origin` and `limit` — never with zod's own English sentence.
 */
import type { ConfigIssue } from "@quiz/core/client";
import { NOT_ZOD_ISSUE, type ZodIssueLite } from "@quiz/contracts";

import type { Dict, TFunction } from "../i18n";

/** The schema messages this app knows how to say in French. */
const KNOWN: Record<string, keyof Dict> = {
  "mcq.no_correct_choice": "issue.mcq.no_correct_choice",
  "mcq.single_needs_one": "issue.mcq.single_needs_one",
  "mcq.max_below_correct": "issue.mcq.max_below_correct",
  "categorize.duplicate_id": "issue.categorize.duplicate_id",
  "categorize.unknown_card": "issue.categorize.unknown_card",
  "categorize.card_twice": "issue.categorize.card_twice",
  "categorize.no_target": "issue.categorize.no_target",
  "cloze.no_blank": "issue.cloze.no_blank",
  "cloze.too_many_blanks": "issue.cloze.too_many_blanks",
  "short.invalid_pattern": "issue.short.invalid_pattern",
  "short.integer_expected": "issue.short.integer_expected",
  "short.length_range": "issue.short.length_range",
  "short.number_range": "issue.short.number_range",
  "short.date_range": "issue.short.date_range",
  "short.llm_not_available": "issue.short.llm_not_available",
  "circuit.llm_not_available": "issue.circuit.llm_not_available",
  "short.unresolved_reference": "issue.short.unresolved_reference",
  "short.computed_text_key": "issue.short.computed_text_key",
  "short.tolerance_below_format": "issue.short.tolerance_below_format",
  "parameters.bad_name": "issue.parameters.bad_name",
  "parameters.duplicate_name": "issue.parameters.duplicate_name",
  "parameters.bad_format": "issue.parameters.bad_format",
  "parameters.too_long": "issue.parameters.too_long",
  "parameters.too_complex": "issue.parameters.too_complex",
  "parameters.empty_expression": "issue.parameters.empty_expression",
  "parameters.parse_error": "issue.parameters.parse_error",
  "parameters.forbidden_node": "issue.parameters.forbidden_node",
  "parameters.unknown_function": "issue.parameters.unknown_function",
  "parameters.unknown_name": "issue.parameters.unknown_name",
  "parameters.unterminated": "issue.parameters.unterminated",
  "parameters.not_a_number": "issue.parameters.not_a_number",
  "parameters.not_a_boolean": "issue.parameters.not_a_boolean",
  "parameters.eval_error": "issue.parameters.eval_error",
  "parameters.condition_exhausted": "issue.parameters.condition_exhausted",
  "parameters.choices_not_distinct": "issue.parameters.choices_not_distinct",
  "parameters.too_slow": "issue.parameters.too_slow",
  "parameters.unsupported_type": "issue.parameters.unsupported_type",
  "codeimage.target_missing": "issue.codeimage.target_missing",
  "codeimage.target_size": "issue.codeimage.target_size",
  "codeimage.target_value": "issue.codeimage.target_value",
  "diagram.reference_missing": "issue.diagram.reference_missing",
  "diagram.kind_mismatch": "issue.diagram.kind_mismatch",
};

/** The generic zod codes, by what they measured: `too_small` of a string, of an array… */
const SIZED: Record<string, Record<string, keyof Dict>> = {
  too_small: { string: "issue.zod.string_min", array: "issue.zod.array_min", number: "issue.zod.number_min" },
  too_big: { string: "issue.zod.string_max", array: "issue.zod.array_max", number: "issue.zod.number_max" },
};

type IssueText = Pick<ZodIssueLite, "code" | "message" | "origin" | "limit">;

export function issueMessage(t: TFunction, issue: IssueText): string {
  const known = KNOWN[issue.message];
  if (known) return t(known);
  const sized = SIZED[issue.code]?.[issue.origin ?? ""];
  if (sized && issue.limit !== undefined) {
    // An empty field is the common case, and "at least 1 character" says it badly.
    return sized === "issue.zod.string_min" && issue.limit === 1 ? t("issue.zod.required") : t(sized, { n: issue.limit });
  }
  // A custom refinement this app does not know yet, or an error that was not
  // zod's (a config that could not be migrated), still says what it is; a
  // generic zod code never shows zod's own sentence.
  return issue.code === "custom" || issue.code === NOT_ZOD_ISSUE ? issue.message : t("issue.zod.invalid");
}

/** The wire shape turned into what an editor's `issues` prop expects. */
export function toConfigIssues(t: TFunction, issues: readonly ZodIssueLite[]): ConfigIssue[] {
  return issues.map((issue) => ({
    path: issue.path,
    message: issueMessage(t, issue),
  }));
}

/** The `details` of a 422, when the server sent the issue list. */
export function issuesOfError(error: unknown): ZodIssueLite[] {
  const body = (error as { body?: { details?: unknown } } | undefined)?.body;
  const details = body?.details;
  return Array.isArray(details) ? (details as ZodIssueLite[]) : [];
}
