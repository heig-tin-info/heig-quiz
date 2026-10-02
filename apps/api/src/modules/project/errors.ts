/**
 * The project lifecycle's refusals (`ProjectErrorCode`) and Accept's
 * (`ProjectAcceptErrorCode`), worded by the web app (invariant 1): one
 * class, its status by code.
 */
import type { ProjectAcceptErrorCode, ProjectErrorCode } from "@quiz/contracts";

import { DomainError } from "../http.js";

/** The state of things is a 409; what the clock or GitHub's contents refuse a 422; GitHub failing a 502. */
const STATUS: Record<ProjectErrorCode | ProjectAcceptErrorCode, number> = {
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
  // Accept (M3-03).
  not_started: 409,
  deadline_passed: 409,
  no_group: 409,
  github_not_linked: 409,
  github_account_stale: 409,
  provision_in_progress: 409,
  repo_name_taken: 409,
  provision_failed: 502,
};

/** A refusal: `{ error: code, message, ...details }`. */
export class ProjectError extends DomainError {
  constructor(code: ProjectErrorCode | ProjectAcceptErrorCode, message?: string, details?: Readonly<Record<string, unknown>>) {
    super(code, STATUS[code], message ?? code, details);
    this.name = "ProjectError";
  }
}
