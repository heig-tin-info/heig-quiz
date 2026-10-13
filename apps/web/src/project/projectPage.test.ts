import { describe, expect, it } from "vitest";

import type { ProjectRepoView } from "@quiz/contracts";

import { ApiError } from "../api";
import { AHEAD, makeCheckpoint, makeGroup, makeProject, makeRepo, PAST, row } from "../test/project-fixtures";
import {
  checkpointStatus,
  commitTone,
  deadlinePassed,
  elapsedFraction,
  railCountdown,
  filterEntries,
  projectTally,
  advancedCount,
  railSteps,
  deadlineDesc,
  isReopen,
  offersResync,
  offersSync,
  LIVE_STALE_REFETCH_MS,
  projectRefetchInterval,
  projectStatus,
  REFETCH_MS,
  refusalKey,
  refusalMessage,
  releaseRefusal,
  reopenedRepos,
  repoEntries,
  repoFlags,
  repoShortName,
  reviewTag,
  reviewView as reviewViewOf,
  syncTag,
  teacherScoreBlock,
  unassignedStudents,
} from "./projectPage";
import { scoreOverrideBody } from "./TeacherScoreForm";

/** A translator that echoes the key and its variables, for the helpers that word something. */
const t = ((key: string, vars?: Record<string, string | number>) =>
  vars ? `${key} ${JSON.stringify(vars)}` : key) as Parameters<typeof deadlineDesc>[2];
const statusKey = (p: Parameters<typeof projectStatus>[0]) => projectStatus(p).key;

/*
 * The project page's rules (F-PROJ-13, M3-12): what the header says per
 * state and primary action, a row's flags and their tones, the reopen a
 * later deadline means and how far it reaches, a checkpoint's status, the
 * refetch cadence, and the 409 of Publish read without its contract yet.
 */

describe("the header's sentence", () => {
  it("follows the state, and names Release and Sync as text when the server asks for them", () => {
    expect(statusKey(makeProject({ state: "draft", primaryAction: "publish" }))).toBe("project.status.draft");
    expect(statusKey(makeProject({ state: "draft", publishMode: "scheduled", primaryAction: "publish" }))).toBe(
      "project.status.scheduled",
    );
    expect(statusKey(makeProject())).toBe("project.status.open");
    expect(statusKey(makeProject({ state: "locked", primaryAction: "release" }))).toBe("project.status.release");
    expect(statusKey(makeProject({ primaryAction: "sync" }))).toBe("project.status.sync");
    expect(statusKey(makeProject({ archivedAt: PAST, primaryAction: "none" }))).toBe("project.status.archived");
  });

  it("tells a locked project not yet frozen from one frozen, and a released one", () => {
    const counts = { live: 2, frozen: 1 };
    expect(statusKey(makeProject({ state: "locked", counts }))).toBe("project.status.lockedFreezing");
    expect(statusKey(makeProject({ state: "locked", counts: { ...counts, frozen: 2 }, gradingMode: "none" }))).toBe(
      "project.status.locked",
    );
    expect(statusKey(makeProject({ state: "locked", counts: { ...counts, frozen: 2 }, releasedAt: PAST }))).toBe(
      "project.status.released",
    );
  });

  it("names the date the sentence is about: the start, the release, else the deadline", () => {
    const start = new Date(Date.now() + 86_400_000).toISOString();
    expect(projectStatus(makeProject({ state: "draft", publishMode: "scheduled", startAt: start })).date).toBe(start);
    expect(projectStatus(makeProject({ state: "locked", releasedAt: PAST, gradingMode: "none" })).date).toBe(PAST);
    expect(projectStatus(makeProject()).date).toBe(AHEAD);
  });
});

describe("the line under the deadline", () => {
  it("says a duration on a manual draft, the reopen on a locked project, else the foreign zone", () => {
    expect(deadlineDesc(makeProject({ state: "draft", durationMinutes: 3 * 1440 }), "Asia/Tokyo", t)).toBe(
      'project.deadline.byDuration {"days":3}',
    );
    expect(deadlineDesc(makeProject({ state: "locked" }), "Asia/Tokyo", t)).toBe("project.deadline.reopenDesc");
    expect(deadlineDesc(makeProject(), "Asia/Tokyo", t)).toBe('project.zone {"zone":"Asia/Tokyo"}');
    expect(deadlineDesc(makeProject(), null, t)).toBeUndefined();
  });
});

