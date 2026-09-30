import { describe, expect, it } from "vitest";

import {
  checkpointDueAt,
  GRADING_WORKFLOW_PATH,
  planCheckpointReviewDispatch,
  planFinalReviewDispatch,
  runKind,
} from "./reviewDispatch.js";

describe("planFinalReviewDispatch (GR-16)", () => {
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
});

describe("runKind (GR-16)", () => {
  it("classifies the dispatched grading run as llm", () => {
    expect(runKind({ event: "repository_dispatch", path: GRADING_WORKFLOW_PATH })).toBe("llm");
  });

  it("keeps push-triggered grading runs as ci (indicative tier)", () => {
    expect(runKind({ event: "push", path: GRADING_WORKFLOW_PATH })).toBe("ci");
  });

  it("never classifies a non-grading workflow as llm, even on dispatch", () => {
    // A student workflow listening to repository_dispatch must not be able
    // to impersonate the review pipeline.
    expect(runKind({ event: "repository_dispatch", path: ".github/workflows/own.yml" })).toBe("ci");
  });

  it("treats unknown events conservatively as ci", () => {
    expect(runKind({ event: "", path: GRADING_WORKFLOW_PATH })).toBe("ci");
  });
});
