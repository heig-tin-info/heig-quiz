import { describe, expect, it } from "vitest";

import { GithubClassroom, GithubOrg } from "./github.js";

const ID = "018f0000-0000-7000-8000-000000000000";

const org: GithubOrg = {
  id: ID,
  login: "heig-tin-info",
  avatarUrl: `/app/api/github/orgs/${ID}/avatar`,
  installed: true,
  status: "active",
  plan: "team",
};

const classroom: GithubClassroom = {
  link: { org, linkedAt: "2026-09-30T08:00:00.000Z", checks: { allRepositories: true, llmSecret: "unknown" } },
  suggestedOrgId: null,
  installUrl: `https://github.com/apps/heig-quiz/installations/new?state=${ID}`,
};

describe("the github payloads never point the browser elsewhere", () => {
  it("serves an avatar only from the API's own route", () => {
    expect(GithubOrg.safeParse(org).success).toBe(true);
    expect(GithubOrg.safeParse({ ...org, avatarUrl: null }).success).toBe(true);
    for (const avatarUrl of [
      "https://avatars.githubusercontent.com/u/1?v=4",
      "//avatars.githubusercontent.com/u/1",
      "/\\avatars.githubusercontent.com/u/1",
      "/\t/avatars.githubusercontent.com/u/1",
      `/app/api/github/orgs/${ID}/avatar?x=1`,
      `/app/api/github/orgs/../${ID}/avatar`,
    ]) {
      expect(GithubOrg.safeParse({ ...org, avatarUrl }).success, avatarUrl).toBe(false);
    }
  });

  it("sends the teacher to install the App on github.com only, over https", () => {
    expect(GithubClassroom.safeParse(classroom).success).toBe(true);
    for (const installUrl of ["http://github.com/apps/x/installations/new", "https://evil.example/apps/x", "javascript:alert(1)"]) {
      expect(GithubClassroom.safeParse({ ...classroom, installUrl }).success, installUrl).toBe(false);
    }
  });
});
