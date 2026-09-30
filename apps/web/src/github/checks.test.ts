import { describe, expect, it } from "vitest";

import type { GithubClassroomLink } from "@quiz/contracts";

import { en } from "../i18n/en";
import { githubChecks } from "./checks";

/*
 * The checks of a connected classroom (F-GH-03): each fact the API sends
 * once, worded by the web. Only the installation line blocks; a fact GitHub
 * did not tell is `unknown`, never green.
 */

const link = (over: {
  org?: Partial<GithubClassroomLink["org"]>;
  checks?: Partial<GithubClassroomLink["checks"]>;
}): GithubClassroomLink => ({
  org: {
    id: "0190d3c4-0000-7000-8000-00000000a001",
    login: "heig-tin-info",
    avatarUrl: null,
    installed: true,
    status: "active",
    plan: "team",
    ...over.org,
  },
  linkedAt: "2026-09-01T00:00:00.000Z",
  checks: { allRepositories: true, llmSecret: "present", ...over.checks },
});

const states = (l: GithubClassroomLink) => githubChecks(l).map((c) => [c.id, c.level, c.text]);

describe("githubChecks", () => {
  it("is all green on an installed organization with every fact present", () => {
    expect(states(link({}))).toEqual([
      ["installation", "ok", "github.check.installed"],
      ["plan", "ok", "github.check.plan"],
      ["llmSecret", "ok", "github.check.llmPresent"],
    ]);
    expect(githubChecks(link({}))[1]!.vars).toEqual({ plan: "team" });
  });

  it("warns on the free plan and on a missing secret, and says what is unknown", () => {
    expect(states(link({ org: { plan: "free" }, checks: { llmSecret: "missing" } })).slice(1)).toEqual([
      ["plan", "warning", "github.check.planFree"],
      ["llmSecret", "warning", "github.check.llmMissing"],
    ]);
    expect(states(link({ org: { plan: null }, checks: { llmSecret: "unknown" } })).slice(1)).toEqual([
      ["plan", "unknown", "github.check.planUnknown"],
      ["llmSecret", "unknown", "github.check.llmUnknown"],
    ]);
  });

  it("blocks on the installation only: gone, uninstalled, or on some repositories", () => {
    const first = (l: GithubClassroomLink) => githubChecks(l)[0]!;
    expect(first(link({ org: { status: "deleted", installed: false } }))).toMatchObject({
      level: "blocker",
      text: "github.check.orgDeleted",
    });
    expect(first(link({ org: { installed: false } }))).toMatchObject({
      level: "blocker",
      text: "github.check.notInstalled",
      fixOnGithub: true,
    });
    expect(first(link({ checks: { allRepositories: false } }))).toMatchObject({
      level: "blocker",
      text: "github.check.partialAccess",
      fixOnGithub: true,
    });
    expect(first(link({ checks: { allRepositories: null } }))).toMatchObject({
      level: "unknown",
      text: "github.check.accessUnknown",
    });
  });

  it("names the plan in its line", () => {
    expect(en["github.check.plan"]).toContain("{plan}");
  });
});
