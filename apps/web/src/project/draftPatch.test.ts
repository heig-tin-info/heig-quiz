import { describe, expect, it } from "vitest";

import { applyChange, draftPatch, draftView, type DraftView } from "./draftPatch";

const START = "2026-10-20T08:00:00.000Z";
const DEADLINE = "2026-10-27T22:00:00.000Z";

const manualDate: DraftView = { publishMode: "manual", kind: "date", startAt: null, deadlineAt: DEADLINE, days: null };
const manualDays: DraftView = { publishMode: "manual", kind: "duration", startAt: null, deadlineAt: null, days: 7 };
const scheduled: DraftView = { publishMode: "scheduled", kind: "date", startAt: START, deadlineAt: DEADLINE, days: null };

describe("draftView", () => {
  it("reads a manual draft by date, by duration, and a scheduled one", () => {
    expect(draftView({ publishMode: "manual", startAt: "2026-10-11T08:00:00.000Z", deadlineAt: DEADLINE, durationMinutes: null })).toEqual(manualDate);
    // The deadline of a duration is provisional: not shown, and whole days.
    expect(draftView({ publishMode: "manual", startAt: START, deadlineAt: DEADLINE, durationMinutes: 7 * 1440 })).toEqual(manualDays);
    expect(draftView({ publishMode: "scheduled", startAt: START, deadlineAt: DEADLINE, durationMinutes: null })).toEqual(scheduled);
  });
});

describe("switching the mode", () => {
  it("to scheduled writes nothing, and keeps the date as the deadline on offer", () => {
    expect(draftPatch(manualDate, { type: "mode", mode: "scheduled" })).toBeNull();
    expect(applyChange(manualDate, { type: "mode", mode: "scheduled" })).toEqual({ ...scheduled, startAt: null });
    // A duration is not a date.
    expect(applyChange(manualDays, { type: "mode", mode: "scheduled" })).toEqual({ ...scheduled, startAt: null, deadlineAt: null });
  });

  it("back to manual sends the mode alone and keeps the deadline", () => {
    expect(draftPatch(scheduled, { type: "mode", mode: "manual" })).toEqual({ publishMode: "manual" });
    expect(applyChange(scheduled, { type: "mode", mode: "manual" })).toEqual(manualDate);
  });
});

describe("a scheduled publication", () => {
  it("needs the pair: nothing while one date is missing, then all three fields at once", () => {
    const fresh = applyChange(manualDays, { type: "mode", mode: "scheduled" });
    expect(draftPatch(fresh, { type: "start", at: START })).toBeNull();
    const withStart = applyChange(fresh, { type: "start", at: START });
    expect(draftPatch(withStart, { type: "deadline", at: DEADLINE })).toEqual({
      publishMode: "scheduled",
      startAt: START,
      deadlineAt: DEADLINE,
      durationMinutes: null,
    });
  });

  it("sends the whole pair when one of its dates moves, and nothing when one is cleared", () => {
    expect(draftPatch(scheduled, { type: "start", at: "2026-10-21T08:00:00.000Z" })).toEqual({
      publishMode: "scheduled",
      startAt: "2026-10-21T08:00:00.000Z",
      deadlineAt: DEADLINE,
      durationMinutes: null,
    });
    expect(draftPatch(scheduled, { type: "deadline", at: null })).toBeNull();
  });
});

describe("a manual publication", () => {
  it("switching the kind writes nothing and empties the other one", () => {
    expect(draftPatch(manualDate, { type: "kind", kind: "duration" })).toBeNull();
    expect(applyChange(manualDate, { type: "kind", kind: "duration" })).toEqual({ ...manualDays, days: null });
    expect(draftPatch(manualDays, { type: "kind", kind: "date" })).toBeNull();
    expect(applyChange(manualDays, { type: "kind", kind: "date" })).toEqual({ ...manualDate, deadlineAt: null });
  });

  it("date to duration: the days, in minutes; nothing while they are missing or out of bounds", () => {
    const toDuration = applyChange(manualDate, { type: "kind", kind: "duration" });
    expect(draftPatch(toDuration, { type: "days", days: 14 })).toEqual({ durationMinutes: 14 * 1440 });
    expect(draftPatch(toDuration, { type: "days", days: null })).toBeNull();
    expect(draftPatch(toDuration, { type: "days", days: 0 })).toBeNull();
    expect(draftPatch(toDuration, { type: "days", days: 401 })).toBeNull();
    expect(draftPatch(toDuration, { type: "days", days: 1.5 })).toBeNull();
  });

  it("duration to date: the date and no duration", () => {
    const toDate = applyChange(manualDays, { type: "kind", kind: "date" });
    expect(draftPatch(toDate, { type: "deadline", at: DEADLINE })).toEqual({ deadlineAt: DEADLINE, durationMinutes: null });
    expect(draftPatch(toDate, { type: "deadline", at: null })).toBeNull();
  });
});
