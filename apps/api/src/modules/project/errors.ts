/**
 * The project lifecycle's refusals (`ProjectErrorCode`), Accept's
 * (`ProjectAcceptErrorCode`), the review checkpoints'
 * (`ProjectCheckpointErrorCode`) and the revocation the roster's writes
 * call first (`revoke_failed` of `RosterErrorCode`, M3-15b), worded by the
 * web app (invariant 1): one class, its status by code.
 */
import type { ProjectAcceptErrorCode, ProjectCheckpointErrorCode, ProjectErrorCode, RosterErrorCode } from "@quiz/contracts";

import { DomainError } from "../http.js";

type Code = ProjectErrorCode | ProjectAcceptErrorCode | ProjectCheckpointErrorCode | Extract<RosterErrorCode, "revoke_failed">;

/** The state of things is a 409; what the clock or GitHub's contents refuse a 422; too soon a 429; GitHub failing a 502. */
const STATUS: Record<Code, number> = {
  not_connected: 409,
  app_not_installed: 409,
  source_not_found: 422,
  duplicate_slug: 409,
  distribution_failed: 502,
  distribution_missing: 409,
  deadline_past: 422,
  not_draft: 409,
  publish_mode_frozen: 409,
  strategy_frozen: 409,
  unassigned_students: 409,
  repo_unavailable: 409,
  // The group set (ADR-070, M3-15a).
  no_group_set: 409,
  unknown_group_set: 422,
  // Accept (M3-03).
  not_started: 409,
  deadline_passed: 409,
  no_group: 409,
  github_not_linked: 409,
  github_account_stale: 409,
  provision_in_progress: 409,
  repo_name_taken: 409,
  provision_failed: 502,
  // The review checkpoints (M3-05b).
  due_past: 422,
  due_after_deadline: 422,
  duplicate_checkpoint: 409,
  checkpoint_dispatched: 409,
  // The staff's writes (M3-08b): the score, the release, the resend.
  not_frozen: 409,
  to_verify: 409,
  grading_none: 409,
  score_max_required: 422,
  score_max_mismatch: 422,
  score_above_max: 422,
  invitation_not_pending: 409,
  resend_too_soon: 429,
  invite_failed: 502,
  // The roster's writes (M3-15b): GitHub refused a revocation.
  revoke_failed: 502,
};

/** A refusal: `{ error: code, message, ...details }`. */
export class ProjectError extends DomainError {
  constructor(code: Code, message?: string, details?: Readonly<Record<string, unknown>>) {
    super(code, STATUS[code], message ?? code, details);
    this.name = "ProjectError";
  }
}
