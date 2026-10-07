import { signHs256, verifyHs256 } from "@quiz/domain";
import { describe, expect, it } from "vitest";

import {
  CODESPACE_ISSUERS,
  CodespaceAssignmentSync,
  CodespaceAssignmentSyncResult,
  GIT_TOKEN_AUDIENCE,
  GitTokenGrant,
  GitTokenRequestClaims,
  PORTAL_ISSUER,
  RELAY_HEADS_AUDIENCE,
  RelayHeadsClaims,
  LAUNCH_AUDIENCE,
  LaunchTokenClaims,
  SERVICE_AUDIENCE,
  projectSebPath,
  ProjectWorkModeBody,
  ServiceTokenClaims,
  TeacherCodespaceGrantPatch,
  workspaceStartPath,
  WorkspaceStartRefusal,
} from "./codespace.js";

/**
 * Signed by heig-classroom's own `signHs256` (apps/server's launch path),
 * `node gen.ts` against its checkout, on 2026-10-05. Not a real secret.
 * M6-01 acceptance: what classroom signs today verifies here.
 */
const FIXTURE = {
  secret: "fixture-secret-shared-with-classroom-0123456789",
  launch:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJoZWlnLWNsYXNzcm9vbSIsImF1ZCI6ImhlaWctY29kZXNwYWNlIiwiaWF0IjoxNzkwMDAwMDAwLCJleHAiOjE3OTAwMDAzMDAsImp0aSI6IjBiOWQ2ZDBlLTVjMWYtNGI3ZS05YTU3LTZmM2YxYzJkOGExMSIsInN1YiI6InUtc3R1ZGVudC0xIiwiZW1haWwiOiJhZGFAaGVpZy12ZC5jaCIsImRpc3BsYXlOYW1lIjoiQWRhIExvdmVsYWNlIiwiZ2l0aHViTG9naW4iOiJhZGEiLCJhc3NpZ25tZW50SWQiOiJhc2ctMSIsInJlcG8iOnsiZnVsbE5hbWUiOiJoZ2MtdGVzdC9sYWIxLWFkYSIsImRlZmF1bHRCcmFuY2giOiJtYWluIn19.g3WLoCAD3ORuHsNiFfWs3BKHe5KwvUtGyOqaQP-6SmU",
  service:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJoZWlnLWNsYXNzcm9vbSIsImF1ZCI6ImhlaWctY29kZXNwYWNlLWFwaSIsImlhdCI6MTc5MDAwMDAwMCwiZXhwIjoxNzkwMDAwMTIwfQ.Nyt-PLM6jbXX93tbEGsZa4-ElzUmYov6skb1WCJI1WI",
};
const NOW = () => 1790000100;