describe("a repository's flags", () => {
  it("is empty for a healthy repository", () => {
    expect(repoFlags(makeRepo(1))).toEqual([]);
  });

  it("names every flag, the alerts in red, what needs a look in amber, the facts in zinc", () => {
    const flags = repoFlags(
      makeRepo(1, {
        degraded: true,
        archived: true,
        flags: {
          protectionSuspended: true,
          toVerify: true,
          multiple: true,
          malformed: "no annotation parsed",
          clamped: true,
          deleted: true,
          changedAfterRelease: true,
        },
      }),
    );
    expect(flags).toEqual([
      { key: "project.flag.deleted", tone: "zinc" },
      { key: "project.flag.multiple", tone: "red" },
      { key: "project.flag.conflict", tone: "amber" },
      { key: "project.flag.toVerify", tone: "amber" },
      { key: "project.flag.changed", tone: "amber" },
      { key: "project.flag.clamped", tone: "amber" },
      { key: "project.flag.malformed", tone: "zinc" },
      { key: "project.flag.degraded", tone: "zinc" },
    ]);
  });

  it("says an access to revoke in amber, never red (ADR-070 §4, M3-16b)", () => {
    expect(repoFlags(makeRepo(1, { accessToRevoke: true }))).toEqual([{ key: "project.flag.accessToRevoke", tone: "amber" }]);
  });

  it("reads a degraded repository that is not archived as one without its ruleset", () => {
    expect(repoFlags(makeRepo(1, { degraded: true }))).toEqual([{ key: "project.flag.noRuleset", tone: "zinc" }]);
  });
});

describe("the reopen of a moved deadline (F-PROJ-09)", () => {
  const applied = makeRepo(1, { deadlineAppliedAt: PAST, frozenAt: PAST, locked: true, effectiveDeadlineAt: PAST });
  const own = makeRepo(2, { deadlineAt: AHEAD, deadlineAppliedAt: PAST, effectiveDeadlineAt: AHEAD });
  const deleted = makeRepo(3, { deadlineAppliedAt: PAST, flags: { ...applied.flags, deleted: true } });
  const locked = makeProject({
    state: "locked",
    deadlineAt: PAST,
    deadlineAppliedAt: PAST,
    rows: [row(1, applied), row(2, own), row(3, deleted), row(4, null)],
  });

  it("is a reopen when the project's deadline was applied and the new one lies ahead", () => {
    expect(isReopen(locked, AHEAD, Date.now())).toBe(true);
    expect(isReopen(makeProject(), AHEAD, Date.now())).toBe(false);
  });

  it("counts the live repositories following the project's deadline, never one with its own nor a deleted one", () => {
    expect(reopenedRepos(locked, AHEAD, Date.now())).toBe(1);
  });

  it("is no reopen while the deadline was never applied, even moved later", () => {
    expect(reopenedRepos(makeProject({ rows: [row(1, makeRepo(1))] }), AHEAD, Date.now())).toBe(0);
  });
});

describe("a checkpoint's status", () => {
  it("is sent, void past a deadline moved earlier, or scheduled", () => {
    expect(checkpointStatus(makeCheckpoint(1, { dispatchedAt: PAST }), AHEAD)).toBe("dispatched");
    expect(checkpointStatus(makeCheckpoint(1, { dueAt: AHEAD }), PAST)).toBe("void");
    expect(checkpointStatus(makeCheckpoint(1), AHEAD)).toBe("scheduled");
  });
});

describe("the refetch cadence", () => {
  it("is 30 s, and 3 s once after a response whose live state was not all read, or while a sync runs", () => {
    expect(projectRefetchInterval(undefined)).toBe(REFETCH_MS);
    expect(projectRefetchInterval(makeProject())).toBe(REFETCH_MS);
    expect(projectRefetchInterval(makeProject({ liveStale: true }))).toBe(LIVE_STALE_REFETCH_MS);
    expect(projectRefetchInterval(makeProject({ sync: { ...makeProject().sync, inProgress: true } }))).toBe(LIVE_STALE_REFETCH_MS);
    expect(LIVE_STALE_REFETCH_MS).toBeLessThan(REFETCH_MS);
  });
});

