import { describe, expect, it } from "vitest";

import { checkpointDueAt, planCheckpointReviewDispatch, planFinalReviewDispatch } from "./reviewDispatch.js";

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
