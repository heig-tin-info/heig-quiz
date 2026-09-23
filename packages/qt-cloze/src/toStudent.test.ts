/** The mandatory leak test (PLAN-MVP §2.5, docs/05 §5.7, N-SEC-04). */
import { describe, expect, it } from "vitest";
import { COMMON_FORBIDDEN_STUDENT_KEYS } from "@quiz/core/server";
import { config, SECRET_CONFIG, SECRET_VALUES } from "./test/fixtures.js";
import { clozeServer } from "./server.js";

/*
 * The shared floor (`@quiz/core/server`) plus what only `cloze` has: a blank
 * publishes its `kind`, never its `mode`, and the regex `flags` say as much
 * about the key as the pattern does.
 */
const FORBIDDEN_KEYS = [
  ...COMMON_FORBIDDEN_STUDENT_KEYS,
  // Out of the floor since R-06 (only `code` publishes it, on purpose); here it
  // still names nothing this type may publish.
  "compare",
  "expected",
  "flags",
  "mode",
  "policy",
  "tolerance",
  "value",
];

const view = { seed: 7, itemId: "i", shuffle: true };

describe("toStudent", () => {
  it("leaks no key", () => {
    const out = JSON.stringify(clozeServer.toStudent(SECRET_CONFIG, view));
    for (const key of FORBIDDEN_KEYS) expect(out).not.toContain(`"${key}"`);
  });

  it("leaks no secret value: no answer, no pattern, no tolerance", () => {
    const out = JSON.stringify(clozeServer.toStudent(SECRET_CONFIG, view));
    for (const secret of SECRET_VALUES) expect(out).not.toContain(secret);
  });

  it("replaces every blank by its sentinel, and nothing else", () => {
    const student = clozeServer.toStudent(SECRET_CONFIG, view);
    expect(student.template).not.toContain("{{");
    expect(student.template).toContain("⸢0⸣");
    expect(student.template).toContain("F = m·a");
    // The fenced code block survives, sentinels and all (decision D5).
    expect(student.template).toContain("```c");
    expect(clozeServer.studentSchema.safeParse(student).success).toBe(true);
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

  it("shuffles the dropdown options while keeping the canonical id", () => {
    const student = clozeServer.toStudent(SECRET_CONFIG, view);
    const select = student.blanks.find((blank) => blank.kind === "select");
    expect(select?.kind).toBe("select");
    if (select?.kind !== "select") throw new Error("the fixture must hold a dropdown");
    expect(select.options.map((option) => option.id).sort()).toEqual([0, 1, 2, 3]);
    expect(select.options.find((option) => option.id === 0)?.label).toBe("newton");
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
        return select?.kind === "select" ? select.options.map((o) => o.id).join(",") : "";
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