describe("the sync (F-PROJ-12, M3-07)", () => {
  const ahead = { pushedAt: PAST, commits: 2 };
  const sync = (over: Partial<ProjectRepoView["sync"]>): ProjectRepoView => makeRepo(1, { sync: { pr: null, outcome: null, at: null, ...over } });

  it("offers Sync beside another primary action while the server says the source is ahead or a sync runs", () => {
    expect(offersSync(makeProject())).toBe(false);
    expect(offersSync(makeProject({ sync: { ahead, inProgress: false, syncedAt: null, last: null } }))).toBe(true);
    expect(offersSync(makeProject({ sync: { ahead: null, inProgress: true, syncedAt: null, last: null } }))).toBe(true);
    // The server's own primary action: the button is the primary one, not a second.
    expect(offersSync(makeProject({ primaryAction: "sync", sync: { ahead, inProgress: false, syncedAt: null, last: null } }))).toBe(false);
  });

  it("tags a row: a failed sync first, else the pull request by its state (open linked), else up to date or skipped, else nothing", () => {
    expect(syncTag(sync({}))).toBeNull();
    expect(syncTag(sync({ outcome: "opened" }))).toBeNull(); // opened without its row: nothing to link
    expect(syncTag(sync({ pr: { number: 4, state: "open" }, outcome: "failed" }))).toEqual({ key: "project.syncTag.failed", tone: "red", href: null });
    expect(syncTag(sync({ pr: { number: 4, state: "open" }, outcome: "opened" }))).toEqual({
      key: "project.syncTag.open",
      tone: "amber",
      n: 4,
      href: "https://github.com/heig-tin-info/labo-2-student-1/pull/4",
    });
    expect(syncTag(sync({ pr: { number: 4, state: "merged" }, outcome: "up_to_date" }))).toMatchObject({ key: "project.syncTag.merged", tone: "green", n: 4 });
    expect(syncTag(sync({ pr: { number: 4, state: "closed" }, outcome: "updated" }))).toMatchObject({ key: "project.syncTag.closed", tone: "zinc" });
    expect(syncTag(sync({ outcome: "up_to_date" }))).toEqual({ key: "project.syncTag.upToDate", tone: "zinc", href: null });
    expect(syncTag(sync({ outcome: "skipped" }))).toEqual({ key: "project.syncTag.skipped", tone: "zinc", href: null });
  });

  it("words the resync's refusals (M3-16b)", () => {
    for (const [code, key] of [
      ["released", "project.refusal.released"],
      ["classroom_archived", "project.refusal.classroomArchived"],
      ["project_archived", "project.refusal.projectArchived"],
      ["no_group_set", "project.noGroupSet.title"],
      ["group_sync_pending", "project.refusal.groupSyncPending"],
    ] as const) {
      expect(refusalKey(new ApiError(409, { error: code, message: "" }))).toBe(key);
    }
  });

  it("words the sync's refusals", () => {
    for (const [code, key] of [
      ["project_archived", "project.refusal.projectArchived"],
      ["sync_in_progress", "project.refusal.syncInProgress"],
      ["source_rewritten", "project.refusal.sourceRewritten"],
      ["sync_failed", "project.refusal.syncFailed"],
    ] as const) {
      expect(refusalKey(new ApiError(409, { error: code, message: "" }))).toBe(key);
    }
  });
});

describe("the refusals", () => {
  it("reads Publish's 409 unassigned_students through the contracts' ProjectUnassigned, its students included", () => {
    const body = {
      error: "unassigned_students",
      message: "2 student(s) in no group",
      students: [
        { enrollmentId: "0190d3c4-0000-7000-8000-00000000e001", nom: "Dupont", prenom: "Alice" },
        { enrollmentId: "0190d3c4-0000-7000-8000-00000000e002", nom: "Martin", prenom: "Benoît" },
      ],
    };
    expect(unassignedStudents(new ApiError(409, body))).toEqual(body.students);
    // The contract is strict about the shape: no message, or an id that is no uuid, is not that refusal.
    expect(unassignedStudents(new ApiError(409, { error: "unassigned_students", students: body.students }))).toBeNull();
    expect(
      unassignedStudents(
        new ApiError(409, { ...body, students: [{ enrollmentId: "e1", nom: "Dupont", prenom: "Alice" }] }),
      ),
    ).toBeNull();
    expect(unassignedStudents(new ApiError(409, { error: "not_draft", message: "" }))).toBeNull();
    expect(unassignedStudents(new Error("boom"))).toBeNull();
  });

  it("words the refusals it knows and leaves the rest to the server's message", () => {
    expect(refusalKey(new ApiError(422, { error: "deadline_past", message: "" }))).toBe("project.refusal.deadlinePast");
    expect(refusalKey(new ApiError(409, { error: "checkpoint_dispatched", message: "" }))).toBe(
      "project.refusal.checkpointDispatched",
    );
    expect(refusalKey(new ApiError(409, { error: "source_not_found", message: "" }))).toBeNull();
    expect(refusalKey(new Error("boom"))).toBeNull();
  });

  it("words the staff's writes' refusals (M3-08b): the score's, the resend's, the release's", () => {
    const key = (error: string) => refusalKey(new ApiError(409, { error, message: "" }));
    expect(key("not_frozen")).toBe("project.refusal.notFrozen");
    expect(key("grading_none")).toBe("project.refusal.gradingNone");
    // The release's `to_verify` is worded by `releaseRefusal`, with the names; alone it reads the server's message.
    expect(key("to_verify")).toBeNull();
    expect(key("score_max_required")).toBe("project.refusal.scoreMaxRequired");
    expect(key("score_max_mismatch")).toBe("project.refusal.scoreMaxMismatch");
    expect(key("score_above_max")).toBe("project.refusal.scoreAboveMax");
    expect(key("invitation_not_pending")).toBe("project.refusal.invitationNotPending");
    expect(key("resend_too_soon")).toBe("project.refusal.resendTooSoon");
    expect(key("invite_failed")).toBe("project.refusal.inviteFailed");
    expect(key("github_account_stale")).toBe("project.refusal.githubAccountStale");
  });

  it("says a refused release with what its body carries: the counts, the students to verify", () => {
    const project = makeProject({ rows: [row(1, makeRepo(1)), row(2, makeRepo(2))] });
    expect(releaseRefusal(new ApiError(409, { error: "not_frozen", message: "", live: 3, frozen: 1 }), project, t)).toBe(
      'project.release.refusal.notFrozen {"frozen":1,"live":3}',
    );
    expect(
      releaseRefusal(new ApiError(409, { error: "to_verify", message: "", repos: [makeRepo(2).id] }), project, t),
    ).toBe('project.release.refusal.toVerify {"names":"Rochat Chloé"}');
    // A repository the page does not list (a row refetched away): the names fall back to a generic word.
    expect(
      releaseRefusal(new ApiError(409, { error: "to_verify", message: "", repos: [makeRepo(9).id] }), project, t),
    ).toBe('project.release.refusal.toVerify {"names":"project.release.refusal.someRepos"}');
    // A body the contract does not describe (no counts, a `to_verify` without ids), and grading_none: the plain words.
    expect(releaseRefusal(new ApiError(409, { error: "not_frozen", message: "" }), project, t)).toBe("project.refusal.notFrozen");
    expect(releaseRefusal(new ApiError(409, { error: "to_verify", message: "The server says" }), project, t)).toBe("The server says");
    expect(releaseRefusal(new ApiError(409, { error: "grading_none", message: "" }), project, t)).toBe(
      "project.refusal.gradingNone",
    );
    // ADR-070's R2: a resync of the groups still applied.
    expect(releaseRefusal(new ApiError(409, { error: "group_sync_pending", message: "" }), project, t)).toBe(
      "project.refusal.groupSyncPending",
    );
    expect(releaseRefusal(new Error("boom"), project, t)).toBe("error.save");
  });
});

