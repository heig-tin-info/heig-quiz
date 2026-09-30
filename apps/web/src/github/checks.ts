/**
 * The checks of a connected classroom (F-GH-03, `docs/merge/05-web.md` §5.3),
 * as data: one line per fact, its state, and the sentence that words it.
 * The API sends each fact once (M2-01): the installation line is derived
 * from the organization (`installed`, `status`) and `checks.allRepositories`,
 * the plan line from `org.plan` (`free` ⇒ the warning, null ⇒ unknown), the
 * LLM secret line from `checks.llmSecret`. No sentence comes from the server
 * (invariant 1).
 *
 * Only the installation line blocks: without the App on every repository,
 * nothing GitHub-backed works. A free plan and a missing secret are
 * warnings; a fact GitHub did not tell is `unknown`, never green.
 */
import type { GithubClassroomLink } from "@quiz/contracts";

import type { Dict } from "../i18n/en";

export type CheckState = "ok" | "warn" | "blocked" | "unknown";

export interface CheckLine {
  id: "installation" | "plan" | "llmSecret";
  state: CheckState;
  text: keyof Dict;
  vars?: Record<string, string>;
  /** The line's way out is on GitHub (the App's installation page). */
  fixOnGithub?: boolean;
}

function installationLine({ org, checks }: GithubClassroomLink): CheckLine {
  const id = "installation";
  if (org.status === "deleted") return { id, state: "blocked", text: "github.check.orgDeleted" };
  if (!org.installed) return { id, state: "blocked", text: "github.check.notInstalled", fixOnGithub: true };
  if (checks.allRepositories === false) {
    return { id, state: "blocked", text: "github.check.partialAccess", fixOnGithub: true };
  }
  if (checks.allRepositories === null) return { id, state: "unknown", text: "github.check.accessUnknown" };
  return { id, state: "ok", text: "github.check.installed" };
}

function planLine({ org }: GithubClassroomLink): CheckLine {
  const id = "plan";
  if (org.plan === null) return { id, state: "unknown", text: "github.check.planUnknown" };
  if (org.plan === "free") return { id, state: "warn", text: "github.check.planFree" };
  return { id, state: "ok", text: "github.check.plan", vars: { plan: org.plan } };
}

const LLM_SECRET: Record<GithubClassroomLink["checks"]["llmSecret"], CheckLine> = {
  present: { id: "llmSecret", state: "ok", text: "github.check.llmPresent" },
  missing: { id: "llmSecret", state: "warn", text: "github.check.llmMissing" },
  unknown: { id: "llmSecret", state: "unknown", text: "github.check.llmUnknown" },
};

/** The three lines, in the order of the spec: installation, plan, LLM secret. */
export function githubChecks(link: GithubClassroomLink): CheckLine[] {
  return [installationLine(link), planLine(link), LLM_SECRET[link.checks.llmSecret]];
}
