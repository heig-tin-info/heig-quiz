import { describe, expect, it } from "vitest";

import {
  clockChoiceOf,
  clockFields,
  clockPatch,
  clockSettingsFor,
  CLOCK_MODES,
  DEFAULT_LIMIT_S,
  liveLobbies,
  type ClockChoice,
  type ClockSettings,
} from "./clockMode.js";

/** The table of ADR-086 §1, row by row. */
const TABLE: readonly [ClockChoice, ClockSettings, readonly string[]][] = [
  [{ mode: "scheduled", limited: false }, { timing: "deadline", lobby: "skip" }, ["opensAt", "closesAt"]],
  [{ mode: "scheduled", limited: true }, { timing: "duration", lobby: "skip" }, ["opensAt", "closesAt", "durationS"]],
  [{ mode: "live", limited: false }, { timing: "manual", lobby: "manual" }, ["opensAt", "closesAt"]],
  [{ mode: "live", limited: true }, { timing: "duration", lobby: "manual" }, ["opensAt", "durationS"]],
];

const ALL_SETTINGS: ClockSettings[] = (["duration", "deadline", "manual"] as const).flatMap((timing) =>
  (["skip", "auto", "manual"] as const).map((lobby) => ({ timing, lobby })),
);

const ALL_CHOICES: ClockChoice[] = CLOCK_MODES.flatMap((mode) => [
  { mode, limited: false },
  { mode, limited: true },
]);

describe("the clock modes (ADR-086)", () => {
  it.each(TABLE)("maps %j to its settings and its fields", (choice, settings, fields) => {
    expect(clockSettingsFor(choice, settings)).toEqual(settings);
    expect(clockChoiceOf(settings)).toEqual(choice);
    expect(clockFields(choice)).toEqual(fields);
  });

  it("reads every stored pair as one mode, a waiting room meaning Live", () => {
    expect(clockChoiceOf({ timing: "duration", lobby: "auto" })).toEqual({ mode: "live", limited: true });
    expect(clockChoiceOf({ timing: "deadline", lobby: "manual" })).toEqual({ mode: "live", limited: false });
    // The exercise created bare: no waiting room, closed by the teacher.
    expect(clockChoiceOf({ timing: "manual", lobby: "skip" })).toEqual({ mode: "live", limited: false });
    // Live with a limit and no waiting room cannot be stored apart from Scheduled.
    expect(clockChoiceOf({ timing: "duration", lobby: "skip" })).toEqual({ mode: "scheduled", limited: true });
  });

  it("round-trips: a choice written from any stored pair reads back as itself", () => {
    for (const current of ALL_SETTINGS) {
      for (const choice of ALL_CHOICES) {
        expect(clockChoiceOf(clockSettingsFor(choice, current))).toEqual(choice);
      }
    }
  });

  it("round-trips the other way for every pair the mode writes", () => {
    for (const current of ALL_SETTINGS) {
      const choice = clockChoiceOf(current);
      const written = clockSettingsFor(choice, current);
      expect(clockSettingsFor(clockChoiceOf(written), written)).toEqual(written);
    }
  });

  it("keeps a live evaluation's waiting room from the advanced options, while it is offered", () => {
    expect(clockSettingsFor({ mode: "live", limited: true }, { timing: "manual", lobby: "auto" })).toEqual({
      timing: "duration",
      lobby: "auto",
    });
    // Without a waiting room, a limit would make it Scheduled: the room comes back.
    expect(clockSettingsFor({ mode: "live", limited: true }, { timing: "manual", lobby: "skip" })).toEqual({
      timing: "duration",
      lobby: "manual",
    });
    // Coming from Scheduled, whose `skip` was never a choice: the room you open.
    expect(clockSettingsFor({ mode: "live", limited: false }, { timing: "deadline", lobby: "skip" })).toEqual({
      timing: "manual",
      lobby: "manual",
    });
  });

  it("offers no waiting-room-less Live with a limit", () => {
    expect(liveLobbies(true)).toEqual(["manual", "auto"]);
    expect(liveLobbies(false)).toEqual(["manual", "auto", "skip"]);
  });
});

describe("clockPatch", () => {
  const scheduled = { timing: "deadline", lobby: "skip", durationS: null, closesAt: "2026-10-09T16:00:00.000Z" } as const;

  it("starts a limit turned on from the default, and keeps one already stored", () => {
    expect(clockPatch({ mode: "scheduled", limited: true }, scheduled)).toEqual({
      settings: { timing: "duration", lobby: "skip" },
      durationS: DEFAULT_LIMIT_S,
    });
    expect(clockPatch({ mode: "scheduled", limited: true }, { ...scheduled, durationS: 600 })).toEqual({
      settings: { timing: "duration", lobby: "skip" },
    });
  });

  it("clears an end the choice no longer shows, since the ticker would still close on it", () => {
    expect(clockPatch({ mode: "live", limited: true }, { ...scheduled, durationS: 600 })).toEqual({
      settings: { timing: "duration", lobby: "manual" },
      closesAt: null,
    });
    // Live without a limit keeps it as its safety deadline.
    expect(clockPatch({ mode: "live", limited: false }, scheduled)).toEqual({
      settings: { timing: "manual", lobby: "manual" },
    });
  });

  it("clears nothing on a template, which has no dates", () => {
    const { closesAt: _, ...template } = scheduled;
    expect(clockPatch({ mode: "live", limited: true }, { ...template, durationS: 600 })).toEqual({
      settings: { timing: "duration", lobby: "manual" },
    });
  });
});
