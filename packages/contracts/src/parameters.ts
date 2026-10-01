/**
 * The variables table of a parameterized question (ADR-056 §1), as it
 * travels between the editor, the MCP tools and the API.
 *
 * Teacher-facing only: no student schema carries it, and the student view
 * never sees anything but an instance (invariant 4, docs/05 §5.7).
 *
 * Two schemas, like a config's two gates. {@link ParametersDraft} is what an
 * autosave accepts: the shape and generous caps, nothing more, because a
 * half-typed row is STORED with its issues (decision D16). {@link Parameters}
 * adds the vocabulary of `@quiz/domain` — a free identifier, a known format,
 * an expression under the cap, unique names — and is what a caller checks
 * before asking for a publication. The evaluator itself (mathjs) never
 * reaches this package: publication validates the expressions on the API.
 */
import { z } from "zod";

import { FORMAT_PATTERN, isVariableName, MAX_EXPRESSION_LENGTH } from "@quiz/domain";

/** At most this many rows: a table of one-liners, never a program. */
export const MAX_VARIABLES = 20;

/** Draft caps: wide enough that no half-typed row is refused, narrow enough to bound a row. */
const DRAFT_TEXT = 1_000;

const VariableRowDraft = z.object({
  name: z.string().max(64),
  expr: z.string().max(DRAFT_TEXT),
  format: z.string().max(8).default(""),
});

export const ParametersDraft = z.object({
  rows: z.array(VariableRowDraft).max(MAX_VARIABLES),
  condition: z.string().max(DRAFT_TEXT).optional(),
});
export type ParametersDraft = z.infer<typeof ParametersDraft>;

export const Parameters = ParametersDraft.superRefine((params, ctx) => {
  const seen = new Set<string>();
  params.rows.forEach((row, index) => {
    if (!isVariableName(row.name) || seen.has(row.name)) {
      ctx.addIssue({ code: "custom", path: ["rows", index, "name"], message: "parameters.bad_name" });
    }
    seen.add(row.name);
    if (!FORMAT_PATTERN.test(row.format)) {
      ctx.addIssue({ code: "custom", path: ["rows", index, "format"], message: "parameters.bad_format" });
    }
    if (row.expr.length > MAX_EXPRESSION_LENGTH) {
      ctx.addIssue({ code: "custom", path: ["rows", index, "expr"], message: "parameters.too_long" });
    }
  });
  if ((params.condition?.length ?? 0) > MAX_EXPRESSION_LENGTH) {
    ctx.addIssue({ code: "custom", path: ["condition"], message: "parameters.too_long" });
  }
});
export type Parameters = z.infer<typeof Parameters>;
