/**
 * The ONE place that orders the import: every writing step, every check. A
 * later part of M8-01 (b projects, c groups, d journals and webhooks) adds a
 * `steps-<entity>.ts` and one line here, in foreign-key order, and touches no
 * other shared file. The order is that of docs/merge/02 §2.5: identity and
 * rosters, then what hangs on them, the legacy audit, and the role recompute
 * LAST (it reads what the steps before it wrote).
 *
 * A step writes through the owning module's writer where there is one, is
 * "insert unless present", applies the re-import rule (`ctx.ts`) to the rows
 * it creates, and `tally`s what it meant to carry. A check reads and returns
 * findings; a `red` one fails the run.
 */
import type { CheckFinding } from "./report.js";
import type { Ctx } from "./ctx.js";
import { importLegacyAudit } from "./steps-audit.js";
import {
  importEnrollments,
  importGithubLinks,
  importGrants,
  importProfiles,
  importStaff,
  importUsers,
  recomputeRoles,
} from "./steps.js";

export interface ImportStep {
  name: string;
  run(ctx: Ctx): Promise<void>;
}

export interface ImportCheck {
  name: string;
  /**
   * Reaches GitHub: runs AFTER the commit (never inside the transaction, never
   * in a dry run, where it is reported "not run"), through a read transaction.
   */
  githubBound?: boolean;
  run(ctx: Ctx): Promise<Omit<CheckFinding, "check">[]>;
}

export interface Registry {
  steps: readonly ImportStep[];
  checks: readonly ImportCheck[];
}

export const REGISTRY: Registry = {
  steps: [
    { name: "users", run: importUsers },
    { name: "profiles", run: importProfiles },
    { name: "github links", run: importGithubLinks },
    { name: "grants", run: importGrants },
    { name: "staff", run: importStaff },
    { name: "enrollments", run: importEnrollments },
    // M8-01b…d insert here, before the legacy audit.
    { name: "legacy audit", run: importLegacyAudit },
    { name: "roles", run: recomputeRoles },
  ],
  checks: [],
};
