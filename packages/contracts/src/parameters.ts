/**
 * The variables table of a parameterized question (ADR-056 §1), as it
 * travels between the editor, the MCP tools and the API.
 *
 * Teacher-facing only: no student schema carries it, and the student view
 * never sees anything but an instance (invariant 4, docs/05 §5.7).
 *
 * The SHAPE only, with generous caps: a half-typed row is stored with its
 * issues (decision D16). What a row may hold — a free identifier, a known
 * format, an expression the evaluator accepts, unique names — is
 * `@quiz/domain/parameters`' to say (`validateParameters`), on the API, at
 * publication and in a draft's issues: one source, one code per rule.
 */
import { z } from "zod";

/** At most this many rows: a table of one-liners, never a program. */
export const MAX_VARIABLES = 20;

/** Wide enough that no half-typed row is refused, narrow enough to bound a row. */
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

/**
 * The values of one instance, in the table's order, each written with its
 * row's format (ADR-056 §6): the editor's five draws and the grading panel.
 * Teacher-facing only, like the table.
 */
export const NamedValues = z.array(z.object({ name: z.string(), value: z.string() }));
export type NamedValues = z.infer<typeof NamedValues>;
