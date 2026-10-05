import { describe, expect, it } from "vitest";

import type { ProjectRepoView } from "@quiz/contracts";

import { ApiError } from "../api";
import { AHEAD, makeCheckpoint, makeProject, makeRepo, PAST, row } from "../test/project-fixtures";
import {
  checkpointStatus,
  deadlineDesc,
  hasFellBack,
  isReopen,
  offersSync,
  LIVE_STALE_REFETCH_MS,
  projectRefetchInterval,
  projectStatus,
  REFETCH_MS,
  refusalKey,
  refusalMessage,
  releaseRefusal,
  reopenedRepos,
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
    const counts = { students: 2, accepted: 2, live: 2, frozen: 1, toVerify: 0, alerts: 0 };
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

describe("the scale's warning", () => {
  it("fires once any grade of any slot fell back", () => {
    expect(hasFellBack(makeProject())).toBe(false);
    const fell = { grade: 4, fellBack: true };
    const repo = makeRepo(1, { scores: { ...makeRepo(1).scores, review: { runId: "r", points: 60, max: 100, grade: fell } } });
    expect(hasFellBack(makeProject({ rows: [row(1, null), row(2, repo)] }))).toBe(true);
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
      { key: "project.flag.malformed", tone: "zinc" },
      { key: "project.flag.degraded", tone: "zinc" },
    ]);
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
