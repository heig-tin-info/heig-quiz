import { describe, expect, it } from "vitest";

import { en } from "../i18n/en";
import type { TFunction } from "../i18n";
import { evaluationBadgeLabel, schedulingPhase, type ScheduleFacts } from "./common";

const t = ((key: keyof typeof en) => en[key]) as TFunction;
const NOW = Date.parse("2026-10-14T10:00:00.000Z");
const LATER = "2026-12-03T15:15:00.000Z";
const EARLIER = "2026-10-01T08:00:00.000Z";
const facts = (over: Partial<ScheduleFacts> = {}): ScheduleFacts => ({
  state: "draft",
  clock: "scheduled",
  opensAt: LATER,
  closesAt: null,
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

  it.each([
    ["opening to come", {}, "toSchedule"],
    ["opening passed", { opensAt: EARLIER }, "missed"],
    ["opening at this instant", { opensAt: new Date(NOW).toISOString() }, "missed"],
    ["opening passed, end to come", { opensAt: EARLIER, closesAt: LATER }, "missed"],
    ["both passed", { opensAt: EARLIER, closesAt: new Date(NOW - 1).toISOString() }, "over"],
    ["Live", { clock: "live" }, null],
    ["Live, passed", { clock: "live", opensAt: EARLIER }, null],
    ["scheduled", { state: "scheduled" }, null],
    ["undated", { opensAt: null }, null],
  ] as const)("its scheduling phase: %s (#921)", (_, over, phase) => {
    expect(schedulingPhase(facts(over), NOW)).toBe(phase);
  });
});
