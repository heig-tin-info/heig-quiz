/**
 * The type-specific half of the leak test (PLAN-MVP §2.5, docs/05 §5.7,
 * N-SEC-04). The generic half — the full fixture of `./testing.ts` searched
 * for every forbidden key and secret value — is the registry's contract test.
 */
import { describe, expect, it } from "vitest";
import { config, SECRET_CONFIG } from "./test/fixtures.js";
import { clozeServer } from "./server.js";

const view = { seed: 7, itemId: "i", shuffle: true };

/** Shuffle on and off, the preview's seed and a spread of attempts'. */
const VIEWS = [0, 1, 7, 42, 99, 2024].flatMap((seed) =>
  [true, false].map((shuffle) => ({ seed, itemId: "item-1", shuffle })),
);

describe("toStudent", () => {
  it("replaces every blank by its sentinel, and nothing else", () => {
    const student = clozeServer.toStudent(SECRET_CONFIG, view);
    expect(student.template).not.toContain("{{");
    expect(student.template).toContain("⸢0⸣");
    expect(student.template).toContain("F = m·a");
    // The fenced code block survives, sentinels and all (decision D5).
    expect(student.template).toContain("```c");
  });

  it("collapses text, number and regex blanks to one opaque input kind", () => {
    const student = clozeServer.toStudent(SECRET_CONFIG, view);
    const kinds = student.blanks.map((blank) => blank.kind);
    expect(kinds).toEqual(["input", "input", "input", "select", "input", "select"]);
    // `numeric` is the ONLY thing a student learns, and only about the keyboard.
    expect(student.blanks[1]).toEqual({ index: 1, weight: 1, kind: "input", numeric: true });
  });

  it("keeps the weights: the scale is not a secret", () => {
    const student = clozeServer.toStudent(SECRET_CONFIG, view);
    expect(student.blanks[4]?.weight).toBe(2);
  });

  /*
   * A dropdown INSIDE A TABLE CELL. Its LABELS have to travel — they are what
   * the student picks from — and which one is right must not; the `|` of the
   * hole never reaches the markdown table parser, because the sentinel has
   * already taken its place (decision D5).
   */
  it("publishes a dropdown in a table cell, the correct mark stripped", () => {
    const student = clozeServer.toStudent(SECRET_CONFIG, view);
    const blank = student.blanks[5];
    expect(blank?.kind).toBe("select");
    if (blank?.kind !== "select") throw new Error("the fixture must hold a dropdown in a table");
    expect(blank.options.map((o) => o.label).sort()).toEqual(["NEWTON-MARKER", "joule", "pascal"]);
    expect(student.template).toContain("| Force | ⸢5⸣ |");
  });

  /*
   * ADR-097 (audit H2): an option's id is its displayed position, for every
   * view — the identity permutation included, which is why the assertion is
   * "ids are 0..n-1 in order", never "ids differ from the canonical order".
   */
  it.each(VIEWS)("names each dropdown option by its displayed position (seed $seed, shuffle $shuffle)", (at) => {
    const student = clozeServer.toStudent(SECRET_CONFIG, at);
    for (const blank of student.blanks) {
      if (blank.kind !== "select") continue;
      expect(blank.options.map((option) => option.id)).toEqual(blank.options.map((_, position) => position));
    }
  });

  it("is stable for one (seed, item): a reload shows the same order", () => {
    expect(clozeServer.toStudent(SECRET_CONFIG, view)).toEqual(
      clozeServer.toStudent(SECRET_CONFIG, view),
    );
  });

  it("gives another attempt another order", () => {
    const orders = new Set(
      Array.from({ length: 24 }, (_, seed) => {
        const student = clozeServer.toStudent(SECRET_CONFIG, { ...view, seed });
        const select = student.blanks.find((blank) => blank.kind === "select");
        return select?.kind === "select" ? select.options.map((o) => o.label).join(",") : "";
      }),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it("keeps the canonical order when either switch is off", () => {
    const canonical = [0, 1, 2, 3];
    for (const student of [
      clozeServer.toStudent(SECRET_CONFIG, { ...view, shuffle: false }),
      clozeServer.toStudent(config(SECRET_CONFIG.text, { shuffleOptions: false }), view),
    ]) {
      const select = student.blanks.find((blank) => blank.kind === "select");
      if (select?.kind !== "select") throw new Error("the fixture must hold a dropdown");
      expect(select.options.map((option) => option.id)).toEqual(canonical);
    }
  });
});

/*
 * ADR-097: a dropdown's value is a displayed position on the wire and a
 * canonical index in storage (D4); a typed blank is the same in both. The
 * round trip over every view is the registry's contract test.
 */
describe("the answer in view coordinates", () => {
  it.each(VIEWS)("decodes each position to the label shown there (seed $seed, shuffle $shuffle)", (at) => {
    const student = clozeServer.toStudent(SECRET_CONFIG, at);
    const select = student.blanks[3];
    if (select?.kind !== "select") throw new Error("blank 3 is a dropdown");
    for (const option of select.options) {
      const blanks = [null, null, null, String(option.id), null, null];
      const canonical = clozeServer.fromStudentAnswer!(SECRET_CONFIG, at, { blanks });
      expect(["newton", "joule", "watt", "pascal"][Number(canonical?.blanks[3])]).toBe(option.label);
    }
  });

  it("refuses a position the dropdown does not have", () => {
    expect(clozeServer.fromStudentAnswer!(SECRET_CONFIG, view, { blanks: [null, null, null, "4"] })).toBeNull();
    expect(clozeServer.fromStudentAnswer!(SECRET_CONFIG, view, { blanks: [null, null, null, "newton"] })).toBeNull();
  });
});
