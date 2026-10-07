/**
 * The project lifecycle's refusals (`ProjectErrorCode`), Accept's
 * (`ProjectAcceptErrorCode`) and the review checkpoints'
 * (`ProjectCheckpointErrorCode`), worded by the web app (invariant 1): one
 * class, its status by code. (A revocation's `revoke_failed` is a roster
 * refusal, `rosterRefusal` of the `org` module.)
 */
import type { ProjectAcceptErrorCode, ProjectCheckpointErrorCode, ProjectErrorCode, WorkModeRefusal } from "@quiz/contracts";

import { DomainError } from "../http.js";

type Code = ProjectErrorCode | ProjectAcceptErrorCode | ProjectCheckpointErrorCode | WorkModeRefusal;

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
  // The source's sync (M3-07).
  project_archived: 409,
  sync_in_progress: 409,
  source_rewritten: 409,
  sync_failed: 502,
  // *Resync with the set* (M3-15b-2b), and the release waiting for it.
  released: 409,
  classroom_archived: 409,
  needs_confirmation: 409,
  group_sync_pending: 409,
  // The work mode (ADR-047 as amended 2026-10-07, M6-06): a role or a grant the caller lacks is a 403.
  not_invitable: 409,
  owner_required: 403,
  codespace_not_granted: 403,
  work_mode_frozen: 409,
  work_mode_group: 409,
};

/** A refusal: `{ error: code, message, ...details }`. */
export class ProjectError extends DomainError {
  constructor(code: Code, message?: string, details?: Readonly<Record<string, unknown>>) {
    super(code, STATUS[code], message ?? code, details);
    this.name = "ProjectError";
  }
}
