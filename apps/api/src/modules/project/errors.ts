/**
 * The project lifecycle's refusals (`ProjectErrorCode`), Accept's
 * (`ProjectAcceptErrorCode`), the review checkpoints'
 * (`ProjectCheckpointErrorCode`) and the distribution's access
 * (`ProjectDistributionAccessErrorCode`), worded by the web app (invariant 1): one
 * class, its status by code. (A revocation's `revoke_failed` is a roster
 * refusal, `rosterRefusal` of the `org` module.)
 */
import type {
  ProjectAcceptErrorCode,
  ProjectCheckpointErrorCode,
  ProjectDistributionAccessErrorCode,
  ProjectErrorCode,
  WorkModeRefusal,
} from "@quiz/contracts";

import { DomainError } from "../http.js";

type Code = ProjectErrorCode | ProjectAcceptErrorCode | ProjectCheckpointErrorCode | ProjectDistributionAccessErrorCode | WorkModeRefusal;

/** The state of things is a 409; what the clock or GitHub's contents refuse a 422; too soon a 429; GitHub failing a 502. */
const STATUS: Record<Code, number> = {
  not_connected: 409,
  app_not_installed: 409,
  source_not_found: 422,
  duplicate_slug: 409,
  distribution_failed: 502,
  distribution_missing: 409,
  deadline_past: 422,
  start_past: 422,
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
  // Grading by criteria (ADR-106 §2): the source's `criteria.yml` missing or invalid.
  criteria_invalid: 409,
  checkpoint_untagged: 409,
  unknown_criterion: 422,
  criterion_conflict: 422,
  identity_criterion_invalid: 422,
  command_needs_network: 422,
  // A Regrade (ADR-106 §4).
  not_criteria: 409,
  regrade_limit: 429,
  // The grading screen and the release gate (ADR-106 §8).
  points_out_of_range: 422,
  criteria_incomplete: 409,
  not_validated: 409,
  owner_required: 403,
  // Access to the distribution repository (#899): only a staff seat asks.
  staff_seat_required: 403,
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
