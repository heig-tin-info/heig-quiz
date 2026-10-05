/**
 * The one mapping of GitHub's run into the ingestion's (ADR-011 §1, merge
 * task M3-06): what the `workflow_run` webhook and the reconciliation's
 * listing both go through.
 */
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../config.js";
import { completedRun, RawWorkflowRun } from "./grading.js";

const config = loadConfig({ NODE_ENV: "test", GITHUB_APP_SLUG: "quiz-test" });
const RECEIVED = new Date("2026-10-05T10:00:00.000Z");

const full = {
  id: 4242,
  run_attempt: 2,
  head_branch: "main",
  head_sha: "a".repeat(40),
  conclusion: "success",
  path: ".github/workflows/grading.yml",
  event: "repository_dispatch",
  check_suite_id: 77,
  updated_at: "2026-10-05T09:58:00.000Z",
  run_started_at: "2026-10-05T09:55:00.000Z",
  triggering_actor: { login: "quiz-test[bot]" },
};

describe("completedRun", () => {
  it("maps every field GitHub gives", () => {
    expect(completedRun(config, full, RECEIVED)).toEqual({
      workflowRunId: 4242,
      runAttempt: 2,
      headBranch: "main",
      headSha: "a".repeat(40),
      conclusion: "success",
      path: ".github/workflows/grading.yml",
      event: "repository_dispatch",
      checkSuiteId: 77,
      triggeredBy: "app",
      startedAt: new Date("2026-10-05T09:55:00.000Z"),
      completedAt: new Date("2026-10-05T09:58:00.000Z"),
    });
  });

  it("fills what GitHub left out: the first attempt, an unknown conclusion, the receipt as completion, no start", () => {
    const run = completedRun(config, { id: 1, head_sha: "b".repeat(40) }, RECEIVED);
    expect(run).toMatchObject({
      runAttempt: 1,
      headBranch: "",
      conclusion: "unknown",
      path: "",
      event: "",
      checkSuiteId: null,
      startedAt: null,
      completedAt: RECEIVED,
    });
    // An unreadable date is as good as none.
    expect(completedRun(config, { ...full, updated_at: "yesterday", run_started_at: "noon" }, RECEIVED)).toMatchObject({
      startedAt: null,
      completedAt: RECEIVED,
    });
  });

  it("names who triggered the run by its triggering actor alone, a person when none is given (fail closed)", () => {
    expect(completedRun(config, { ...full, triggering_actor: { login: "github-actions[bot]" } }, RECEIVED).triggeredBy).toBe("workflow");
    expect(completedRun(config, { ...full, triggering_actor: { login: "kid" } }, RECEIVED).triggeredBy).toBe("person");
    expect(completedRun(config, { ...full, triggering_actor: null }, RECEIVED).triggeredBy).toBe("person");
    expect(completedRun(config, { ...full, triggering_actor: undefined }, RECEIVED).triggeredBy).toBe("person");
  });

  it("takes the ids Octokit's listing types as bigint (I62), and the webhook's parsed payload alike", () => {
    expect(completedRun(config, { ...full, id: 4242n, check_suite_id: 77n }, RECEIVED)).toMatchObject({ workflowRunId: 4242, checkSuiteId: 77 });
    const parsed = RawWorkflowRun.parse({ ...full, extra: "ignored" });
    expect(completedRun(config, parsed, RECEIVED)).toEqual(completedRun(config, full, RECEIVED));
  });
});