describe("the header once released", () => {
  it("offers the release again as its own sentence, dated at the release", () => {
    const p = makeProject({ state: "locked", primaryAction: "release", releasedAt: PAST });
    expect(projectStatus(p)).toEqual({ key: "project.status.rerelease", date: PAST });
  });
});

describe("the final review's state (F-PROJ-11, M3-08b)", () => {
  const review = (over: Partial<ProjectRepoView["review"]>): ProjectRepoView["review"] => ({
    status: "pending",
    reason: null,
    askedAt: null,
    sha: null,
    runId: null,
    ...over,
  });

  it("has a word, a tone and a detail per status: facts in zinc, degraded in amber, not confirmed in red, done in green", () => {
    // Pending says it waits for the freeze only while there is none; frozen and pending, it is simply due.
    expect(reviewViewOf(review({}), null)).toEqual({ key: "project.reviewState.pending", tone: "zinc", detail: "project.reviewState.pending.detail" });
    expect(reviewViewOf(review({}), PAST)).toEqual({ key: "project.reviewState.pending", tone: "zinc", detail: null });
    const reviewView = (r: ProjectRepoView["review"]) => reviewViewOf(r, PAST);
    expect(reviewView(review({ status: "none" }))).toEqual({ key: "project.reviewState.none", tone: "zinc", detail: null });
    expect(reviewView(review({ status: "none", reason: "no_frozen_run" }))).toEqual({
      key: "project.reviewState.none",
      tone: "zinc",
      detail: "project.reviewState.noFrozenRun.detail",
    });
    expect(reviewView(review({ status: "skipped", reason: "archived" }))).toEqual({
      key: "project.reviewState.none",
      tone: "amber",
      detail: "project.reviewState.archived.detail",
    });
    expect(reviewView(review({ status: "skipped", reason: "protection_suspended" }))).toEqual({
      key: "project.reviewState.none",
      tone: "amber",
      detail: "project.reviewState.protectionSuspended.detail",
    });
    expect(reviewView(review({ status: "unconfirmed", sha: "abc" }))).toEqual({
      key: "project.reviewState.unconfirmed",
      tone: "red",
      detail: "project.reviewState.unconfirmed.detail",
    });
    expect(reviewView(review({ status: "asked", sha: "abc", askedAt: PAST }))).toEqual({
      key: "project.reviewState.asked",
      tone: "zinc",
      detail: "project.reviewState.asked.detail",
    });
    expect(reviewView(review({ status: "done", runId: "run-9" }))).toEqual({ key: "project.reviewState.done", tone: "green", detail: null });
  });

  it("tags no table row while the review is trivially pending, nor on a project that has no review", () => {
    expect(reviewTag(makeRepo(1))).toBeNull();
    expect(reviewTag(makeRepo(1, { frozenAt: PAST }))?.key).toBe("project.reviewState.pending");
    expect(reviewTag(makeRepo(1, { review: review({ status: "none" }) }))).toBeNull();
    expect(reviewTag(makeRepo(1, { review: review({ status: "none", reason: "no_frozen_run" }) }))).toMatchObject({
      key: "project.reviewState.none",
      tone: "zinc",
    });
    expect(reviewTag(makeRepo(1, { review: review({ status: "unconfirmed" }) }))?.key).toBe("project.reviewState.unconfirmed");
  });
});

