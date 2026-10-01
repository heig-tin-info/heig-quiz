/**
 * The journal's refusals (`JournalErrorCode`, worded by the web app,
 * invariant 1): one class, its status by code. Shared by the GitHub writes
 * (`writes.ts`), Quiz mode's (`quiz.ts`) and the removal guard the
 * classroom's deletion calls (`service.ts`).
 */
import type { JournalErrorCode } from "@quiz/contracts";

import { DomainError } from "../http.js";

/** The status of each refusal: the state of things (409) but for the upload's own faults and GitHub's silence. An upload over the cap is Fastify's own 413. */
const STATUS: Record<JournalErrorCode, number> = {
  repo_not_found: 409,
  ref_not_found: 409,
  root_not_found: 409,
  forbidden: 409,
  too_large: 409,
  github_unavailable: 503,
  not_connected: 409,
  journal_exists: 409,
  no_journal: 409,
  name_taken: 409,
  conflict: 409,
  page_exists: 409,
  asset_exists: 409,
  confirm_required: 409,
  type_mismatch: 415,
  empty_upload: 400,
  read_only: 409,
};

/** A write refused: `{ error: code, message: code, ...details }`, worded by the web app. */
export class JournalError extends DomainError {
  constructor(code: JournalErrorCode, details?: Readonly<Record<string, unknown>>) {
    super(code, STATUS[code], code, details);
    this.name = "JournalError";
  }
}
