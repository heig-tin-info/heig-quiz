import { describe, expect, it } from "vitest";

import { ApiError } from "../api";
import { AHEAD, makeCheckpoint, makeProject, makeRepo, PAST, row } from "../test/project-fixtures";
import {
  checkpointStatus,
  deadlineDesc,
  hasFellBack,
  isReopen,
  LIVE_STALE_REFETCH_MS,
  projectRefetchInterval,
  projectStatus,
  REFETCH_MS,
  refusalKey,
  refusalMessage,
  reopenedRepos,
  repoFlags,
  repoShortName,
  unassignedStudents,
} from "./projectPage";

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
  it("is 30 s, and 3 s once after a response whose live state was not all read", () => {
    expect(projectRefetchInterval(undefined)).toBe(REFETCH_MS);
    expect(projectRefetchInterval(makeProject())).toBe(REFETCH_MS);
    expect(projectRefetchInterval(makeProject({ liveStale: true }))).toBe(LIVE_STALE_REFETCH_MS);
    expect(LIVE_STALE_REFETCH_MS).toBeLessThan(REFETCH_MS);
  });
});

describe("the refusals", () => {
  it("reads Publish's 409 unassigned_students, its students included", () => {
    const body = {
      error: "unassigned_students",
      message: "2 student(s) in no group",
      students: [
        { enrollmentId: "e1", nom: "Dupont", prenom: "Alice" },
        { enrollmentId: "e2", nom: "Martin", prenom: "Benoît" },
      ],
    };
    expect(unassignedStudents(new ApiError(409, body))).toEqual(body.students);
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

  it("says the worded refusal, else the server's message, else the save failure", () => {
    expect(refusalMessage(new ApiError(422, { error: "due_past", message: "nope" }), t)).toBe("project.refusal.duePast");
    expect(refusalMessage(new ApiError(409, { error: "weird", message: "The server says" }), t)).toBe("The server says");
    expect(refusalMessage(new Error("boom"), t)).toBe("error.save");
  });
});

it("names a repository without its organization", () => {
  expect(repoShortName("heig-tin-info/labo-2-alice")).toBe("labo-2-alice");
});