describe("the teacher's score (F-PROJ-14)", () => {
  it("is offered only on a graded project, once the repository is frozen for good", () => {
    expect(teacherScoreBlock(makeRepo(1), makeProject())).toBe("not_frozen");
    expect(teacherScoreBlock(makeRepo(1, { frozenAt: PAST }), makeProject())).toBeNull();
    expect(teacherScoreBlock(makeRepo(1, { frozenAt: PAST }), makeProject({ gradingMode: "none" }))).toBe("grading_none");
  });

  it("sends what ScoreOverride accepts: the points as typed, the maximum only when the teacher gives it, the comment trimmed", () => {
    expect(scoreOverrideBody("8.5", "", " Bien. ", false)).toEqual({ points: 8.5, comment: "Bien." });
    expect(scoreOverrideBody("8", "20", "", true)).toEqual({ points: 8, max: 20, comment: "" });
    // Nothing to send: no points, an own maximum required and missing, or a value the contract refuses.
    expect(scoreOverrideBody("", "", "", false)).toBeNull();
    expect(scoreOverrideBody("8", "", "", true)).toBeNull();
    expect(scoreOverrideBody("abc", "", "", false)).toBeNull();
    expect(scoreOverrideBody("-1", "", "", false)).toBeNull();
    expect(scoreOverrideBody("1001", "", "", false)).toBeNull();
    expect(scoreOverrideBody("8", "0", "", true)).toBeNull();
    expect(scoreOverrideBody("8", "", "x".repeat(2001), false)).toBeNull();
  });

  it("says the worded refusal, else the server's message, else the save failure", () => {
    expect(refusalMessage(new ApiError(422, { error: "due_past", message: "nope" }), t)).toBe("project.refusal.duePast");
    expect(refusalMessage(new ApiError(409, { error: "weird", message: "The server says" }), t)).toBe("The server says");
    expect(refusalMessage(new Error("boom"), t)).toBe("error.save");
  });
});

it("names a repository without its organization", () => {
  expect(repoShortName("heig-tin-info/labo-2-alice")).toBe("labo-2-alice");
});

describe("one row per group (ADR-070 §4, M3-16b)", () => {
  const g1 = makeGroup(1);
  const g2 = makeGroup(2, true);
  const g10 = makeGroup(10);
  const repoA = makeRepo(1);
  const orphan = makeRepo(3);

  it("gathers a group project's rows by group, by name: its repository once, its roster members; then the students in none", () => {
    const entries = repoEntries(
      makeProject({
        groupMode: true,
        rows: [
          row(0, repoA, {}, g1),
          row(1, null, {}, g10),
          row(2, repoA, {}, g1),
          row(3, null, {}, null),
          // R1: a repository its group no longer holds anyone in, by its creator's account.
          row(4, orphan, { enrollmentId: null }, g2),
        ],
      }),
    );
    expect(entries.map((e) => [e.kind, e.label, e.repo?.id ?? null, e.kind === "group" ? e.members.map((m) => m.prenom) : null])).toEqual([
      ["group", "Groupe 1", repoA.id, ["Alice", "Chloé"]],
      ["group", "Groupe 2", orphan.id, []],
      ["group", "Groupe 10", null, ["Benoît"]],
      ["student", "Favre David", null, null],
    ]);
  });

  it("carries a teacher's test repository as a staff entry (ADR-077)", () => {
    const entries = repoEntries(makeProject({ rows: [row(1, repoA), { ...row(2, repoA), staff: true }] }));
    expect(entries.map((e) => e.kind === "student" && e.staff)).toEqual([false, true]);
  });

  it("keeps one row per student in an individual project, whatever a row says", () => {
    const entries = repoEntries(makeProject({ rows: [row(1, repoA), row(2, null, {}, g1)] }));
    expect(entries.map((e) => [e.kind, e.label])).toEqual([
      ["student", "Martin Benoît"],
      ["student", "Rochat Chloé"],
    ]);
  });

  it("names the groups of a refused release in group mode", () => {
    const project = makeProject({ groupMode: true, rows: [row(0, repoA, {}, g1), row(2, repoA, {}, g1)] });
    expect(releaseRefusal(new ApiError(409, { error: "to_verify", message: "", repos: [repoA.id] }), project, t)).toBe(
      'project.release.refusal.toVerify {"names":"Groupe 1"}',
    );
  });

  it("offers Resync on a drift only while the project is neither released nor archived", () => {
    expect(offersResync(makeProject({ groupsDrifted: true }))).toBe(true);
    expect(offersResync(makeProject({ groupsDrifted: false }))).toBe(false);
    expect(offersResync(makeProject({ groupsDrifted: true, releasedAt: PAST }))).toBe(false);
    expect(offersResync(makeProject({ groupsDrifted: true, archivedAt: PAST }))).toBe(false);
  });
});

