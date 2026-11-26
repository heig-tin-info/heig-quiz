import { describe, expect, it } from "vitest";

import {
  collaboratorPermission,
  gitTokenRefusal,
  isOnlineMode,
  isLabMode,
  kioskProjectPairable,
  portalMode,
  quotaHolder,
  portalDeadline,
  hasTwoWritePaths,
  WORK_PLACES,
  distributionReviewRefusal,
  staffReviewRefusal,
  workModeChoices,
  workModeRefusal,
  workPlaceOf,
  workSettingFor,
  workSettingOf,
  workspaceClosed,
  workspaceStartRefusal,
  type DistributionReviewFacts,
  type GitTokenFacts,
  type StaffReviewFacts,
  type WorkModeFacts,
  type WorkSetting,
  type WorkspaceStartFacts,
  widensAfterLaunch,
  widensInvitations,
} from "./workMode.js";
import { DEVICE_LEVEL_IDS } from "./deviceLevels.js";

const OWNER: WorkModeFacts = { owner: true, granted: true, launched: false, groupMode: false, kioskOffered: true };

describe("collaboratorPermission (ADR-047 §2)", () => {
  it("pushes in the student's own tools and at their choice, pulls online, invites nobody under SEB", () => {
    expect(collaboratorPermission("free")).toBe("push");
    expect(collaboratorPermission("hybrid")).toBe("push");
    expect(collaboratorPermission("online")).toBe("pull");
    expect(collaboratorPermission("online_seb")).toBeNull();
    expect([isOnlineMode("free"), isOnlineMode("hybrid"), isOnlineMode("online"), isOnlineMode("online_seb")]).toEqual([false, true, true, true]);
  });
});

describe("what the portal is told and offers (ADR-149 §3, §4)", () => {
  it("tells the portal a hybrid project is online: its lab mode", () => {
    expect(portalMode("hybrid")).toBe("online");
    expect(portalMode("online")).toBe("online");
    expect(portalMode("online_seb")).toBe("online_seb");
  });

  it("has one lab mode predicate, online and hybrid, and weighs the last writer in hybrid only", () => {
    const modes = ["free", "hybrid", "online", "online_seb"] as const;
    expect(modes.map(isLabMode)).toEqual([false, true, true, false]);
    expect(modes.map(hasTwoWritePaths)).toEqual([false, true, false, false]);
  });
});

/** A stored setting: a mode, and its level (`any` unless given). */
const S = (mode: WorkSetting["mode"], devices: WorkSetting["devices"] = "any"): WorkSetting => ({ mode, devices });
const FREE = S("free");
const HYBRID = S("hybrid");
const ONLINE = S("online");
const SEB = S("online_seb", "seb");
const EITHER = S("online_seb", "either");
const KIOSK = S("online_seb", "kiosk");

