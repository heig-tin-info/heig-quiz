/**
 * The group routes' refusals (`GroupErrorCode`, ADR-070), worded by the web
 * app (invariant 1): one class, its status by code.
 */
import type { GroupErrorCode } from "@quiz/contracts";

import { DomainError } from "../http.js";

/** The state of things is a 409; a size the set cannot cut a 422. */
const STATUS: Record<GroupErrorCode, number> = {
  classroom_archived: 409,
  set_in_use: 409,
  duplicate_name: 409,
  nobody_to_place: 409,
  size_out_of_range: 422,
  has_repo: 409,
  needs_confirmation: 409,
};

/** A refusal: `{ error: code, message, ...details }`. */
export class GroupError extends DomainError {
  constructor(code: GroupErrorCode, message?: string, details?: Readonly<Record<string, unknown>>) {
    super(code, STATUS[code], message ?? code, details);
    this.name = "GroupError";
  }
}
