import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_NAME_MAX,
  checkpointDueAt,
  checkpointPass,
  checkpointRefusal,
  checkpointTag,
  isVoidCheckpoint,
  planCheckpointReviewDispatch,
  planFinalReviewDispatch,
} from "./reviewDispatch.js";

describe("planFinalReviewDispatch", () => {
  const project = { id: "p-1", deadlineAt: new Date("2026-07-03T21:59:00Z") };

  it("skips repositories without a frozen run (nothing to review)", () => {
    expect(planFinalReviewDispatch(project, null)).toBeNull();
  });

  it("builds the grade-final payload around the frozen commit", () => {
    const sha = "a".repeat(40);
    expect(planFinalReviewDispatch(project, sha)).toEqual({
      sha,
      eventType: "grade-final",
      clientPayload: {
        sha,
        assignment_id: "p-1",
        deadline: "2026-07-03T21:59:00.000Z",
        trigger: "deadline",
      },
    });
  });
});

describe("planCheckpointReviewDispatch", () => {
  const checkpoint = { id: "m-1", name: "mid-review", dueAt: new Date("2026-07-01T22:00:00Z") };

  it("skips repositories where the student never pushed before the checkpoint", () => {
    expect(planCheckpointReviewDispatch("p-1", checkpoint, null)).toBeNull();
  });

  it("builds the grade-milestone payload around the last received commit", () => {
    const sha = "b".repeat(40);
    expect(planCheckpointReviewDispatch("p-1", checkpoint, sha)).toEqual({
      sha,
      eventType: "grade-milestone",
      clientPayload: {
        sha,
        assignment_id: "p-1",
        milestone_id: "m-1",
        milestone: "mid-review",
        due: "2026-07-01T22:00:00.000Z",
        trigger: "milestone",
      },
    });
  });
});

describe("checkpointDueAt", () => {
  it("counts whole days around the deadline", () => {
    const deadline = new Date("2026-07-10T22:00:00Z");
    expect(checkpointDueAt(deadline, -3)).toEqual(new Date("2026-07-07T22:00:00Z"));
    expect(checkpointDueAt(deadline, 0)).toEqual(deadline);
  });

  it("counts calendar days in Zurich across the change of the clocks (25 October 2026)", () => {
    // 23:59 winter time on the 27th; J−3 is 23:59 summer time on the 24th: 73 h earlier.
    expect(checkpointDueAt(new Date("2026-10-27T22:59:00Z"), -3)).toEqual(new Date("2026-10-24T21:59:00Z"));
    // On the day of the change itself: 23:59 on the 25th (winter), J−1 at 23:59 on the 24th (summer).
    expect(checkpointDueAt(new Date("2026-10-25T22:59:00Z"), -1)).toEqual(new Date("2026-10-24T21:59:00Z"));
    // And in spring (29 March 2026): 71 h.
    expect(checkpointDueAt(new Date("2026-03-30T21:59:00Z"), -3)).toEqual(new Date("2026-03-27T22:59:00Z"));
  });
});

describe("the checkpoints' rules (M3-05b)", () => {
  const deadline = new Date("2026-10-09T22:00:00Z");
  const now = new Date("2026-10-02T08:00:00Z");
  const at = (iso: string) => new Date(iso);

  it("refuses a date at or before now, then one at or after the deadline", () => {
    expect(checkpointRefusal(now, deadline, now)).toBe("due_past");
    expect(checkpointRefusal(at("2026-10-01T08:00:00Z"), deadline, now)).toBe("due_past");
    expect(checkpointRefusal(deadline, deadline, now)).toBe("due_after_deadline");
    expect(checkpointRefusal(at("2026-10-12T08:00:00Z"), deadline, now)).toBe("due_after_deadline");
    expect(checkpointRefusal(at("2026-10-05T08:00:00Z"), deadline, now)).toBeNull();
  });

  it("is void once its date is no longer before the deadline", () => {
    expect(isVoidCheckpoint(at("2026-10-09T21:59:59Z"), deadline)).toBe(false);
    expect(isVoidCheckpoint(deadline, deadline)).toBe(true);
  });

  it("fires at its date, once, never void, never on a draft, a project graded none or archived", () => {
    const due = at("2026-10-05T08:00:00Z");
    const later = at("2026-10-05T08:00:01Z");
    const project = { deadlineAt: deadline, state: "published", gradingMode: "auto", archivedAt: null };
    const open = { dueAt: due, dispatchedAt: null };
    expect(checkpointPass(open, project, at("2026-10-05T07:59:59Z"))).toBeNull();
    expect(checkpointPass(open, project, later)).toBe("dispatch");
    expect(checkpointPass(open, { ...project, gradingMode: "criteria" }, later)).toBe("milestone");
    expect(checkpointPass({ dueAt: due, dispatchedAt: later }, project, later)).toBeNull();
    expect(checkpointPass(open, { ...project, deadlineAt: due }, later)).toBeNull();
    expect(checkpointPass(open, { ...project, state: "draft" }, later)).toBeNull();
    expect(checkpointPass(open, { ...project, gradingMode: "none" }, later)).toBeNull();
    expect(checkpointPass(open, { ...project, archivedAt: later }, later)).toBeNull();
  });
});

describe("checkpointTag", () => {
  it("turns a French phrase into a tag", () => {
    expect(checkpointTag("fin de la séance (2 périodes)")).toBe("fin-de-la-seance-2-periodes");
    expect(checkpointTag("  Étape n°1 !  ")).toBe("etape-n-1");
    expect(checkpointTag("Œuvre finale")).toBe("oeuvre-finale");
    expect(checkpointTag("İstanbul")).toBe("istanbul");
  });

  it("leaves a text that already is a tag as it is", () => {
    for (const tag of ["deux-periodes", "milestone_1", "a--b", "m1_", "a-", "x_-"]) expect(checkpointTag(tag)).toBe(tag);
  });

  it("starts with a letter or a digit", () => {
    expect(checkpointTag("_-draft")).toBe("draft");
  });

  it("is empty when nothing is usable", () => {
    expect(checkpointTag("—?! ()")).toBe("");
  });

  it("caps the tag without leaving a dash at the cut", () => {
    expect(checkpointTag("x".repeat(80))).toHaveLength(CHECKPOINT_NAME_MAX);
    expect(checkpointTag(`${"x".repeat(CHECKPOINT_NAME_MAX - 1)} y`)).toBe("x".repeat(CHECKPOINT_NAME_MAX - 1));
  });
});
