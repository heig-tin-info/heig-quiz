import { describe, expect, it } from "vitest";

import {
  isEmptyDiff,
  itemListDiff,
  templateBehind,
  templatePullable,
  type PullItem,
} from "./templatePull.js";

const item = (position: number, questionId: string, extra: Partial<PullItem> = {}): PullItem => ({
  position,
  questionId,
  versionNumber: 1,
  points: 1,
  milestone: false,
  bonus: false,
  intro: null,
  ...extra,
});

describe("templateBehind / templatePullable", () => {
  it("is behind only with an origin revision below the template's", () => {
    expect(templateBehind({ originRevision: 1, templateRevision: 2 })).toBe(true);
    expect(templateBehind({ originRevision: 2, templateRevision: 2 })).toBe(false);
    expect(templateBehind({ originRevision: null, templateRevision: 2 })).toBe(false);
    expect(templateBehind({ originRevision: 1, templateRevision: null })).toBe(false);
  });

  it("is pullable where the item list is editable: draft or scheduled, no attempt", () => {
    const behind = { originRevision: 1, templateRevision: 3 };
    expect(templatePullable({ ...behind, state: "draft", attemptCount: 0 })).toBe(true);
    expect(templatePullable({ ...behind, state: "scheduled", attemptCount: 0 })).toBe(true);
    expect(templatePullable({ ...behind, state: "draft", attemptCount: 1 })).toBe(false);
    for (const state of ["lobby", "running", "paused", "closed", "grading", "released"] as const) {
      expect(templatePullable({ ...behind, state, attemptCount: 0 })).toBe(false);
    }
    expect(
      templatePullable({ originRevision: 3, templateRevision: 3, state: "draft", attemptCount: 0 }),
    ).toBe(false);
  });
});

describe("itemListDiff", () => {
  it("finds nothing between two equal lists", () => {
    const list = [item(0, "a"), item(1, "b")];
    const diff = itemListDiff(list, list.map((i) => ({ ...i })));
    expect(diff).toEqual({ added: [], removed: [], changed: [], reordered: false });
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("names added, removed and changed items, both ways", () => {
    const diff = itemListDiff(
      [item(0, "a"), item(1, "b"), item(2, "local")],
      [item(0, "a", { versionNumber: 2 }), item(1, "b", { points: 3, milestone: true }), item(2, "new")],
    );
    expect(diff.added.map((i) => i.questionId)).toEqual(["new"]);
    expect(diff.removed.map((i) => i.questionId)).toEqual(["local"]);
    expect(diff.changed.map((c) => [c.from.questionId, c.to.versionNumber, c.to.points])).toEqual([
      ["a", 2, 1],
      ["b", 1, 3],
    ]);
    expect(diff.reordered).toBe(false);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("sees a bonus flag that changed (ADR-052)", () => {
    const diff = itemListDiff([item(0, "a")], [item(0, "a", { bonus: true })]);
    expect(diff.changed.map((c) => c.to.bonus)).toEqual([true]);
  });

  it("sees an intro added, edited or removed as a change of the item (ADR-084)", () => {
    const read = item(0, "a", { intro: "Read chapter 8." });
    expect(itemListDiff([item(0, "a")], [read]).changed).toHaveLength(1);
    expect(itemListDiff([read], [item(0, "a", { intro: "Read chapter 9." })]).changed).toHaveLength(1);
    expect(itemListDiff([read], [item(0, "a")]).changed).toHaveLength(1);
    expect(isEmptyDiff(itemListDiff([read], [{ ...read }]))).toBe(true);
  });

  it("sees a change of order among the questions both sides hold", () => {
    const diff = itemListDiff([item(0, "a"), item(1, "b"), item(2, "c")], [item(0, "c"), item(1, "a"), item(2, "b")]);
    expect(diff.reordered).toBe(true);
    expect(diff.changed).toEqual([]);
  });

  it("does not call a removal a reordering", () => {
    const diff = itemListDiff([item(0, "a"), item(1, "x"), item(2, "b")], [item(0, "a"), item(1, "b")]);
    expect(diff.reordered).toBe(false);
    expect(diff.removed.map((i) => i.questionId)).toEqual(["x"]);
  });

  it("pairs a question held twice occurrence by occurrence", () => {
    const diff = itemListDiff([item(0, "a"), item(1, "a", { points: 2 })], [item(0, "a")]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([item(1, "a", { points: 2 })]);
  });
});