// ---------------------------------------------------------------- the dashboard

const staffRow = (n: number, repo: ProjectRepoView | null) => ({ ...row(n, repo), staff: true });
const flagsOf = (n: number, over: Partial<ProjectRepoView["flags"]>): Partial<ProjectRepoView> => ({
  flags: { ...makeRepo(n).flags, ...over },
});

describe("the tiles' figures", () => {
  const rows = [
    row(1, makeRepo(1)),
    row(2, makeRepo(2, { invitationStatus: "pending", commits: 0, lastCommit: null })),
    row(3, makeRepo(3, { provisionStatus: "pending", commits: 0, lastCommit: null })),
    row(4, makeRepo(4, { provisionStatus: "error", provisionError: "boom" })),
    row(5, null),
    row(6, makeRepo(6, { ciStatus: "fail", ...flagsOf(6, { toVerify: true }) })),
    row(7, makeRepo(7, { ...flagsOf(7, { multiple: true }), frozenAt: PAST })),
    row(8, makeRepo(8, { ...flagsOf(8, { protectionSuspended: true }), deadlineAt: AHEAD })),
    { ...row(9, makeRepo(9)), student: { ...makeProject().rows[0]!.student, enrollmentId: null } },
    staffRow(10, makeRepo(10, { commits: 0, ciStatus: "fail" })),
  ];
  const project = makeProject({ rows });

  it("counts the acceptance in the ring's parts, and says the rest in words", () => {
    const tally = projectTally(project);
    // The staff's test repository is a row of the table and counted nowhere.
    expect(tally.total).toBe(9);
    expect(tally.acceptance).toEqual({
      // 1, 6, 7, 8 are ready; 4 failed to provision and 9 left the roster are not parts.
      ready: 4,
      pending: 2,
      none: 1,
      provisionErrors: 1,
      noGroup: 0,
      leftRoster: 1,
    });
  });

  it("counts the progress with the filters' own rules", () => {
    const { progress } = projectTally(project);
    // Pushed: the live repositories with a commit; the staff's and the unprovisioned ones are not.
    expect(progress).toEqual({ pushed: 5, noCommit: 1, ciFail: 1, toVerify: 1, alerts: 2 });
    const entries = repoEntries(project);
    for (const [filter, n] of [
      ["pending", 2],
      ["notAccepted", 1],
      ["noCommit", 1],
      ["ciFail", 1],
      ["toVerify", 1],
      ["alerts", 2],
    ] as const) {
      expect(filterEntries(entries, filter, project)).toHaveLength(n);
    }
  });

  it("keeps the staff's row under All only, and every row without a filter", () => {
    const entries = repoEntries(project);
    expect(filterEntries(entries, null, project)).toHaveLength(10);
    for (const filter of ["pending", "notAccepted", "noCommit", "ciFail", "toVerify", "alerts"] as const) {
      expect(filterEntries(entries, filter, project).some((e) => e.kind === "student" && e.staff)).toBe(false);
    }
  });

  it("counts an archived project's repositories like any other: the figures describe them, not what can be acted on", () => {
    const archived = makeProject({ rows, archivedAt: PAST });
    expect(projectTally(archived).progress).toEqual(projectTally(makeProject({ rows })).progress);
    expect(projectTally(archived).progress.pushed).toBeGreaterThan(0);
  });

  it("counts a group project per group, with a ring of two parts and an invitation that is nobody's", () => {
    const g1 = makeGroup(1);
    const g2 = makeGroup(2);
    const grouped = makeProject({
      groupMode: true,
      rows: [
        row(1, makeRepo(1, { invitationStatus: "pending" }), {}, g1),
        row(2, makeRepo(1, { invitationStatus: "pending" }), {}, g1),
        row(3, null, {}, g2),
        row(4, null),
      ],
    });
    const tally = projectTally(grouped);
    expect(tally.total).toBe(3);
    // One repository for the two members; the student in no group is said, not drawn.
    expect(tally.acceptance).toMatchObject({ ready: 1, pending: 0, none: 1, noGroup: 1 });
    expect(filterEntries(repoEntries(grouped), "notAccepted", grouped).map((e) => e.label)).toEqual(["Groupe 2"]);
  });

  it("counts the repositories with a later deadline of their own", () => {
    const later = new Date(Date.parse(AHEAD) + 86_400_000).toISOString();
    const earlier = new Date(Date.parse(AHEAD) - 86_400_000).toISOString();
    const tally = projectTally(
      makeProject({
        rows: [
          row(1, makeRepo(1, { deadlineAt: later })),
          row(2, makeRepo(2, { deadlineAt: earlier })),
          row(3, makeRepo(3)),
        ],
      }),
    );
    expect(tally.own).toEqual({ n: 2, later: 1, lastLater: later });
  });
});

