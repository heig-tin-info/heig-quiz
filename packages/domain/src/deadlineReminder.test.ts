import { describe, expect, it } from "vitest";

import { DEADLINE_REMINDER_MS, reminderClaimAfterMove } from "./deadlineReminder.js";

const now = new Date("2026-10-02T08:00:00Z");
const plus = (ms: number) => new Date(now.getTime() + ms);
const HOUR = 3_600_000;

describe("the day-before reminder of a deadline (F-NOTIF-06, F-NOTIF-13)", () => {
  it("is due 24 hours before the end", () => {
    expect(DEADLINE_REMINDER_MS).toBe(24 * HOUR);
  });

  it("re-arms a moved deadline only when it is more than a day away, and never re-sends otherwise", () => {
    const sent = new Date("2026-10-01T22:00:00Z");
    expect(reminderClaimAfterMove(sent, plus(2 * 24 * HOUR), now)).toBeNull();
    expect(reminderClaimAfterMove(sent, plus(DEADLINE_REMINDER_MS), now)).toEqual(sent);
    expect(reminderClaimAfterMove(sent, plus(20 * HOUR), now)).toEqual(sent);
    // Still owed on a deadline brought nearer: the scan sends it.
    expect(reminderClaimAfterMove(null, plus(20 * HOUR), now)).toBeNull();
  });
});