describe("workModeRefusal", () => {
  it("lets an owner with the grant choose any mode", () => {
    expect(workModeRefusal(OWNER, FREE, ONLINE)).toBeNull();
    expect(workModeRefusal(OWNER, FREE, HYBRID)).toBeNull();
    expect(workModeRefusal(OWNER, ONLINE, HYBRID)).toBeNull();
    expect(workModeRefusal(OWNER, HYBRID, FREE)).toBeNull();
    expect(workModeRefusal(OWNER, ONLINE, SEB)).toBeNull();
    expect(workModeRefusal(OWNER, ONLINE, FREE)).toBeNull();
  });

  it("refuses an assistant, whatever the mode", () => {
    expect(workModeRefusal({ ...OWNER, owner: false }, FREE, ONLINE)).toBe("owner_required");
    expect(workModeRefusal({ ...OWNER, owner: false }, ONLINE, FREE)).toBe("owner_required");
    expect(workModeRefusal({ ...OWNER, owner: false }, SEB, EITHER)).toBe("owner_required");
  });

  it("needs the grant to go online, not to come back to free", () => {
    const ungranted = { ...OWNER, granted: false };
    expect(workModeRefusal(ungranted, FREE, ONLINE)).toBe("codespace_not_granted");
    expect(workModeRefusal(ungranted, FREE, SEB)).toBe("codespace_not_granted");
    expect(workModeRefusal(ungranted, FREE, HYBRID)).toBe("codespace_not_granted");
    expect(workModeRefusal(ungranted, HYBRID, FREE)).toBeNull();
    expect(workModeRefusal(ungranted, ONLINE, FREE)).toBeNull();
  });

  it("freezes the pair once a workspace was launched: the mode and the level alike (ADR-089)", () => {
    const launched = { ...OWNER, launched: true };
    expect(workModeRefusal(launched, ONLINE, FREE)).toBe("work_mode_frozen");
    expect(workModeRefusal(launched, ONLINE, SEB)).toBe("work_mode_frozen");
    expect(workModeRefusal(launched, SEB, EITHER)).toBe("work_mode_frozen");
    expect(workModeRefusal(launched, KIOSK, SEB)).toBe("work_mode_frozen");
    // Hybrid freezes like online (ADR-149 §5): nothing narrows it after a launch.
    expect(workModeRefusal(launched, HYBRID, FREE)).toBe("work_mode_frozen");
    expect(workModeRefusal(launched, HYBRID, ONLINE)).toBe("work_mode_frozen");
    expect(workModeRefusal(launched, SEB, HYBRID)).toBe("work_mode_frozen");
  });

  it("leaves one change open after a launch, online to hybrid: it only widens (ADR-149 §7)", () => {
    const launched = { ...OWNER, launched: true };
    expect(workModeRefusal(launched, ONLINE, HYBRID)).toBeNull();
    // Still an owner's, with the grant.
    expect(workModeRefusal({ ...launched, owner: false }, ONLINE, HYBRID)).toBe("owner_required");
    expect(workModeRefusal({ ...launched, granted: false }, ONLINE, HYBRID)).toBe("codespace_not_granted");
    expect(widensAfterLaunch("online", "hybrid")).toBe(true);
    for (const [from, to] of [["hybrid", "online"], ["online", "free"], ["free", "hybrid"], ["online_seb", "hybrid"]] as const) expect(widensAfterLaunch(from, to)).toBe(false);
  });

  it("widens the invitations already sent when the new mode invites with push and the old with less (ADR-149 §7)", () => {
    expect(widensInvitations("online", "hybrid")).toBe(true);
    expect(widensInvitations("online", "free")).toBe(true);
    expect(widensInvitations("online_seb", "hybrid")).toBe(true);
    expect(widensInvitations("free", "hybrid")).toBe(false);
    expect(widensInvitations("hybrid", "online")).toBe(false);
    expect(widensInvitations("free", "online")).toBe(false);
  });

  it("keeps a group project in the students' own tools", () => {
    expect(workModeRefusal({ ...OWNER, groupMode: true }, FREE, ONLINE)).toBe("work_mode_group");
    expect(workModeRefusal({ ...OWNER, groupMode: true }, FREE, HYBRID)).toBe("work_mode_group");
  });

  it("never refuses the pair the project already has, a station level with the flag off included", () => {
    const nobody = { owner: false, granted: false, launched: true, groupMode: true, kioskOffered: false };
    for (const setting of [FREE, HYBRID, ONLINE, SEB, EITHER, KIOSK]) expect(workModeRefusal(nobody, setting, { ...setting })).toBeNull();
  });

  it("refuses a change TO a station level while kiosk stations are not offered; leaving one passes (ADR-089 point 1)", () => {
    const off = { ...OWNER, kioskOffered: false };
    for (const [from, to] of [[ONLINE, EITHER], [SEB, KIOSK], [EITHER, KIOSK], [KIOSK, EITHER]] as const) {
      expect(workModeRefusal(off, from, to)).toBe("kiosk_unavailable");
      expect(workModeRefusal(OWNER, from, to)).toBeNull();
    }
    for (const [from, to] of [[KIOSK, SEB], [EITHER, ONLINE], [KIOSK, FREE], [ONLINE, SEB]] as const) {
      expect(workModeRefusal(off, from, to)).toBeNull();
    }
    // The order of the record: the freeze before the flag.
    expect(workModeRefusal({ ...off, launched: true }, SEB, KIOSK)).toBe("work_mode_frozen");
  });
});

describe("workModeChoices", () => {
  it("judges each mode as it would be written: online_seb keeps the level in force, else SEB", () => {
    expect(workModeChoices(OWNER, FREE)).toEqual({ allowed: ["free", "hybrid", "online", "online_seb"], refusal: null });
    // A Kiosk only project with the flag off: its own pair passes, SEB from it passes too.
    expect(workModeChoices({ ...OWNER, kioskOffered: false }, KIOSK)).toEqual({ allowed: ["free", "hybrid", "online", "online_seb"], refusal: null });
    expect(workModeChoices({ ...OWNER, launched: true }, HYBRID)).toEqual({ allowed: ["hybrid"], refusal: "work_mode_frozen" });
    // A launched online project may still go to Either, and nowhere else (ADR-149 §7).
    expect(workModeChoices({ ...OWNER, launched: true }, ONLINE)).toEqual({ allowed: ["hybrid", "online"], refusal: "work_mode_frozen" });
    expect(workModeChoices({ ...OWNER, launched: true }, EITHER)).toEqual({ allowed: ["online_seb"], refusal: "work_mode_frozen" });
  });
});

