import { describe, expect, it } from "vitest";

import { integrityIncidents, type JournalRow } from "./integrityIncidents.js";

const T0 = Date.parse("2026-10-09T08:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000);
const focus = (s: number, focused: boolean): JournalRow => ({ kind: "focus", at: at(s), details: { focused } });
const vis = (s: number, state: "hidden" | "visible"): JournalRow => ({
  kind: "visibility",
  at: at(s),
  details: { state },
});

describe("integrityIncidents", () => {
  it("pairs a loss with the next return", () => {
    expect(integrityIncidents([focus(10, false), focus(15, true)], null, at(60))).toEqual([
      { kind: "left", at: at(10), durationMs: 5000 },
    ]);
  });

  it("merges an overlapping blur and hidden tab into one absence, first loss to first return", () => {
    const rows = [focus(10, false), vis(11, "hidden"), vis(20, "visible"), focus(21, true)];
    expect(integrityIncidents(rows, null, at(60))).toEqual([{ kind: "left", at: at(10), durationMs: 10_000 }]);
  });

  it("drops an absence under one second, keeps one of exactly one second", () => {
    const rows = [focus(10, false), { ...focus(10, true), at: new Date(T0 + 10_999) }, focus(20, false), focus(21, true)];
    expect(integrityIncidents(rows, null, at(60))).toEqual([{ kind: "left", at: at(20), durationMs: 1000 }]);
  });

  it("caps an absence at the attempt's end, and ignores rows after it", () => {
    const rows = [vis(50, "hidden"), vis(90, "visible"), focus(95, false)];
    expect(integrityIncidents(rows, at(60), at(120))).toEqual([{ kind: "left", at: at(50), durationMs: 10_000 }]);
  });

  it("leaves an absence open while the attempt runs, once it is a second old", () => {
    expect(integrityIncidents([focus(10, false)], null, at(30))).toEqual([
      { kind: "left", at: at(10), durationMs: null },
    ]);
    expect(integrityIncidents([focus(10, false)], null, new Date(T0 + 10_500))).toEqual([]);
    // A deadline still ahead is not an end yet.
    expect(integrityIncidents([focus(10, false)], at(100), at(30))).toEqual([
      { kind: "left", at: at(10), durationMs: null },
    ]);
  });

  it("passes pastes through, in time order with the absences", () => {
    const rows: JournalRow[] = [
      focus(10, false),
      { kind: "paste", at: at(12), details: { length: 240, afterFocusLoss: true } },
      focus(15, true),
      { kind: "paste", at: at(30), details: null },
    ];
    expect(integrityIncidents(rows, null, at(60))).toEqual([
      { kind: "left", at: at(10), durationMs: 5000 },
      { kind: "paste", at: at(12), length: 240, afterFocusLoss: true },
      { kind: "paste", at: at(30), length: null, afterFocusLoss: false },
    ]);
  });

  it("ignores other kinds, unreadable details and a return with nothing to close", () => {
    const rows: JournalRow[] = [
      { kind: "reconnect", at: at(1), details: null },
      { kind: "focus", at: at(2), details: { focused: "no" } },
      focus(3, true),
      vis(4, "visible"),
    ];
    expect(integrityIncidents(rows, null, at(60))).toEqual([]);
  });
});
