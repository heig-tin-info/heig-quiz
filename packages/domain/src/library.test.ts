import { describe, expect, it } from "vitest";

import { attemptClosedReason, type GatedAttempt } from "./attemptGate.js";
import { GRACE_MS } from "./deadline.js";
import type { EvaluationModeName } from "./evaluationConfig.js";
import { MAX_PROVIDED_DOCUMENTS, providedDocumentsAllowedFor, providedDocumentsReadable } from "./library.js";

const now = new Date("2026-11-24T10:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);
const open: GatedAttempt = { state: "in_progress", afterDue: false, deadlineAt: later(60_000) };

describe("providedDocumentsAllowedFor (ADR-144 §7)", () => {
  it("allows an exam and an exercise, never a poll, at most ten documents", () => {
    expect(providedDocumentsAllowedFor("exam")).toBe(true);
    expect(providedDocumentsAllowedFor("exercise")).toBe(true);
    expect(providedDocumentsAllowedFor("poll")).toBe(false);
    expect(MAX_PROVIDED_DOCUMENTS).toBe(10);
  });
});

describe("providedDocumentsReadable (F-LIVE-15)", () => {
  const cases: [string, EvaluationModeName, string, GatedAttempt, Date, boolean][] = [
    ["an exam running, the attempt in progress", "exam", "running", open, now, true],
    ["an exercise running", "exercise", "running", open, now, true],
    ["no deadline (manual timing)", "exam", "running", { ...open, deadlineAt: null }, now, true],
    ["within the grace after the deadline", "exam", "running", { ...open, deadlineAt: now }, later(GRACE_MS), true],
    ["past the grace", "exam", "running", { ...open, deadlineAt: now }, later(GRACE_MS + 1), false],
    ["a paused exam", "exam", "paused", open, now, false],
    ["a paused exercise", "exercise", "paused", open, now, false],
    ["the lobby", "exam", "lobby", open, now, false],
    ["an attempt not started", "exam", "running", { ...open, state: "not_started" }, now, false],
    ["a submitted attempt", "exam", "running", { ...open, state: "submitted" }, now, false],
    ["an expired attempt", "exam", "running", { ...open, state: "expired" }, now, false],
    ["a closed exam", "exam", "closed", open, now, false],
    ["a released exam", "exam", "released", open, now, false],
    ["a poll", "poll", "running", open, now, false],
    ["an exercise's practice after its due date", "exercise", "closed", { ...open, afterDue: true }, now, true],
    ["an exercise's practice past its own deadline", "exercise", "closed", { ...open, afterDue: true, deadlineAt: now }, later(GRACE_MS + 1), false],
    ["an exercise's practice handed in", "exercise", "closed", { ...open, afterDue: true, state: "submitted" }, now, false],
    ["an exam's blank practice after the release", "exam", "released", { ...open, afterDue: true }, now, false],
  ];
  it.each(cases)("%s", (_, mode, evaluationState, attempt, at, expected) => {
    expect(providedDocumentsReadable({ mode, evaluationState, attempt }, at)).toBe(expected);
  });
});

describe("attemptClosedReason (§4.7)", () => {
  it("lets a paused evaluation take presence and a hand-in, never an answer", () => {
    expect(attemptClosedReason("paused", open, now, "answer")).toBe("paused");
    expect(attemptClosedReason("paused", open, now, "presence")).toBeNull();
    expect(attemptClosedReason("closed", open, now, "submit")).toBeNull();
  });

  it("names a finished attempt and a finished evaluation", () => {
    expect(attemptClosedReason("running", { ...open, state: "submitted" }, now, "submit")).toBe("submitted");
    expect(attemptClosedReason("running", { ...open, state: "expired" }, now, "presence")).toBe("deadline");
    expect(attemptClosedReason("closed", open, now, "presence")).toBe("evaluation_closed");
    expect(attemptClosedReason("closed", { ...open, afterDue: true }, now, "answer")).toBeNull();
  });
});
