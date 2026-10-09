import { describe, expect, it } from "vitest";

import {
  CONDITION_KIND_ORDER,
  CONDITION_KINDS,
  announcedConditionsOn,
  conditionsAllowedFor,
  conditionsByKind,
  imposedConditions,
  type ConditionsInput,
} from "./evaluationConditions.js";

const base = (over: Partial<ConditionsInput> = {}, settings: Partial<ConditionsInput["settings"]> = {}): ConditionsInput => ({
  mode: "exam",
  durationS: null,
  closesAt: null,
  timeBonusPercent: 0,
  ...over,
  settings: { navigation: "free", timing: "manual", logVisibility: false, ...settings },
});

const keys = (input: ConditionsInput) => imposedConditions(input).map((c) => c.key);

describe("conditionsAllowedFor (ADR-079)", () => {
  it("allows an exam and an exercise, never a poll", () => {
    expect(conditionsAllowedFor("exam")).toBe(true);
    expect(conditionsAllowedFor("exercise")).toBe(true);
    expect(conditionsAllowedFor("poll")).toBe(false);
  });
});

describe("announcedConditionsOn (ADR-079)", () => {
  it("reads the stored list, none when absent, and none on a poll", () => {
    const list = [{ kind: "allowed", text: "Notes" }];
    expect(announcedConditionsOn("exam", list)).toEqual(list);
    expect(announcedConditionsOn("exercise", undefined)).toEqual([]);
    expect(announcedConditionsOn("poll", list)).toEqual([]);
  });
});

describe("imposedConditions (ADR-079)", () => {
  it("states only one attempt and the autosave when nothing else is set", () => {
    expect(imposedConditions(base())).toEqual([
      { key: "attempts", kind: "info", maxAttempts: 1 },
      { key: "autosave", kind: "info" },
    ]);
  });

  it("says nothing for a poll, whatever its row holds", () => {
    expect(
      imposedConditions(base({ mode: "poll" }, { calculator: "scientific", negativeMarking: true, logVisibility: true })),
    ).toEqual([]);
  });

  it("names the trusted clients in force as forbidding other applications, on an exam only", () => {
    expect(imposedConditions(base({}, { safeExamBrowser: true, kiosk: true }))[0]).toEqual({
      key: "trusted_client",
      kind: "forbidden",
      clients: ["seb", "kiosk"],
    });
    expect(keys(base({ mode: "exercise" }, { safeExamBrowser: true }))).not.toContain("trusted_client");
  });

  it("states a provided calculator, and nothing at all for `none`", () => {
    expect(imposedConditions(base({}, { calculator: "standard" }))[0]).toEqual({
      key: "calculator",
      kind: "provided",
      calculator: "standard",
    });
    expect(keys(base({}, { calculator: "none" }))).not.toContain("calculator");
    expect(keys(base())).not.toContain("calculator");
  });

  it("states a provided notepad, and that copy-paste is off in it only when it is (ADR-090)", () => {
    expect(keys(base({}, { notepad: "provided" }))).toContain("notepad");
    expect(keys(base({}, { notepad: "provided" }))).not.toContain("notepad_no_clipboard");
    expect(imposedConditions(base({}, { calculator: "standard", notepad: "provided_no_clipboard" })).slice(0, 3)).toEqual([
      { key: "calculator", kind: "provided", calculator: "standard" },
      { key: "notepad", kind: "provided" },
      { key: "notepad_no_clipboard", kind: "provided" },
    ]);
    expect(keys(base({}, { notepad: "none" }))).not.toContain("notepad");
    expect(keys(base({ mode: "poll" }, { notepad: "provided" }))).toEqual([]);
  });

  it("states the duration with the student's bonus, or the deadline", () => {
    expect(imposedConditions(base({ durationS: 2700, timeBonusPercent: 25 }, { timing: "duration" }))).toContainEqual({
      key: "duration",
      kind: "info",
      durationS: 2700,
      bonusPercent: 25,
    });
    expect(keys(base({}, { timing: "duration" }))).not.toContain("duration");
    const closesAt = "2026-10-08T10:00:00.000Z";
    expect(imposedConditions(base({ closesAt }, { timing: "deadline" }))).toContainEqual({
      key: "deadline",
      kind: "info",
      closesAt,
      bonusPercent: 0,
    });
    expect(keys(base({}, { timing: "manual" }))).not.toContain("deadline");
  });

  it("states the end of a window and a safety deadline too, the bonus pushing all but the latter (ADR-086)", () => {
    const closesAt = "2026-10-08T10:00:00.000Z";
    const line = (timing: "manual" | "duration" | "deadline") =>
      imposedConditions(base({ closesAt, durationS: 600, timeBonusPercent: 25 }, { timing })).find(
        (c) => c.key === "deadline",
      );
    expect(line("manual")).toEqual({ key: "deadline", kind: "info", closesAt, bonusPercent: 0 });
    for (const timing of ["duration", "deadline"] as const) {
      expect(line(timing)).toEqual({ key: "deadline", kind: "info", closesAt, bonusPercent: 25 });
    }
  });

  it("states the retakes of an exercise, and one attempt on an exam whatever its row says", () => {
    const retakes = { enabled: true, keep: "best" as const, maxAttempts: null };
    expect(imposedConditions(base({ mode: "exercise" }, { retakes }))).toContainEqual({
      key: "attempts",
      kind: "info",
      maxAttempts: null,
    });
    expect(imposedConditions(base({ mode: "exam" }, { retakes }))).toContainEqual({
      key: "attempts",
      kind: "info",
      maxAttempts: 1,
    });
  });

  it("states a locked navigation, negative marking and the visibility journal", () => {
    expect(keys(base({}, { navigation: "milestones", negativeMarking: true, logVisibility: true }))).toEqual([
      "attempts",
      "navigation",
      "negative_marking",
      "visibility_logged",
      "autosave",
    ]);
    expect(keys(base({}, { navigation: "free" }))).not.toContain("navigation");
  });

  it("draws the lines in the fixed order", () => {
    const all = keys(
      base(
        { durationS: 600 },
        {
          safeExamBrowser: true,
          calculator: "scientific",
          notepad: "provided_no_clipboard",
          timing: "duration",
          navigation: "forward_only",
          negativeMarking: true,
          logVisibility: true,
        },
      ),
    );
    expect(all).toEqual([
      "trusted_client",
      "calculator",
      "notepad",
      "notepad_no_clipboard",
      "duration",
      "attempts",
      "navigation",
      "negative_marking",
      "visibility_logged",
      "autosave",
    ]);
  });
});