describe("the mapping between the setting and the screen (ADR-089 point 2)", () => {
  it("is own tools, the students' choice, or a level in the workspace: any is online, the others online_seb", () => {
    expect(workSettingFor("own", "kiosk")).toEqual({ mode: "free" });
    expect(workSettingFor("hybrid", "seb")).toEqual({ mode: "hybrid" });
    expect(workSettingFor("online", "any")).toEqual({ mode: "online" });
    for (const level of ["seb", "either", "kiosk"] as const) {
      expect(workSettingFor("online", level)).toEqual({ mode: "online_seb", devices: level });
    }
  });

  it("reads back every choice of the screen as the stored setting: the level is the stored devices", () => {
    for (const level of DEVICE_LEVEL_IDS) expect(workSettingOf(workSettingFor("online", level))).toEqual(level === "any" ? ONLINE : S("online_seb", level));
    for (const level of DEVICE_LEVEL_IDS) expect(workSettingOf(workSettingFor("own", level))).toEqual(FREE);
    for (const level of DEVICE_LEVEL_IDS) expect(workSettingOf(workSettingFor("hybrid", level))).toEqual(HYBRID);
  });

  it("shows each mode at its place, three places for four modes", () => {
    expect(WORK_PLACES).toEqual(["own", "hybrid", "online"]);
    expect(["free", "hybrid", "online", "online_seb"].map((m) => workPlaceOf(m as WorkSetting["mode"]))).toEqual(["own", "hybrid", "online", "online"]);
  });
});

