import { signHs256, verifyHs256 } from "@quiz/domain";
import { describe, expect, it } from "vitest";

import {
  AdminWorkspaceImage,
  CourseWorkspaceImage,
  CourseWorkspaceImageCreate,
  CourseWorkspaceImageParams,
  CourseWorkspaceImagePatch,
  CourseWorkspaceImages,
  ImageInUse,
  ImageRefusalDetail,
  ProjectWorkspaceImageBody,
  WORKSPACE_IMAGE_NAME_MAX,
  ADMISSION_STATES,
  CODESPACE_ISSUERS,
  CodespaceAssignmentSync,
  CodespaceBaseImage,
  CodespaceEngineImage,
  CodespaceImageAdmission,
  CodespaceImageAdmissionError,
  CodespaceImageAdmissionRequest,
  CodespaceImageQuery,
  DigestReference,
  ENGINE_IMAGE_KINDS,
  IMAGE_ADMISSION_ERRORS,
  IMAGE_ADMISSIONS_PATH,
  IMAGE_REMOVE_REFUSALS,
  IMAGE_SOURCES,
  IMAGE_BASE_PATH,
  IMAGE_DETAIL_MAX,
  IMAGE_REFUSALS,
  IMAGES_PATH,
  ImageDigest,
  ImageReference,
  imageAdmissionPath,
  imagePath,
  CodespaceAssignmentSyncResult,
  CodespaceCollectionRequest,
  CodespaceCollectionResult,
  collectionsPath,
  GIT_TOKEN_AUDIENCE,
  GitTokenGrant,
  GitTokenRequestClaims,
  PORTAL_ISSUER,
  RELAY_HEADS_AUDIENCE,
  RelayHeadsClaims,
  LAUNCH_AUDIENCE,
  LaunchTokenClaims,
  SERVICE_AUDIENCE,
  SITTING_CLOSE_AUDIENCE,
  SittingCloseClaims,
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

  it("a service token verifies, but no longer parses: it binds no request (audit L25)", async () => {
    const r = await verifyHs256(FIXTURE.service, FIXTURE.secret, { audience: SERVICE_AUDIENCE, issuer: CODESPACE_ISSUERS, now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(ServiceTokenClaims.safeParse(r.claims).success).toBe(false);
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

  it("accepts a station's kiosk claim, never beside a seb claim (ADR-089 §4)", () => {
    const kiosk = { deviceId: "6f1c2a3b-0000-4000-8000-000000000001", sitting: "6f1c2a3b-0000-4000-8000-000000000002" };
    expect(LaunchTokenClaims.safeParse({ ...claims, kiosk }).success).toBe(true);
    expect(LaunchTokenClaims.safeParse({ ...claims, kiosk, seb: { configKey: "a".repeat(64) } }).success).toBe(false);
    expect(LaunchTokenClaims.safeParse({ ...claims, kiosk: { ...kiosk, sitting: "not-a-uuid" } }).success).toBe(false);
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

  it("refuses a lifetime over five minutes, or none (audit M11)", () => {
    expect(LaunchTokenClaims.safeParse({ ...claims, iat: 1, exp: 302 }).success).toBe(false);
    expect(LaunchTokenClaims.safeParse({ ...claims, iat: 1, exp: 1 }).success).toBe(false);
  });
});

describe("ServiceTokenClaims", () => {
  const claims = { iss: "heig-quiz", aud: SERVICE_AUDIENCE, iat: 1, exp: 121, jti: "j", method: "PUT", path: "/api/assignments/a1", bodyHash: "h" };

  it("comes from Quiz only, for the portal's four methods (DELETE since ADR-146)", () => {
    expect(ServiceTokenClaims.safeParse({ ...claims, iss: "heig-classroom" }).success).toBe(false);
    expect(ServiceTokenClaims.safeParse({ ...claims, iss: PORTAL_ISSUER }).success).toBe(false);
    expect(ServiceTokenClaims.safeParse({ ...claims, method: "POST" }).success).toBe(true);
    expect(ServiceTokenClaims.safeParse({ ...claims, method: "DELETE" }).success).toBe(true);
    expect(ServiceTokenClaims.safeParse({ ...claims, method: "PATCH" }).success).toBe(false);
  });

  it("is bound to one request, with a jti, for two minutes at most", () => {
    expect(ServiceTokenClaims.safeParse(claims).success).toBe(true);
    const { bodyHash: _none, ...get } = claims;
    expect(ServiceTokenClaims.safeParse({ ...get, method: "GET" }).success).toBe(true);
    for (const key of ["jti", "method", "path"]) {
      expect(ServiceTokenClaims.safeParse({ ...claims, [key]: undefined }).success).toBe(false);
    }
    expect(ServiceTokenClaims.safeParse({ ...claims, path: "api/x" }).success).toBe(false);
    expect(ServiceTokenClaims.safeParse({ ...claims, exp: 122 }).success).toBe(false);
  });
});

describe("SittingCloseClaims (ADR-089, amendment point 4)", () => {
  const SITTING = "6f1c2a3b-0000-4000-8000-000000000002";
  const PROJECT = "6f1c2a3b-0000-4000-8000-000000000003";
  const claims = { iss: "heig-quiz", aud: SITTING_CLOSE_AUDIENCE, iat: 1, exp: 121, jti: "j", sitting: SITTING, projectId: PROJECT };

  it("names a sitting, and its project while it exists", () => {
    expect(SittingCloseClaims.safeParse(claims).success).toBe(true);
    expect(SittingCloseClaims.safeParse({ ...claims, projectId: null }).success).toBe(true);
    expect(SittingCloseClaims.safeParse({ ...claims, projectId: undefined }).success).toBe(false);
    expect(SittingCloseClaims.safeParse({ ...claims, sitting: "not-a-uuid" }).success).toBe(false);
  });

  it("comes from Quiz only, on its own audience, with a jti, for two minutes at most", () => {
    expect(SittingCloseClaims.safeParse({ ...claims, iss: "heig-classroom" }).success).toBe(false);
    expect(SittingCloseClaims.safeParse({ ...claims, aud: SERVICE_AUDIENCE }).success).toBe(false);
    expect(SittingCloseClaims.safeParse({ ...claims, jti: undefined }).success).toBe(false);
    expect(SittingCloseClaims.safeParse({ ...claims, exp: 122 }).success).toBe(false);
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

  it("carries the project's update (ADR-132 §11): absent from an older platform is null; a branch, a full sha and plain text only", () => {
    expect(CodespaceAssignmentSync.parse(sync).workspaceUpdate).toBeNull();
    const sha = "a".repeat(40);
    const update = { heads: [{ branch: "main", sha }], message: { text: "README fixed.\n\tSee the test.", at: "2026-11-17T20:00:00.000Z" } };
    expect(CodespaceAssignmentSync.parse({ ...sync, mode: "online", workspaceUpdate: update }).workspaceUpdate).toEqual(update);
    expect(CodespaceAssignmentSync.safeParse({ ...sync, workspaceUpdate: { ...update, message: null } }).success).toBe(true);
    for (const bad of [
      { ...update, heads: [] },
      { ...update, heads: [{ branch: "main", sha: "abc" }] },
      { ...update, heads: [{ branch: "-x", sha }] },
      { ...update, heads: [{ branch: "a/../b", sha }] },
      { ...update, heads: [{ branch: "main:refs/heads/x", sha }] },
      { ...update, message: { text: "x".repeat(501), at: update.message.at } },
      { ...update, message: { text: "nul\u0000", at: update.message.at } },
      { ...update, message: { text: "rtl\u202e", at: update.message.at } },
      { ...update, message: { text: "lone \ud800", at: update.message.at } },
    ]) {
      expect(CodespaceAssignmentSync.safeParse({ ...sync, workspaceUpdate: bad }).success, JSON.stringify(bad)).toBe(false);
    }
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

  it("carries a device level with online_seb only, and a supervised one (ADR-089 point 2)", () => {
    for (const devices of ["seb", "either", "kiosk"]) {
      expect(ProjectWorkModeBody.safeParse({ mode: "online_seb", devices }).success).toBe(true);
    }
    for (const bad of [
      { mode: "online_seb" },
      { mode: "online_seb", devices: "any" },
      { mode: "online", devices: "seb" },
      { mode: "online", devices: "any" },
      { mode: "free", devices: "kiosk" },
    ]) {
      expect(ProjectWorkModeBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("edits a grant by either field, at least one, a quota within bounds", () => {
    expect(TeacherCodespaceGrantPatch.safeParse({ enabled: true }).success).toBe(true);
    expect(TeacherCodespaceGrantPatch.safeParse({ maxActiveSessions: 0 }).success).toBe(true);
    expect(TeacherCodespaceGrantPatch.safeParse({}).success).toBe(false);
    expect(TeacherCodespaceGrantPatch.safeParse({ maxActiveSessions: -1 }).success).toBe(false);
    expect(TeacherCodespaceGrantPatch.safeParse({ maxActiveSessions: 1.5 }).success).toBe(false);
  });

  it("names the start route and its refusals", () => {
    expect(workspaceStartPath("p/1")).toBe("/app/api/projects/p%2F1/workspace/start");
    expect(WorkspaceStartRefusal.options).toEqual(["not_online", "seb_required", "kiosk_required", "not_accepted", "closed"]);
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
    projectId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
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
    expect(GitTokenRequestClaims.safeParse({ ...base, aud: GIT_TOKEN_AUDIENCE, projectId: "p-1" }).success).toBe(false);
    expect(GitTokenRequestClaims.safeParse({ ...base, aud: GIT_TOKEN_AUDIENCE, userId: "u-1" }).success).toBe(false);
  });

  it("declares 1 to 50 heads, each a ref and a full SHA-1", () => {
    const heads = (n: number) => Array.from({ length: n }, () => ({ ref: "refs/heads/main", sha }));
    const declared = (h: unknown) => RelayHeadsClaims.safeParse({ ...base, aud: RELAY_HEADS_AUDIENCE, heads: h }).success;
    expect(declared(heads(1))).toBe(true);
    expect(declared([{ ref: "refs/heads/main", sha: "b".repeat(64) }])).toBe(false);
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

describe("the collection at the deadline (ADR-130)", () => {
  const order = {
    userId: "6f1c2a8e-1b2c-4d5e-8f90-123456789abc",
    repository: "heig-tin-info/lab3-alice",
    base: "a".repeat(40),
    target: null,
    keep: [".github/workflows", "criteria.yml"],
    ref: "refs/quiz/collect/r1-1794836400",
  };

  it("takes a well-formed order on its own path", () => {
    expect(CodespaceCollectionRequest.safeParse(order).success).toBe(true);
    expect(CodespaceCollectionRequest.safeParse({ ...order, target: "b".repeat(40) }).success).toBe(true);
    expect(collectionsPath("p1")).toBe("/api/assignments/p1/collections");
  });

  it("refuses a hostile ref, sha, path, user, repository or an extra field", () => {
    for (const bad of [
      { ref: "refs/heads/main" },
      { ref: "refs/quiz/collect/../heads/main" },
      { ref: "refs/quiz/collect/x.lock" },
      { ref: "+refs/quiz/collect/x" },
      { base: "HEAD" },
      { base: "a".repeat(64) },
      { target: "--upload-pack=x" },
      { keep: ["../etc"] },
      { keep: ["/abs"] },
      { keep: ["-x"] },
      { keep: [".git/config"] },
      { keep: ["a\\b"] },
      { userId: "../other" },
      { repository: "no-owner" },
      { repository: "owner/.." },
      { repository: "-owner/x" },
      { repository: "owner/x/y" },
      { repository: "own er/x" },
      { branch: "main" },
      { force: true },
    ]) {
      expect(CodespaceCollectionRequest.safeParse({ ...order, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("answers one of the closed outcomes", () => {
    const facts = { snapshotAt: "2026-11-16T13:40:21Z", unreadable: 0 };
    expect(CodespaceCollectionResult.safeParse({ outcome: "pushed", tree: "c".repeat(40), ...facts }).success).toBe(true);
    expect(CodespaceCollectionResult.safeParse({ outcome: "unchanged", ...facts }).success).toBe(true);
    // The portal always knows what its reader could not read; there is no stale fallback any more.
    expect(CodespaceCollectionResult.safeParse({ outcome: "unchanged", ...facts, unreadable: null }).success).toBe(false);
    expect(CodespaceCollectionResult.safeParse({ outcome: "stale_snapshot", snapshotAt: facts.snapshotAt }).success).toBe(false);
    expect(CodespaceCollectionResult.safeParse({ outcome: "failed", reason: "timeout" }).success).toBe(true);
    expect(CodespaceCollectionResult.safeParse({ outcome: "failed", reason: "read_failed" }).success).toBe(true);
    expect(CodespaceCollectionResult.safeParse({ outcome: "no_snapshot" }).success).toBe(true);
    expect(CodespaceCollectionResult.safeParse({ outcome: "failed", reason: "push_rejected" }).success).toBe(true);
    expect(CodespaceCollectionResult.safeParse({ outcome: "failed", reason: "anything" }).success).toBe(false);
    expect(CodespaceCollectionResult.safeParse({ outcome: "collected" }).success).toBe(false);
  });
});

describe("workspace images (ADR-146)", () => {
  const digest = `sha256:${"a".repeat(64)}`;

  it("a sync's image is a digest reference or null, normalized", () => {
    const base = {
      id: "asg-1",
      slug: "lab1",
      name: "Lab 1",
      classroomId: "c1",
      classroomName: "Class",
      mode: "online",
      sourceRepo: { fullName: "org/tpl", defaultBranch: "main" },
      browserExamKeys: [],
      teacher: { id: "t1", email: "t@heig-vd.ch" },
      quota: { maxActiveSessions: 2 },
      startAt: "2026-10-05T08:00:00.000Z",
      deadlineAt: null,
    };
    expect(CodespaceAssignmentSync.parse({ ...base, image: null }).image).toBeNull();
    expect(CodespaceAssignmentSync.parse({ ...base, image: `ghcr.io/org/lab:1@${digest}` }).image).toBe(`ghcr.io/org/lab@${digest}`);
    expect(CodespaceAssignmentSync.parse({ ...base, image: `org/lab@${digest}` }).image).toBe(`docker.io/org/lab@${digest}`);
    for (const bad of ["ghcr.io/org/lab:1", "codespace/c-dev:4.137.0", `quay.io/org/lab@${digest}`, ""]) {
      expect(CodespaceAssignmentSync.safeParse({ ...base, image: bad }).success, bad).toBe(false);
    }
  });

  it("an admission request takes a tag or a digest, canonical, and nothing else", () => {
    expect(CodespaceImageAdmissionRequest.parse({ reference: "debian" })).toEqual({ reference: "docker.io/library/debian:latest" });
    expect(CodespaceImageAdmissionRequest.parse({ reference: `ghcr.io/o/i@${digest}` }).reference).toBe(`ghcr.io/o/i@${digest}`);
    expect(ImageReference.safeParse("ghcr.io/O/i").success).toBe(false);
    expect(CodespaceImageAdmissionRequest.safeParse({ reference: "ghcr.io/o/i", extra: 1 }).success).toBe(false);
    expect(DigestReference.safeParse("ghcr.io/o/i:1").success).toBe(false);
    expect(ImageDigest.safeParse(digest).success).toBe(true);
  });

  it("an admission, the base, an engine image and the errors", () => {
    const admission = {
      reference: `ghcr.io/o/i@${digest}`,
      digest,
      state: "refused",
      reason: "not_on_base",
      detail: "x",
      baseVersion: null,
      compressedBytes: 10,
      diskBytes: null,
      updatedAt: "2026-11-25T08:00:00.000Z",
    };
    expect(CodespaceImageAdmission.safeParse(admission).success).toBe(true);
    expect(CodespaceImageAdmission.safeParse({ ...admission, reason: "other" }).success).toBe(false);
    expect(CodespaceImageAdmission.safeParse({ ...admission, detail: "x".repeat(IMAGE_DETAIL_MAX + 1) }).success).toBe(false);
    expect(ADMISSION_STATES).toContain("ready");
    expect(IMAGE_REFUSALS).toContain("interrupted");
    expect(CodespaceBaseImage.safeParse({ reference: `ghcr.io/o/b@${digest}`, digest, version: "1.0.0" }).success).toBe(true);
    const admitted = { reference: "codespace/c-dev:4.137.0", digest: "sha256:1", source: "default", state: "ready", lastUsedAt: null, liveSessions: 0 };
    expect(CodespaceEngineImage.safeParse({ id: "sha256:1", names: ["localhost/codespace/c-dev:4.137.0"], diskBytes: 1, kind: "default", admissions: [admitted] }).success).toBe(true);
    expect(CodespaceEngineImage.safeParse({ id: null, names: [], diskBytes: null, kind: "admitted", admissions: [{ ...admitted, source: "other" }] }).success).toBe(false);
    expect(IMAGE_SOURCES).toEqual(["default", "course"]);
    expect(IMAGE_REMOVE_REFUSALS).toContain("image_in_use");
    expect(ENGINE_IMAGE_KINDS).toContain("orphan");
    expect(CodespaceImageAdmissionError.safeParse({ error: "registry_unavailable" }).success).toBe(true);
    // Only what a 422 or a 503 carries.
    expect(CodespaceImageAdmissionError.safeParse({ error: "too_large" }).success).toBe(false);
    expect(IMAGE_ADMISSION_ERRORS).toEqual(["not_found", "not_public", "config", "registry_unavailable"]);
    expect(IMAGE_BASE_PATH).toBe("/api/images/base");
  });

  it("addresses an admission by its reference, in the query, URL-encoded", () => {
    const reference = `ghcr.io/o/i@${digest}`;
    expect(imageAdmissionPath(reference)).toBe(`${IMAGE_ADMISSIONS_PATH}?reference=ghcr.io%2Fo%2Fi%40sha256%3A${"a".repeat(64)}`);
    expect(imagePath(reference)).toBe(`${IMAGES_PATH}?reference=ghcr.io%2Fo%2Fi%40sha256%3A${"a".repeat(64)}`);
    expect(CodespaceImageQuery.parse({ reference: `o/i@${digest}` })).toEqual({ reference: `docker.io/o/i@${digest}` });
    expect(CodespaceImageQuery.safeParse({ reference: "ghcr.io/o/i:1" }).success).toBe(false);
    expect(CodespaceImageQuery.safeParse({ reference, x: 1 }).success).toBe(false);
  });

  it("a service token may bind a DELETE", () => {
    const claims = { iss: "heig-quiz", aud: SERVICE_AUDIENCE, iat: 1, exp: 100, jti: "j", method: "DELETE", path: imagePath(digest) };
    expect(ServiceTokenClaims.safeParse(claims).success).toBe(true);
    expect(ServiceTokenClaims.safeParse({ ...claims, method: "PATCH" }).success).toBe(false);
  });
});

describe("a course's workspace images (ADR-146 §4–§8, Quiz's routes)", () => {
  const digest = `sha256:${"a".repeat(64)}`;

  it("adds by a name and a canonical reference, renames by a name only", () => {
    expect(CourseWorkspaceImageCreate.parse({ name: "  C lab ", reference: "ghcr.io/acme/lab" })).toEqual({
      name: "C lab",
      reference: "ghcr.io/acme/lab:latest",
    });
    for (const bad of [
      { name: "", reference: "ghcr.io/acme/lab" },
      { name: "x".repeat(WORKSPACE_IMAGE_NAME_MAX + 1), reference: "ghcr.io/acme/lab" },
      { name: "two\nlines", reference: "ghcr.io/acme/lab" },
      { name: "C", reference: "quay.io/acme/lab" },
      { name: "C", reference: "ghcr.io/acme/lab", extra: 1 },
    ]) {
      expect(CourseWorkspaceImageCreate.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(CourseWorkspaceImagePatch.safeParse({ name: "Python", reference: "ghcr.io/acme/py" }).success).toBe(false);
    expect(ProjectWorkspaceImageBody.parse({ imageId: null })).toEqual({ imageId: null });
    expect(ProjectWorkspaceImageBody.safeParse({ imageId: "c lab" }).success).toBe(false);
    expect(CourseWorkspaceImageParams.safeParse({ id: crypto.randomUUID(), imageId: "x" }).success).toBe(false);
  });

  it("lists a course's images, and the administrator's view of the store", () => {
    const image = {
      id: crypto.randomUUID(),
      name: "C lab",
      reference: "ghcr.io/acme/lab:latest",
      digestReference: `ghcr.io/acme/lab@${digest}`,
      state: "ready",
      reason: null,
      detail: null,
      baseVersion: "1.0.0",
      diskBytes: 10,
      obsolete: true,
      projects: [{ id: crypto.randomUUID(), name: "Lab 1" }],
      createdAt: "2026-11-25T08:00:00.000Z",
      updatedAt: "2026-11-25T08:00:00.000Z",
    };
    expect(CourseWorkspaceImages.safeParse({ images: [image], base: { reference: "r", version: null }, canManage: true, max: 5 }).success).toBe(true);
    expect(CourseWorkspaceImage.safeParse({ ...image, state: "gone" }).success).toBe(false);
    const admission = { reference: image.digestReference, digest, source: "course", state: "ready", lastUsedAt: null, liveSessions: 1 };
    const uses = [{ course: { id: crypto.randomUUID(), name: "Prog", code: "PRG" }, image: { id: image.id, name: image.name }, projects: [] }];
    const stored = { id: "x", names: [], diskBytes: 1, kind: "admitted", admissions: [{ ...admission, uses }] };
    expect(AdminWorkspaceImage.safeParse(stored).success).toBe(true);
    expect(AdminWorkspaceImage.safeParse({ ...stored, admissions: [admission] }).success).toBe(false);
  });

  it("describes the bodies of image_in_use and of a refusal the portal words", () => {
    const projects = [{ id: crypto.randomUUID(), name: "Lab 1" }];
    expect(ImageInUse.parse({ error: "image_in_use", projects })).toEqual({ projects });
    expect(ImageInUse.safeParse({ error: "image_in_use" }).success).toBe(false);
    expect(ImageRefusalDetail.parse({ error: "not_public", detail: "401" })).toEqual({ detail: "401" });
    expect(ImageRefusalDetail.parse({ error: "not_public", detail: null })).toEqual({ detail: null });
    expect(ImageRefusalDetail.safeParse({ error: "not_public", detail: "x".repeat(501) }).success).toBe(false);
  });
});
