/**
 * The gradebook routes' refusals (`GradebookErrorCode`, ADR-074), worded by
 * the web app (invariant 1): one class, its status by code.
 */
import type { GradebookErrorCode } from "@quiz/contracts";

import { DomainError } from "../http.js";

/** The state of things is a 409; a score above its maximum a 422, a role the caller lacks a 403. */
const STATUS: Record<GradebookErrorCode, number> = {
  classroom_archived: 409,
  grade_exists: 409,
  score_above_max: 422,
  owner_required: 403,
};

/** A refusal: `{ error: code, message, ...details }`. */
export class GradebookError extends DomainError {
  constructor(code: GradebookErrorCode, message?: string, details?: Readonly<Record<string, unknown>>) {
    super(code, STATUS[code], message ?? code, details);
    this.name = "GradebookError";
  }
}
