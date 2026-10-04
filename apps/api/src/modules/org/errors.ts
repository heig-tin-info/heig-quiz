/**
 * The refusals of the roster's writes (`RosterErrorCode`), worded by the web
 * app (invariant 1): `duplicate_email`, `already_enrolled`, and
 * `revoke_failed` — GitHub did not take a leaving line's access away
 * (F-PROJ-17), which the `project` module's revocation raises.
 */
import type { RosterErrorCode } from "@quiz/contracts";

import { DomainError } from "../http.js";

const REFUSALS: Record<RosterErrorCode, { status: number; message: string }> = {
  duplicate_email: { status: 409, message: "This e-mail is already in the roster" },
  already_enrolled: { status: 409, message: "You are already enrolled in this classroom under another address" },
  revoke_failed: { status: 502, message: "GitHub did not take the student's access away: nothing was changed, try again" },
};

/** The one refusal of a roster write: `{ error: code, message, ...details }`. */
export function rosterRefusal(code: RosterErrorCode, details?: Readonly<Record<string, unknown>>): DomainError {
  return new DomainError(code, REFUSALS[code].status, REFUSALS[code].message, details);
}
