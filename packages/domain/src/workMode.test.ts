import { describe, expect, it } from "vitest";

import {
  collaboratorPermission,
  gitTokenRefusal,
  isOnlineMode,
  quotaHolder,
  relayClosesAt,
  workModeRefusal,
  workspaceStartRefusal,
  type GitTokenFacts,
  type WorkModeFacts,
  type WorkspaceStartFacts,
} from "./workMode.js";

const OWNER: WorkModeFacts = { owner: true, granted: true, launched: false, groupMode: false };

describe("collaboratorPermission (ADR-047 §2)", () => {
  it("pushes in the student's own tools, pulls online, invites nobody under SEB", () => {
    expect(collaboratorPermission("free")).toBe("push");
    expect(collaboratorPermission("online")).toBe("pull");
    expect(collaboratorPermission("online_seb")).toBeNull();
    expect([isOnlineMode("free"), isOnlineMode("online"), isOnlineMode("online_seb")]).toEqual([false, true, true]);
  });
});

describe("workModeRefusal", () => {
  it("lets an owner with the grant choose any mode", () => {
    expect(workModeRefusal(OWNER, "free", "online")).toBeNull();
    expect(workModeRefusal(OWNER, "online", "online_seb")).toBeNull();
    expect(workModeRefusal(OWNER, "online", "free")).toBeNull();
  });

  it("refuses an assistant, whatever the mode", () => {
    expect(workModeRefusal({ ...OWNER, owner: false }, "free", "online")).toBe("owner_required");
    expect(workModeRefusal({ ...OWNER, owner: false }, "online", "free")).toBe("owner_required");
  });

  it("needs the grant to go online, not to come back to free", () => {
    const ungranted = { ...OWNER, granted: false };
    expect(workModeRefusal(ungranted, "free", "online")).toBe("codespace_not_granted");
    expect(workModeRefusal(ungranted, "free", "online_seb")).toBe("codespace_not_granted");
    expect(workModeRefusal(ungranted, "online", "free")).toBeNull();
  });

  it("freezes the mode once a workspace was launched", () => {
    const launched = { ...OWNER, launched: true };
    expect(workModeRefusal(launched, "online", "free")).toBe("work_mode_frozen");
    expect(workModeRefusal(launched, "online", "online_seb")).toBe("work_mode_frozen");
  });

  it("keeps a group project in the students' own tools", () => {
    expect(workModeRefusal({ ...OWNER, groupMode: true }, "free", "online")).toBe("work_mode_group");
  });

  it("never refuses the mode the project already has", () => {
    expect(workModeRefusal({ owner: false, granted: false, launched: true, groupMode: true }, "online", "online")).toBeNull();
  });
});

describe("quotaHolder (decision C)", () => {
  const seat = (userId: string, iso: string) => ({ userId, createdAt: new Date(iso) });

  it("is the creator while they hold an owner seat", () => {
    expect(quotaHolder("c", [seat("a", "2026-01-01T00:00:00Z"), seat("c", "2026-05-01T00:00:00Z")])).toBe("c");
  });

  it("falls to the oldest owner seat, ties by user id", () => {
    expect(quotaHolder("gone", [seat("b", "2026-03-01T00:00:00Z"), seat("a", "2026-04-01T00:00:00Z")])).toBe("b");
    expect(quotaHolder("gone", [seat("z", "2026-03-01T00:00:00Z"), seat("y", "2026-03-01T00:00:00Z")])).toBe("y");
  });

  it("is nobody on a course without an owner", () => {
    expect(quotaHolder("c", [])).toBeNull();
  });
});

describe("workspaceStartRefusal (ADR-047 §6)", () => {
  const NOW = new Date("2026-10-07T08:00:00Z");
  const DEADLINE = new Date("2026-10-14T22:00:00Z");
  const repo = { groupId: null, provisionStatus: "ok", fullName: "org/lab-kid", deletedAt: null, deadlineAt: null };
  const facts = (over: Partial<WorkspaceStartFacts> = {}): WorkspaceStartFacts => ({
    project: { workMode: "online", deadlineAt: DEADLINE },
    repo,
    classroomArchived: false,
    fromSeb: false,
    ...over,
  });
  const exam = { workMode: "online_seb", deadlineAt: DEADLINE } as const;

  it("opens an online project's workspace on the student's live repository", () => {
    expect(workspaceStartRefusal(facts(), NOW)).toBeNull();
  });

  it("opens a Safe Exam Browser project's from its seb session only (D21)", () => {
    expect(workspaceStartRefusal(facts({ project: exam, fromSeb: true }), NOW)).toBeNull();
    expect(workspaceStartRefusal(facts({ project: exam }), NOW)).toBe("seb_required");
    // The session's activity is still checked: no repository, no workspace.
    expect(workspaceStartRefusal(facts({ project: exam, fromSeb: true, repo: null }), NOW)).toBe("not_accepted");
  });

  it("refuses, in order: not online, SEB only, not accepted, closed", () => {
    expect(workspaceStartRefusal(facts({ project: { workMode: "free", deadlineAt: DEADLINE }, repo: null, fromSeb: true }), NOW)).toBe("not_online");
    expect(workspaceStartRefusal(facts({ project: exam, repo: null }), NOW)).toBe("seb_required");
    expect(workspaceStartRefusal(facts({ repo: null }), NOW)).toBe("not_accepted");
    expect(workspaceStartRefusal(facts({ repo: { ...repo, provisionStatus: "pending" } }), NOW)).toBe("not_accepted");
    expect(workspaceStartRefusal(facts({ repo: { ...repo, deletedAt: NOW } }), NOW)).toBe("not_accepted");
    expect(workspaceStartRefusal(facts({ classroomArchived: true }), NOW)).toBe("closed");
    expect(workspaceStartRefusal(facts(), DEADLINE)).toBe("closed");
  });

  it("reads the student's own deadline, an extension included", () => {
    const later = new Date("2026-10-21T22:00:00Z");
    expect(workspaceStartRefusal(facts({ repo: { ...repo, deadlineAt: later } }), DEADLINE)).toBeNull();
  });
});