describe("the commit count's tone", () => {
  const lastCommit = { sha: "abc", at: PAST };
  it("is plain with commits, amber for none while the work may come, red once the deadline was applied and nothing was received", () => {
    expect(commitTone({ commits: 3, lastCommit, deadlineAppliedAt: PAST })).toBe("plain");
    expect(commitTone({ commits: 0, lastCommit: null, deadlineAppliedAt: null })).toBe("warning");
    expect(commitTone({ commits: 0, lastCommit: null, deadlineAppliedAt: PAST })).toBe("danger");
  });

  it("stays amber for a zero with a last commit, even after the deadline", () => {
    expect(commitTone({ commits: 0, lastCommit, deadlineAppliedAt: PAST })).toBe("warning");
  });
});

describe("the lifecycle rail's steps", () => {
  const kinds = (steps: ReturnType<typeof railSteps>) =>
    steps.map((s) => (s.kind === "checkpoint" ? `${s.checkpoint.name}:${s.status}` : s.kind));
  const soon = makeCheckpoint(1, { name: "soon" });
  const sent = makeCheckpoint(2, { name: "sent", dispatchedAt: PAST, dueAt: PAST });
  const late = makeCheckpoint(3, {
    name: "late",
    dueAt: new Date(Date.parse(AHEAD) + 86_400_000).toISOString(),
    offsetDays: null,
  });

  it("runs Published, the checkpoints by date, Deadline, Freeze, the void ones, then Release", () => {
    const steps = railSteps(makeProject(), [late, soon, sent]);
    expect(kinds(steps)).toEqual(["published", "sent:dispatched", "soon:scheduled", "deadline", "freeze", "late:void", "release"]);
    expect(steps.at(-1)).toEqual({ kind: "release", at: null });
  });

  it("has neither checkpoints nor a Release step for a project graded none", () => {
    expect(kinds(railSteps(makeProject({ gradingMode: "none" }), [soon]))).toEqual(["published", "deadline", "freeze"]);
  });

  it("marks Release done with its date once released, and the freeze done once locked and every repository is frozen", () => {
    const frozen = makeRepo(1, { frozenAt: PAST });
    const released = makeProject({
      state: "locked",
      deadlineAppliedAt: PAST,
      releasedAt: PAST,
      rows: [row(1, frozen)],
      counts: { live: 1, frozen: 1 },
    });
    const steps = railSteps(released, []);
    expect(steps.at(-1)).toEqual({ kind: "release", at: PAST });
    expect(steps.find((s) => s.kind === "freeze")).toMatchObject({ done: true });
    expect(steps.find((s) => s.kind === "deadline")).toMatchObject({ done: true });
  });

  it("shows no date a manual draft does not have, and the dates it does", () => {
    const relative = makeCheckpoint(4, { name: "mid", offsetDays: -3 });
    const fixed = makeCheckpoint(5, { name: "fixed", offsetDays: null });
    const dated = (steps: ReturnType<typeof railSteps>) =>
      steps.flatMap((s) => (s.kind === "checkpoint" ? [[s.checkpoint.name, s.dated]] : []));

    // A manual draft with a deadline that is a date: no start yet, but the deadline and the J-n dates are real.
    const byDate = railSteps(makeProject({ state: "draft", publishMode: "manual", durationMinutes: null }), [relative, fixed]);
    expect(byDate[0]).toEqual({ kind: "published", at: null, done: false });
    expect(byDate.find((s) => s.kind === "deadline")).toEqual({ kind: "deadline", at: AHEAD, done: false });
    expect(dated(byDate)).toEqual([["mid", true], ["fixed", true]]);

    // By duration there is no deadline: its days, and a J-n checkpoint without a date.
    const byDays = railSteps(makeProject({ state: "draft", publishMode: "manual", durationMinutes: 7 * 1440 }), [relative, fixed]);
    expect(byDays.find((s) => s.kind === "deadline")).toEqual({ kind: "deadline", afterDays: 7, done: false });
    expect(dated(byDays)).toEqual([["mid", false], ["fixed", true]]);

    const planned = makeProject({ state: "draft", publishMode: "scheduled", durationMinutes: null });
    const steps = railSteps(planned, [relative]);
    expect(steps[0]).toEqual({ kind: "published", at: planned.startAt, done: false });
    expect(steps.find((s) => s.kind === "deadline")).toEqual({ kind: "deadline", at: planned.deadlineAt, done: false });
    expect(dated(steps)).toEqual([["mid", true]]);
  });

  it("goes back to an open freeze when the deadline is reopened, and says the later own deadlines", () => {
    const later = new Date(Date.parse(AHEAD) + 86_400_000).toISOString();
    const reopened = makeProject({
      state: "published",
      deadlineAppliedAt: null,
      rows: [row(1, makeRepo(1, { deadlineAt: later })), row(2, makeRepo(2))],
    });
    const steps = railSteps(reopened, []);
    expect(steps.find((s) => s.kind === "deadline")).toMatchObject({ done: false });
    expect(steps.find((s) => s.kind === "freeze")).toMatchObject({ done: false, later: 1, lastLater: later });
  });
});

