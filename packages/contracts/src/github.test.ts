import { describe, expect, it } from "vitest";

import {
  GithubAccountState,
  GithubClassroom,
  GithubConnectBody,
  GithubLinkOutcome,
  GithubOrg,
} from "./github.js";

const ID = "018f0000-0000-7000-8000-000000000000";
const AT = "2026-09-30T08:00:00.000Z";

const org: GithubOrg = {
  id: ID,
  login: "heig-tin-info",
  avatarUrl: `/app/api/github/orgs/${ID}/avatar`,
  status: "installed",
  plan: "team",
};

const classroom: GithubClassroom = {
  link: { org, linkedAt: AT, checks: { app: "ok", plan: "ok", llmSecret: "unknown" } },
  suggestedOrgId: null,
  installUrl: `https://github.com/apps/heig-quiz/installations/new?state=${ID}`,
};

describe("GithubOrg", () => {
  it("parses an organization, with or without its avatar", () => {
    expect(GithubOrg.parse(org)).toEqual(org);
    expect(GithubOrg.safeParse({ ...org, avatarUrl: null }).success).toBe(true);
  });

  it("refuses an avatar the browser would fetch from elsewhere", () => {
    for (const avatarUrl of [
      "https://avatars.githubusercontent.com/u/1?v=4",
      "//avatars.githubusercontent.com/u/1",
      "app/api/github/orgs/x/avatar",
    ]) {
      expect(GithubOrg.safeParse({ ...org, avatarUrl }).success, avatarUrl).toBe(false);
    }
  });

  it("refuses a status outside the closed list", () => {
    expect(GithubOrg.safeParse({ ...org, status: "active" }).success).toBe(false);
  });
});

describe("GithubClassroom", () => {
  it("parses a connected classroom and a plain one", () => {
    expect(GithubClassroom.parse(classroom)).toEqual(classroom);
    expect(GithubClassroom.safeParse({ ...classroom, link: null, suggestedOrgId: ID }).success).toBe(true);
  });

  it("closes every check on its own states", () => {
    const withChecks = (checks: Record<string, string>) =>
      GithubClassroom.safeParse({ ...classroom, link: { ...classroom.link, checks } }).success;
    expect(withChecks({ app: "selected_repositories", plan: "free", llmSecret: "missing" })).toBe(true);
    expect(withChecks({ app: "present", plan: "ok", llmSecret: "missing" })).toBe(false);
    expect(withChecks({ app: "ok", plan: "missing", llmSecret: "missing" })).toBe(false);
    expect(withChecks({ app: "ok", plan: "ok", llmSecret: "ok" })).toBe(false);
  });

  it("sends the teacher to GitHub only, over https", () => {
    for (const installUrl of ["http://github.com/apps/x/installations/new", "https://evil.example/apps/x", "javascript:alert(1)"]) {
      expect(GithubClassroom.safeParse({ ...classroom, installUrl }).success, installUrl).toBe(false);
    }
  });
});

describe("GithubConnectBody", () => {
  it("takes an organization id and nothing else", () => {
    expect(GithubConnectBody.parse({ orgId: ID })).toEqual({ orgId: ID });
    expect(GithubConnectBody.safeParse({ orgId: "heig-tin-info" }).success).toBe(false);
    expect(GithubConnectBody.safeParse({ orgId: ID, installationId: 1 }).success).toBe(false);
  });
});

describe("GithubAccountState", () => {
  it("parses a linked and an unlinked account", () => {
    expect(GithubAccountState.safeParse({ account: { login: "octocat", linkedAt: AT }, relevant: true }).success).toBe(true);
    expect(GithubAccountState.safeParse({ account: null, relevant: false }).success).toBe(true);
  });
});

describe("GithubLinkOutcome", () => {
  it("is the closed list of the callback's returns", () => {
    expect(GithubLinkOutcome.options).toEqual(["linked", "conflict", "error"]);
  });
});