describe("kioskProjectPairable (ADR-089 §5)", () => {
  const NOW = new Date("2026-10-07T08:00:00Z");
  const deadlineAt = new Date("2026-10-14T22:00:00Z");
  it("is a station level, before the student's effective deadline", () => {
    expect(kioskProjectPairable({ ...EITHER, deadlineAt }, null, NOW)).toBe(true);
    expect(kioskProjectPairable({ ...KIOSK, deadlineAt }, { deadlineAt: null }, NOW)).toBe(true);
    for (const setting of [FREE, ONLINE, SEB]) expect(kioskProjectPairable({ ...setting, deadlineAt }, null, NOW)).toBe(false);
    expect(kioskProjectPairable({ ...KIOSK, deadlineAt }, null, deadlineAt)).toBe(false);
    // An extension of the student's own repository moves it (ADR-078 §2).
    expect(kioskProjectPairable({ ...KIOSK, deadlineAt }, { deadlineAt: new Date("2026-10-21T22:00:00Z") }, deadlineAt)).toBe(true);
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
  const repo = { groupId: null, provisionStatus: "ok", fullName: "org/lab-kid", deletedAt: null, deadlineAt: null, staffLock: null, deadlineAppliedAt: null, lockedAt: null };
  const base = { deadlineAt: DEADLINE, deadlineStrategy: "lock", archivedAt: null, devices: "any" } as const;
  const facts = (over: Partial<WorkspaceStartFacts> = {}): WorkspaceStartFacts => ({
    project: { ...base, workMode: "online" },
    repo,
    classroomArchived: false,
    via: null,
    ...over,
  });
  const exam = { ...base, workMode: "online_seb", devices: "seb" } as const;

  it("opens an online project's workspace on the student's live repository", () => {
    expect(workspaceStartRefusal(facts(), NOW)).toBeNull();
  });

  it("opens a Safe Exam Browser project's from its seb session only (D21)", () => {
    expect(workspaceStartRefusal(facts({ project: exam, via: "seb" }), NOW)).toBeNull();
    expect(workspaceStartRefusal(facts({ project: exam }), NOW)).toBe("seb_required");
    expect(workspaceStartRefusal(facts({ project: exam, via: "kiosk" }), NOW)).toBe("seb_required");
    // The session's activity is still checked: no repository, no workspace.
    expect(workspaceStartRefusal(facts({ project: exam, via: "seb", repo: null }), NOW)).toBe("not_accepted");
  });

  it("opens a supervised project from the clients its level accepts only (ADR-089 point 2)", () => {
    const at = (devices: "seb" | "either" | "kiosk") => ({ ...exam, devices });
    const verdicts = (["seb", "either", "kiosk"] as const).map((level) =>
      ([null, "seb", "kiosk"] as const).map((via) => workspaceStartRefusal(facts({ project: at(level), via }), NOW)),
    );
    expect(verdicts).toEqual([
      ["seb_required", null, "seb_required"],
      ["seb_required", null, null],
      ["kiosk_required", "kiosk_required", null],
    ]);
  });

  it("refuses, in order: not online, SEB only, not accepted, closed", () => {
    expect(workspaceStartRefusal(facts({ project: { ...base, workMode: "free" }, repo: null, via: "seb" }), NOW)).toBe("not_online");
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

  it("under commit, an online project's workspace opens past the deadline while the repository is writable (#958)", () => {
    const LATE = new Date(DEADLINE.getTime() + 86_400_000);
    const commit = { ...base, workMode: "online", deadlineStrategy: "commit" } as const;
    const applied = { ...repo, deadlineAppliedAt: DEADLINE };
    expect(workspaceStartRefusal(facts({ project: commit, repo: applied }), LATE)).toBeNull();
    expect(workspaceStartRefusal(facts({ project: commit, repo: { ...applied, staffLock: true } }), LATE)).toBe("closed");
    expect(workspaceStartRefusal(facts({ project: commit, repo: applied, classroomArchived: true }), LATE)).toBe("closed");
    // Under Safe Exam Browser, and under lock, the deadline still closes it.
    expect(workspaceStartRefusal(facts({ project: { ...commit, workMode: "online_seb", devices: "seb" }, repo: applied, via: "seb" }), LATE)).toBe("closed");
    expect(workspaceStartRefusal(facts({ repo: applied }), LATE)).toBe("closed");
  });

  it("opens a hybrid project's workspace, past the deadline under commit while the repository is writable (ADR-149 §2)", () => {
    const hybrid = { ...base, workMode: "hybrid" } as const;
    expect(workspaceStartRefusal(facts({ project: hybrid }), NOW)).toBeNull();
    expect(workspaceStartRefusal(facts({ project: hybrid }), DEADLINE)).toBe("closed");
    const applied = { ...repo, deadlineAppliedAt: DEADLINE };
    const LATE = new Date(DEADLINE.getTime() + 86_400_000);
    expect(workspaceStartRefusal(facts({ project: { ...hybrid, deadlineStrategy: "commit" }, repo: applied }), LATE)).toBeNull();
  });

  it("gives the portal no deadline for an online project under commit: Quiz's start route decides (portalDeadline)", () => {
    const commit = { ...base, workMode: "online", deadlineStrategy: "commit" } as const;
    expect(portalDeadline(commit)).toBeNull();
    expect(portalDeadline({ ...commit, workMode: "hybrid" })).toBeNull();
    expect(portalDeadline({ ...commit, workMode: "online_seb" })).toEqual(DEADLINE);
    expect(portalDeadline(facts().project)).toEqual(DEADLINE);
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
    deadlineAppliedAt: null,
    lockedAt: null,
    githubRepoId: 101,
  };
  const facts = (over: Partial<GitTokenFacts> = {}): GitTokenFacts => ({
    project: {
      workMode: "online",
      deadlineAt: DEADLINE,
      graceMinutes: 30,
      deadlineStrategy: "lock",
      archivedAt: null,
      distributionRepoId: 202,
      distributionFullName: "org/lab-squashed",
    },
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

  it("shares the start route's closing rule (workspaceClosed)", () => {
    expect(workspaceClosed({ classroomArchived: false }, GRACE_END, NOW)).toBe(false);
    expect(workspaceClosed({ classroomArchived: true }, GRACE_END, NOW)).toBe(true);
    expect(workspaceClosed({ classroomArchived: false }, GRACE_END, GRACE_END)).toBe(true);
  });

  it("grants a hybrid project's student write on their repository, the distribution never (ADR-149)", () => {
    const hybrid = (over: Partial<GitTokenFacts> = {}) => facts({ project: { ...facts().project, workMode: "hybrid" }, ...over });
    expect(gitTokenRefusal(hybrid(), NOW)).toEqual({ permission: "write", githubRepoId: 101, useUntil: GRACE_END });
    expect(gitTokenRefusal(hybrid({ repository: "org/lab-squashed" }), NOW)).toBe("not_found");
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

  it("under commit, stays open past the grace while the repository is writable (#958)", () => {
    const LATE = new Date(GRACE_END.getTime() + 86_400_000);
    const commit = (over: Partial<GitTokenFacts> = {}, p: Partial<GitTokenFacts["project"]> = {}) =>
      facts({ ...over, project: { ...facts().project, deadlineStrategy: "commit", ...p } });
    const applied = { ...repo, deadlineAppliedAt: DEADLINE };
    expect(gitTokenRefusal(commit({ repo: applied }), LATE)).toEqual({ permission: "write", githubRepoId: 101, useUntil: null });
    expect(gitTokenRefusal(commit({ repo: applied }), NOW)).toMatchObject({ useUntil: null });
    // A staff lock and an archived classroom close it; an exam under Safe Exam Browser keeps its deadline.
    expect(gitTokenRefusal(commit({ repo: { ...applied, staffLock: true } }), LATE)).toBe("closed");
    expect(gitTokenRefusal(commit({ repo: applied, classroomArchived: true }), LATE)).toBe("closed");
    expect(gitTokenRefusal(commit({ repo: applied }, { workMode: "online_seb" }), LATE)).toBe("closed");
    expect(gitTokenRefusal(commit({ repo: applied, repository: "org/lab-squashed" }, { workMode: "online_seb" }), LATE)).toBe("closed");
    // Under lock, unchanged: closed at the deadline plus the grace.
    expect(gitTokenRefusal(facts({ repo: applied }), GRACE_END)).toBe("closed");
  });
});

describe("staffReviewRefusal (ADR-129 §5)", () => {
  const repo = { provisionStatus: "ok", fullName: "org/lab-kid", githubRepoId: 101, deletedAt: null, deadlineAppliedAt: null };
  const facts = (over: Partial<StaffReviewFacts> = {}): StaffReviewFacts => ({
    holderGranted: true,
    classroomArchived: false,
    projectArchived: false,
    repo,
    workMode: "free",
    ...over,
  });

  it("opens a live repository of a free or online project at any time", () => {
    expect(staffReviewRefusal(facts())).toBeNull();
    expect(staffReviewRefusal(facts({ workMode: "online" }))).toBeNull();
    expect(staffReviewRefusal(facts({ workMode: "online", repo: { ...repo, deadlineAppliedAt: "2026-10-14T22:00:00Z" } }))).toBeNull();
  });

  it("opens an online_seb repository only once its deadline is applied", () => {
    expect(staffReviewRefusal(facts({ workMode: "online_seb" }))).toBe("review_exam_open");
    expect(staffReviewRefusal(facts({ workMode: "online_seb", repo: { ...repo, deadlineAppliedAt: new Date() } }))).toBeNull();
  });

  it("refuses an archived classroom or project, and a repository that is not live or has no GitHub id", () => {
    expect(staffReviewRefusal(facts({ classroomArchived: true }))).toBe("review_archived");
    expect(staffReviewRefusal(facts({ projectArchived: true }))).toBe("review_archived");
    expect(staffReviewRefusal(facts({ repo: { ...repo, provisionStatus: "pending" } }))).toBe("review_repo_unavailable");
    expect(staffReviewRefusal(facts({ repo: { ...repo, fullName: null } }))).toBe("review_repo_unavailable");
    expect(staffReviewRefusal(facts({ repo: { ...repo, deletedAt: new Date() } }))).toBe("review_repo_unavailable");
    expect(staffReviewRefusal(facts({ repo: { ...repo, githubRepoId: null } }))).toBe("review_repo_unavailable");
  });

  it("answers in order: the grant, the archive, the repository, the exam", () => {
    const dead = { ...repo, deletedAt: new Date() };
    const all = facts({ holderGranted: false, classroomArchived: true, repo: dead, workMode: "online_seb" });
    expect(staffReviewRefusal(all)).toBe("review_not_granted");
    expect(staffReviewRefusal({ ...all, holderGranted: true })).toBe("review_archived");
    expect(staffReviewRefusal({ ...all, holderGranted: true, classroomArchived: false })).toBe("review_repo_unavailable");
    expect(staffReviewRefusal({ ...all, holderGranted: true, classroomArchived: false, repo })).toBe("review_exam_open");
  });
});

describe("distributionReviewRefusal (ADR-147 §3)", () => {
  const facts = (over: Partial<DistributionReviewFacts> = {}): DistributionReviewFacts => ({
    holderGranted: true,
    classroomArchived: false,
    projectArchived: false,
    distributionBuilt: true,
    ...over,
  });

  it("opens a built distribution of a project not archived", () => {
    expect(distributionReviewRefusal(facts())).toBeNull();
  });

  it("refuses without the grant, archived, or with no distribution built, in that order", () => {
    expect(distributionReviewRefusal(facts({ distributionBuilt: false }))).toBe("review_distribution_missing");
    const all = facts({ holderGranted: false, projectArchived: true, distributionBuilt: false });
    expect(distributionReviewRefusal(all)).toBe("review_not_granted");
    expect(distributionReviewRefusal({ ...all, holderGranted: true })).toBe("review_archived");
    expect(distributionReviewRefusal(facts({ classroomArchived: true }))).toBe("review_archived");
  });
});
