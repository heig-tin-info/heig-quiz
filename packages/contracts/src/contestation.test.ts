import { describe, expect, it } from "vitest";

import {
  CONTESTATION_TEXT_MAX,
  ContestationFileBody,
  ContestationReply,
  ContestationWindowBody,
} from "./contestation.js";
import { ContestationResolveBody } from "./grading.js";

/*
 * The bodies of a contestation (ADR-139, F-GRADE-08): the student's one
 * request, the owner's one answer and the owner's two acts on the window.
 */
describe("the student's request", () => {
  it("needs a reason, trimmed", () => {
    expect(ContestationFileBody.parse({ reason: "  the unit was right  " })).toEqual({
      reason: "the unit was right",
    });
    expect(ContestationFileBody.safeParse({ reason: "   " }).success).toBe(false);
    expect(ContestationFileBody.safeParse({}).success).toBe(false);
  });

  it("caps the reason and the reply at the same length", () => {
    const full = "a".repeat(CONTESTATION_TEXT_MAX);
    expect(ContestationFileBody.safeParse({ reason: full }).success).toBe(true);
    expect(ContestationFileBody.safeParse({ reason: `${full}a` }).success).toBe(false);
    expect(ContestationReply.safeParse(full).success).toBe(true);
    expect(ContestationReply.safeParse(`${full}a`).success).toBe(false);
  });
});

describe("the owner's answer", () => {
  const criteria = [{ id: "c1", points: 1 }];
  const ok = (body: unknown) => ContestationResolveBody.safeParse(body).success;

  it("accepts without a word when the points stay as they are", () => {
    expect(ContestationResolveBody.parse({ verdict: "accepted" })).toEqual({ verdict: "accepted", reply: "" });
    expect(ok({ verdict: "accepted", reply: "  " })).toBe(true);
  });

  it("explains new points, by the total or by the criteria", () => {
    expect(ok({ verdict: "accepted", points: 2 })).toBe(false);
    expect(ok({ verdict: "accepted", criteria })).toBe(false);
    expect(ok({ verdict: "accepted", points: 2, reply: "  " })).toBe(false);
    expect(ok({ verdict: "accepted", points: 2, reply: "The unit was right." })).toBe(true);
    expect(ok({ verdict: "accepted", criteria, reply: "The unit was right." })).toBe(true);
  });

  it("never takes both the total and the criteria", () => {
    expect(ok({ verdict: "accepted", points: 2, criteria, reply: "Both." })).toBe(false);
  });

  it("explains a refusal, which gives no points", () => {
    expect(ok({ verdict: "refused" })).toBe(false);
    expect(ok({ verdict: "refused", reply: "The key stands." })).toBe(true);
    expect(ok({ verdict: "refused", reply: "The key stands.", points: 2 })).toBe(false);
    expect(ok({ verdict: "refused", reply: "The key stands.", criteria })).toBe(false);
  });

  it("puts a missing reply on the reply's own path", () => {
    const refused = ContestationResolveBody.safeParse({ verdict: "refused" });
    expect(refused.error?.issues.map((issue) => issue.path)).toEqual([["reply"]]);
  });

  it("knows two verdicts only", () => {
    expect(ok({ verdict: "open", reply: "Later." })).toBe(false);
  });
});

describe("the owner's acts on the window", () => {
  it("closes it, or moves it to an instant", () => {
    expect(ContestationWindowBody.safeParse({ action: "close" }).success).toBe(true);
    expect(ContestationWindowBody.safeParse({ action: "extend", closesAt: "2026-12-01T08:00:00.000Z" }).success).toBe(
      true,
    );
  });

  it("refuses an extension without an instant, and any other act", () => {
    expect(ContestationWindowBody.safeParse({ action: "extend" }).success).toBe(false);
    expect(ContestationWindowBody.safeParse({ action: "extend", closesAt: "tomorrow" }).success).toBe(false);
    expect(ContestationWindowBody.safeParse({ action: "open" }).success).toBe(false);
  });
});