describe("conditionsByKind (ADR-079 §6, amended 2026-10-08)", () => {
  const announced = [
    { kind: "info" as const, text: "Answer in French" },
    { kind: "allowed" as const, text: "One A4 sheet" },
    { kind: "forbidden" as const, text: "Phones" },
    { kind: "allowed" as const, text: "A dictionary" },
    { kind: "forbidden" as const, text: "Smart watches" },
  ];

  it("orders every kind, each once", () => {
    expect([...CONDITION_KIND_ORDER].sort()).toEqual([...CONDITION_KINDS].sort());
  });

  it("groups forbidden, allowed, provided, then good to know", () => {
    const groups = conditionsByKind(announced, imposedConditions(base({}, { calculator: "standard" })));
    expect(groups.map((g) => g.kind)).toEqual(["forbidden", "allowed", "provided", "info"]);
  });

  it("keeps the teacher's order inside a kind, then the platform's fixed order, apart", () => {
    const imposed = imposedConditions(base({}, { safeExamBrowser: true, negativeMarking: true }));
    const [forbidden, allowed, info] = conditionsByKind(announced, imposed);
    expect(forbidden).toEqual({
      kind: "forbidden",
      announced: [announced[2], announced[4]],
      imposed: [{ key: "trusted_client", kind: "forbidden", clients: ["seb"] }],
    });
    expect(allowed!.announced.map((l) => l.text)).toEqual(["One A4 sheet", "A dictionary"]);
    expect(allowed!.imposed).toEqual([]);
    expect(info!.announced.map((l) => l.text)).toEqual(["Answer in French"]);
    expect(info!.imposed.map((l) => l.key)).toEqual(["attempts", "negative_marking", "autosave"]);
  });

  it("leaves out a kind with no line, and returns nothing for no line at all", () => {
    expect(conditionsByKind([{ kind: "provided", text: "A formula sheet" }], []).map((g) => g.kind)).toEqual([
      "provided",
    ]);
    expect(conditionsByKind([], [])).toEqual([]);
  });

  it("drops a kind whose only lines the caller filtered out (the ready screen's omit)", () => {
    const imposed = imposedConditions(base({}, { calculator: "scientific" })).filter((l) => l.key !== "calculator");
    expect(conditionsByKind([], imposed).map((g) => g.kind)).toEqual(["info"]);
  });
});