describe("elapsedFraction", () => {
  const start = "2026-10-01T08:00:00.000Z";
  const end = "2026-10-01T10:00:00.000Z";
  const at = (iso: string) => Date.parse(iso);

  it("is the elapsed share of the window", () => {
    expect(elapsedFraction(start, end, at("2026-10-01T08:30:00.000Z"))).toBe(0.25);
    expect(elapsedFraction(start, end, at("2026-10-01T09:00:00.000Z"))).toBe(0.5);
  });

  it("is clamped: 0 before the start, 1 from the end on", () => {
    expect(elapsedFraction(start, end, at("2026-09-30T08:00:00.000Z"))).toBe(0);
    expect(elapsedFraction(start, end, at(start))).toBe(0);
    expect(elapsedFraction(start, end, at(end))).toBe(1);
    expect(elapsedFraction(start, end, at("2026-10-02T08:00:00.000Z"))).toBe(1);
  });

  it("has no inside for a window of zero length or an inverted one", () => {
    expect(elapsedFraction(start, start, at(start))).toBe(1);
    expect(elapsedFraction(end, start, at(start) - 1)).toBe(0);
  });
});

describe("railCountdown", () => {
  const start = "2026-10-01T08:00:00.000Z";
  const deadline = "2026-10-11T08:00:00.000Z";
  const now = Date.parse("2026-10-06T08:00:00.000Z"); // halfway
  const open = makeProject({ state: "published", startAt: start, deadlineAt: deadline, deadlineAppliedAt: null });

  it("fills each segment up to the deadline by its own dates, and nothing after it", () => {
    const sent = makeCheckpoint(1, { name: "sent", dueAt: "2026-10-03T08:00:00.000Z", dispatchedAt: start });
    const next = makeCheckpoint(2, { name: "next", dueAt: "2026-10-09T08:00:00.000Z" });
    const steps = railSteps(open, [sent, next]);
    const c = railCountdown(open, steps, now)!;
    expect(c.deadline).toBe(deadline);
    expect(c.progress).toBe(0.5);
    // published→sent full, sent→next half (3rd → 9th, now the 6th), next→deadline empty, then Deadline, Freeze, Release.
    expect(c.fills).toEqual([1, 0.5, 0, 0, 0, 0]);
  });

  it("is clamped before the start and once the browser's clock is past the deadline the server has not applied yet", () => {
    const steps = railSteps(open, []);
    expect(railCountdown(open, steps, Date.parse(start) - 60_000)).toMatchObject({ progress: 0, fills: [0, 0, 0, 0] });
    expect(railCountdown(open, steps, Date.parse(deadline) + 60_000)).toMatchObject({ progress: 1, fills: [1, 0, 0, 0] });
  });

  it("is none unless published with a deadline the server has not applied", () => {
    const none = (p: ReturnType<typeof makeProject>) => railCountdown(p, railSteps(p, []), now);
    expect(none({ ...open, state: "draft" })).toBeNull();
    expect(none({ ...open, state: "locked" })).toBeNull();
    expect(none({ ...open, deadlineAppliedAt: deadline })).toBeNull();
  });
});

describe("deadlinePassed", () => {
  it("is the server's word: locked, or the deadline applied; never the date", () => {
    expect(deadlinePassed(makeProject())).toBe(false);
    expect(deadlinePassed(makeProject({ state: "locked" }))).toBe(true);
    expect(deadlinePassed(makeProject({ deadlineAppliedAt: PAST }))).toBe(true);
    // A date in the past on an open project is not "passed" until the server says so.
    expect(deadlinePassed(makeProject({ deadlineAt: PAST }))).toBe(false);
  });
});

describe("advancedCount", () => {
  const defaults = { graceMinutes: 30, deadlineStrategy: "lock", gradingMode: "auto", gradingScale: { kind: "linear", rounding: "nearest" } } as const;
  it("counts what differs from the defaults, the scale only while graded", () => {
    expect(advancedCount(defaults)).toBe(0);
    expect(advancedCount({ ...defaults, graceMinutes: 0, deadlineStrategy: "commit" })).toBe(2);
    expect(advancedCount({ ...defaults, gradingScale: { kind: "score_is_grade", rounding: "nearest" } })).toBe(1);
    expect(advancedCount({ ...defaults, gradingMode: "none", gradingScale: { kind: "score_is_grade", rounding: "nearest" } })).toBe(1);
  });
});
