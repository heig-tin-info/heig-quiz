/**
 * The ONE place that orders the import: every writing step, every check. A
 * part of M8-01 (b projects, c groups, d journals and webhooks) added a
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
import { groupChecks } from "./checks-groups.js";
import { projectChecks } from "./checks-projects.js";
import { importLegacyAudit } from "./steps-audit.js";
import { importGroupRepoAccess, importGroups } from "./steps-groups.js";
import { importCheckpoints, importProjects, importReminders } from "./steps-projects.js";
import { importBotCommits, importDispatches, importGradeRuns, importPushReceipts, importRepos, importReverts } from "./steps-repos.js";
import { importJournals, ingestImportedJournals, journalsReingested } from "./steps-journals.js";
import { importWebhookDeliveries } from "./steps-webhooks.js";
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

/**
 * Runs once the transaction has COMMITTED and never in a dry run, before the
 * GitHub-bound checks, with no transaction open (`db` is gone from its context:
 * a PGlite connection would deadlock on a second one). It reaches GitHub and
 * the Quiz database through the owning module's own functions.
 */
export interface AfterCommit {
  name: string;
  run(ctx: Omit<Ctx, "db">): Promise<void>;
}

export interface Registry {
  steps: readonly ImportStep[];
  afterCommit?: readonly AfterCommit[];
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
    // M8-01b: projects and what hangs on them, in foreign-key order.
    { name: "projects", run: importProjects },
    { name: "checkpoints", run: importCheckpoints },
    // M8-01c: the group sets and the projects' copies, before the repositories that name a copy group.
    { name: "group sets and groups", run: importGroups },
    { name: "project repositories", run: importRepos },
    { name: "group repository access", run: importGroupRepoAccess },
    { name: "grade runs", run: importGradeRuns },
    { name: "bot commits", run: importBotCommits },
    { name: "review ledger", run: importDispatches },
    { name: "reverts", run: importReverts },
    { name: "push receipts", run: importPushReceipts },
    { name: "project reminders", run: importReminders },
    { name: "classroom journals", run: importJournals },
    { name: "webhook deliveries", run: importWebhookDeliveries },
    { name: "legacy audit", run: importLegacyAudit },
    { name: "roles", run: recomputeRoles },
  ],
  afterCommit: [{ name: "journal ingestion", run: ingestImportedJournals }],
  checks: [...projectChecks, ...groupChecks, journalsReingested],
};
