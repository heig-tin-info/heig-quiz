import { describe, expect, it } from "vitest";

import { ActivityList, ActivitySummary } from "./activity.js";
import { NotificationPayload } from "./notifications.js";

const ID = "11111111-1111-4111-8111-111111111111";

const evaluation = {
  kind: "evaluation",
  id: ID,
  title: "Test 1",
  mode: "exam",
  state: "scheduled",
  classroom: { id: ID, name: "PRG1-2026", courseCode: "PRG1" },
  takeHome: false,
  opensAt: "2026-10-01T08:00:00.000Z",
  closesAt: null,
  startedAt: null,
  updatedAt: "2026-09-30T08:00:00.000Z",
} as const;

describe("ActivitySummary (ADR-035 §2)", () => {
  it("reads an evaluation row, its mode kept", () => {
    const row = ActivitySummary.parse(evaluation);
    expect(row.kind).toBe("evaluation");
    expect(row.mode).toBe("exam");
  });

  it("keeps an anonymous poll as an evaluation, with no classroom", () => {
    expect(ActivityList.parse([{ ...evaluation, mode: "poll", classroom: null }])).toHaveLength(1);
  });

  it("refuses a row without its kind, or of a kind it does not know", () => {
    const { kind: _kind, ...bare } = evaluation;
    expect(ActivitySummary.safeParse(bare).success).toBe(false);
    expect(ActivitySummary.safeParse({ ...evaluation, kind: "project" }).success).toBe(false);
  });
});

describe("activity_available payload (ADR-030, addendum 2026-09-30)", () => {
  it("is kind-neutral: the kind, the id and the title of the activity", () => {
    const payload = {
      kind: "activity_available",
      activityKind: "evaluation",
      activityId: ID,
      activityTitle: "Exercise 3",
    };
    expect(NotificationPayload.parse(payload)).toEqual(payload);
  });
});