describe("tokens signed by heig-classroom", () => {
  it("a launch token verifies and parses", async () => {
    const r = await verifyHs256(FIXTURE.launch, FIXTURE.secret, {
      audience: LAUNCH_AUDIENCE,
      issuer: CODESPACE_ISSUERS,
      requireJti: true,
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const claims = LaunchTokenClaims.parse(r.claims);
    expect(claims).toMatchObject({ iss: "heig-classroom", sub: "u-student-1", assignmentId: "asg-1" });
    expect(claims.seb).toBeUndefined();
  });

  it("a service token verifies and parses", async () => {
    const r = await verifyHs256(FIXTURE.service, FIXTURE.secret, { audience: SERVICE_AUDIENCE, issuer: CODESPACE_ISSUERS, now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(ServiceTokenClaims.parse(r.claims).aud).toBe(SERVICE_AUDIENCE);
  });

  it("refuses the wrong secret, the wrong audience and an expired token", async () => {
    const o = { audience: LAUNCH_AUDIENCE, issuer: CODESPACE_ISSUERS, now: NOW };
    expect(await verifyHs256(FIXTURE.launch, `${FIXTURE.secret}x`, o)).toEqual({ ok: false, reason: "bad-signature" });
    expect(await verifyHs256(FIXTURE.launch, FIXTURE.secret, { ...o, audience: SERVICE_AUDIENCE })).toEqual({ ok: false, reason: "bad-audience" });
    expect(await verifyHs256(FIXTURE.launch, FIXTURE.secret, { ...o, issuer: "heig-quiz" })).toEqual({ ok: false, reason: "bad-issuer" });
    expect(await verifyHs256(FIXTURE.launch, FIXTURE.secret, { ...o, now: () => 1790000400 })).toEqual({ ok: false, reason: "expired" });
  });
});

describe("LaunchTokenClaims", () => {
  const claims = {
    iss: "heig-quiz",
    aud: LAUNCH_AUDIENCE,
    iat: 1,
    exp: 301,
    jti: "j",
    sub: "u1",
    email: "a@b.ch",
    displayName: "A",
    githubLogin: null,
    assignmentId: "a1",
    repo: null,
  };

  it("accepts both issuers and the optional seb claim", () => {
    expect(LaunchTokenClaims.safeParse(claims).success).toBe(true);
    expect(LaunchTokenClaims.safeParse({ ...claims, iss: "heig-classroom" }).success).toBe(true);
    expect(LaunchTokenClaims.safeParse({ ...claims, seb: { configKey: "a".repeat(64) } }).success).toBe(true);
  });

  it("refuses another issuer, audience, a missing jti, a path-unsafe subject and a bad config key", () => {
    for (const bad of [
      { iss: "evil" },
      { aud: "heig-codespace-api" },
      { jti: "" },
      { sub: "../x" },
      { seb: { configKey: "ABC" } },
    ]) {
      expect(LaunchTokenClaims.safeParse({ ...claims, ...bad }).success).toBe(false);
    }
  });
});

describe("assignment sync", () => {
  const sync = {
    id: "asg-1",
    slug: "lab1",
    name: "Lab 1",
    classroomId: "c1",
    classroomName: "Class",
    mode: "online_seb",
    image: null,
    sourceRepo: { fullName: "org/tpl", defaultBranch: "main" },
    browserExamKeys: [],
    teacher: { id: "t1", email: "t@heig-vd.ch" },
    quota: { maxActiveSessions: 2 },
    startAt: "2026-10-05T08:00:00.000Z",
    deadlineAt: null,
  };

  it("parses a sync and refuses mode free and an unsafe id", () => {
    expect(CodespaceAssignmentSync.safeParse(sync).success).toBe(true);
    expect(CodespaceAssignmentSync.safeParse({ ...sync, mode: "free" }).success).toBe(false);
    expect(CodespaceAssignmentSync.safeParse({ ...sync, id: "a/b" }).success).toBe(false);
  });

  it("parses the result: a 64-hex key or null", () => {
    expect(CodespaceAssignmentSyncResult.safeParse({ id: "a", configKey: "0".repeat(64), sebLink: "sebs://x" }).success).toBe(true);
    expect(CodespaceAssignmentSyncResult.safeParse({ id: "a", configKey: null, sebLink: null }).success).toBe(true);
    expect(CodespaceAssignmentSyncResult.safeParse({ id: "a", configKey: "zz", sebLink: null }).success).toBe(false);
  });
});

describe("signing", () => {
  it("a token signed here round-trips", async () => {
    const t = await signHs256({ iss: "heig-quiz", aud: LAUNCH_AUDIENCE, iat: 1, exp: 301, jti: "j" }, FIXTURE.secret);
    expect(await verifyHs256(t, FIXTURE.secret, { audience: LAUNCH_AUDIENCE, issuer: CODESPACE_ISSUERS, now: () => 10 })).toMatchObject({ ok: true });
  });
});

describe("Quiz's own workspace routes (M6-06)", () => {
  it("takes one of the three modes, and nothing else", () => {
    expect(ProjectWorkModeBody.safeParse({ mode: "online" }).success).toBe(true);
    expect(ProjectWorkModeBody.safeParse({ mode: "exam" }).success).toBe(false);
    expect(ProjectWorkModeBody.safeParse({ mode: "free", extra: 1 }).success).toBe(false);
  });

  it("edits a grant by either field, at least one, a quota within bounds", () => {
    expect(TeacherCodespaceGrantPatch.safeParse({ enabled: true }).success).toBe(true);
    expect(TeacherCodespaceGrantPatch.safeParse({ maxActiveSessions: 0 }).success).toBe(true);
    expect(TeacherCodespaceGrantPatch.safeParse({}).success).toBe(false);
    expect(TeacherCodespaceGrantPatch.safeParse({ maxActiveSessions: -1 }).success).toBe(false);
    expect(TeacherCodespaceGrantPatch.safeParse({ maxActiveSessions: 1.5 }).success).toBe(false);
  });

  it("names the start route and its refusals", () => {
    expect(workspaceStartPath("p/1")).toBe("/app/codespace/start/p%2F1");
    expect(WorkspaceStartRefusal.options).toEqual(["not_online", "seb_required", "not_accepted", "closed"]);
  });
});

describe("Safe Exam Browser for projects (D21, M6-07)", () => {
  it("names a project's `.seb`", () => {
    expect(projectSebPath("p/1")).toBe("/app/api/projects/p%2F1/seb");
  });
});

describe("the relay's token and declaration (ADR-078 §2)", () => {
  const base = {
    iss: PORTAL_ISSUER,
    iat: 1790000000,
    exp: 1790000060,
    jti: "j-1",
    projectId: "p-1",
    userId: "u-1",
    repository: "org/lab-kid",
  };
  const sha = "a".repeat(40);

  it("binds the request to its audience, its repository and one minute", () => {
    expect(GitTokenRequestClaims.safeParse({ ...base, aud: GIT_TOKEN_AUDIENCE }).success).toBe(true);
    expect(GitTokenRequestClaims.safeParse({ ...base, aud: RELAY_HEADS_AUDIENCE }).success).toBe(false);
    expect(GitTokenRequestClaims.safeParse({ ...base, aud: GIT_TOKEN_AUDIENCE, exp: base.iat + 61 }).success).toBe(false);
    expect(GitTokenRequestClaims.safeParse({ ...base, aud: GIT_TOKEN_AUDIENCE, jti: "" }).success).toBe(false);
    expect(GitTokenRequestClaims.safeParse({ ...base, aud: GIT_TOKEN_AUDIENCE, iss: "heig-quiz" }).success).toBe(false);
    expect(GitTokenRequestClaims.safeParse({ ...base, aud: GIT_TOKEN_AUDIENCE, repository: "lab-kid" }).success).toBe(false);
  });

  it("declares 1 to 50 heads, each a ref and a full sha", () => {
    const heads = (n: number) => Array.from({ length: n }, () => ({ ref: "refs/heads/main", sha }));
    const declared = (h: unknown) => RelayHeadsClaims.safeParse({ ...base, aud: RELAY_HEADS_AUDIENCE, heads: h }).success;
    expect(declared(heads(1))).toBe(true);
    expect(declared([{ ref: "refs/heads/main", sha: "b".repeat(64) }])).toBe(true);
    expect(declared(heads(50))).toBe(true);
    expect(declared(heads(51))).toBe(false);
    expect(declared([])).toBe(false);
    expect(declared([{ ref: "main", sha }])).toBe(false);
    expect(declared([{ ref: "refs/heads/main", sha: "a".repeat(39) }])).toBe(false);
    expect(RelayHeadsClaims.safeParse({ ...base, aud: GIT_TOKEN_AUDIENCE, heads: heads(1) }).success).toBe(false);
  });

  it("answers a grant with GitHub's expiry and the portal's hard stop", () => {
    const grant = {
      token: "ghs_x",
      expiresAt: "2026-10-07T14:03:11Z",
      useUntil: "2026-10-07T14:03:11Z",
      repository: { fullName: "org/lab-kid", githubRepoId: 1 },
      permission: "write",
    };
    expect(GitTokenGrant.safeParse(grant).success).toBe(true);
    expect(GitTokenGrant.safeParse({ ...grant, permission: "admin" }).success).toBe(false);
  });
});
