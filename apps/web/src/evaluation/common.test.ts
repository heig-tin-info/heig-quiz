import { describe, expect, it } from "vitest";

import { en } from "../i18n/en";
import type { TFunction } from "../i18n";
import { awaitsScheduling, evaluationBadgeLabel, missedScheduling, type ScheduleFacts } from "./common";

const t = ((key: keyof typeof en) => en[key]) as TFunction;
const NOW = Date.parse("2026-10-14T10:00:00.000Z");
const LATER = "2026-12-03T15:15:00.000Z";
const EARLIER = "2026-10-01T08:00:00.000Z";
const facts = (over: Partial<ScheduleFacts> = {}): ScheduleFacts => ({
  state: "draft",
  clock: "scheduled",
  opensAt: LATER,
  ...over,
});

describe("a draft whose dates are set but which nobody scheduled (#857)", () => {
  it("says it is not scheduled, whether its opening is to come or gone by", () => {
    expect(evaluationBadgeLabel(facts(), t)).toBe("draft · not scheduled");
    expect(evaluationBadgeLabel(facts({ opensAt: EARLIER }), t)).toBe("draft · not scheduled");
  });

  it("leaves a scheduled evaluation, a Live draft and an undated draft their own word", () => {
    expect(evaluationBadgeLabel(facts({ state: "scheduled" }), t)).toBe("scheduled");
    expect(evaluationBadgeLabel(facts({ clock: "live" }), t)).toBe("draft");
    expect(evaluationBadgeLabel(facts({ opensAt: null }), t)).toBe("draft");
  });

  it("can be scheduled only while its opening is to come", () => {
    expect(awaitsScheduling(facts(), NOW)).toBe(true);
    expect(awaitsScheduling(facts({ opensAt: EARLIER }), NOW)).toBe(false);
    expect(awaitsScheduling(facts({ clock: "live" }), NOW)).toBe(false);
    expect(awaitsScheduling(facts({ state: "scheduled" }), NOW)).toBe(false);
  });

  it("missed its opening once that date has come, never both to schedule and missed (#921)", () => {
    expect(missedScheduling(facts({ opensAt: EARLIER }), NOW)).toBe(true);
    expect(missedScheduling(facts({ opensAt: new Date(NOW).toISOString() }), NOW)).toBe(true);
    expect(missedScheduling(facts(), NOW)).toBe(false);
    expect(missedScheduling(facts({ opensAt: EARLIER, clock: "live" }), NOW)).toBe(false);
    expect(missedScheduling(facts({ opensAt: EARLIER, state: "scheduled" }), NOW)).toBe(false);
    expect(missedScheduling(facts({ opensAt: null }), NOW)).toBe(false);
  });
});