describe("gitTokenRefusal (ADR-078 §2)", () => {
  const DEADLINE = new Date("2026-10-14T22:00:00Z");
  const GRACE_END = new Date("2026-10-14T22:30:00Z");
  const NOW = new Date("2026-10-07T08:00:00Z");
  const repo = {
    groupId: null,
    provisionStatus: "ok",
    fullName: "org/lab-kid",
    deletedAt: null,
    deadlineAt: null,
    staffLock: null,
    githubRepoId: 101,
  };
  const facts = (over: Partial<GitTokenFacts> = {}): GitTokenFacts => ({
    project: { workMode: "online", deadlineAt: DEADLINE, graceMinutes: 30, distributionRepoId: 202, distributionFullName: "org/lab-squashed" },
    launched: true,
    repo,
    classroomArchived: false,
    repository: "org/lab-kid",
    ...over,
  });
  const exam = (over: Partial<GitTokenFacts> = {}) => facts({ project: { ...facts().project, workMode: "online_seb" }, ...over });

  it("grants write on the user's own repository until the effective deadline plus the grace", () => {
    expect(gitTokenRefusal(facts(), NOW)).toEqual({ permission: "write", githubRepoId: 101, useUntil: GRACE_END });
    // GitHub's names are case-insensitive.
    expect(gitTokenRefusal(facts({ repository: "Org/Lab-Kid" }), NOW)).toMatchObject({ permission: "write" });
    expect(relayClosesAt({ deadlineAt: null }, { deadlineAt: DEADLINE, graceMinutes: 30 })).toEqual(GRACE_END);
  });

  it("grants read on the distribution repository of an online_seb project only", () => {
    const seed = { repository: "org/lab-squashed" };
    expect(gitTokenRefusal(exam(seed), NOW)).toEqual({ permission: "read", githubRepoId: 202, useUntil: null });
    expect(gitTokenRefusal(facts(seed), NOW)).toBe("not_found");
  });

  it("refuses without a launch, another repository, or no live repository of the user's", () => {
    expect(gitTokenRefusal(facts({ launched: false }), NOW)).toBe("not_found");
    expect(gitTokenRefusal(facts({ repository: "org/lab-other" }), NOW)).toBe("not_found");
    expect(gitTokenRefusal(facts({ repo: null }), NOW)).toBe("not_found");
    expect(gitTokenRefusal(facts({ repo: { ...repo, deletedAt: NOW } }), NOW)).toBe("not_found");
    expect(gitTokenRefusal(facts({ repo: { ...repo, githubRepoId: null } }), NOW)).toBe("not_found");
  });

  it("refuses a project back in the students' own tools", () => {
    expect(gitTokenRefusal(facts({ project: { ...facts().project, workMode: "free" } }), NOW)).toBe("not_online");
  });

  it("stays open through the grace, closes at its end, on archive and on a staff lock", () => {
    expect(gitTokenRefusal(facts(), new Date(DEADLINE.getTime() + 60_000))).toMatchObject({ permission: "write" });
    expect(gitTokenRefusal(facts(), GRACE_END)).toBe("closed");
    expect(gitTokenRefusal(exam({ repository: "org/lab-squashed" }), GRACE_END)).toBe("closed");
    expect(gitTokenRefusal(facts({ classroomArchived: true }), NOW)).toBe("closed");
    expect(gitTokenRefusal(facts({ repo: { ...repo, staffLock: true } }), NOW)).toBe("closed");
    // A staff unlock reopens nothing past the deadline; an extension does.
    expect(gitTokenRefusal(facts({ repo: { ...repo, staffLock: false } }), GRACE_END)).toBe("closed");
    const later = new Date("2026-10-21T22:00:00Z");
    expect(gitTokenRefusal(facts({ repo: { ...repo, deadlineAt: later } }), GRACE_END)).toEqual({
      permission: "write",
      githubRepoId: 101,
      useUntil: new Date("2026-10-21T22:30:00Z"),
    });
  });
});
