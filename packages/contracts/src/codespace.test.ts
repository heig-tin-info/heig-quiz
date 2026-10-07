import { signHs256, verifyHs256 } from "@quiz/domain";
import { describe, expect, it } from "vitest";

import {
  CODESPACE_ISSUERS,
  CodespaceAssignmentSync,
  CodespaceAssignmentSyncResult,
  LAUNCH_AUDIENCE,
  LaunchTokenClaims,
  MAX_BROWSER_EXAM_KEYS,
  SERVICE_AUDIENCE,
  ProjectBrowserExamKeysBody,
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
  const key = "AbCd".repeat(16);

  it("names a project's `.seb`", () => {
    expect(projectSebPath("p/1")).toBe("/app/api/projects/p%2F1/seb");
  });

  it("takes the Browser Exam Keys as SHA-256 hex, lower-cased, duplicates dropped", () => {
    const parsed = ProjectBrowserExamKeysBody.parse({ keys: [` ${key} `, key.toLowerCase()] });
    expect(parsed.keys).toEqual([key.toLowerCase()]);
    expect(ProjectBrowserExamKeysBody.parse({ keys: [] }).keys).toEqual([]);
  });

  it("refuses a key that is not one, too many keys, and any other field", () => {
    expect(ProjectBrowserExamKeysBody.safeParse({ keys: ["bek-windows"] }).success).toBe(false);
    expect(ProjectBrowserExamKeysBody.safeParse({ keys: [key.slice(1)] }).success).toBe(false);
    const many = Array.from({ length: MAX_BROWSER_EXAM_KEYS + 1 }, (_, i) => i.toString(16).padStart(64, "0"));
    expect(ProjectBrowserExamKeysBody.safeParse({ keys: many }).success).toBe(false);
    expect(ProjectBrowserExamKeysBody.safeParse({ keys: [], mode: "online" }).success).toBe(false);
  });
});
