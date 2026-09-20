import { describe, expect, it } from "vitest";
import {
  CLOZE_SENTINEL_CLOSE,
  CLOZE_SENTINEL_OPEN,
  clozeSentinel,
  clozeStudentTemplate,
  clozeTotalWeight,
  describeBlank,
  gradeCloze,
  matchBlank,
  parseCloze,
  type ClozeBlank,
} from "./cloze.js";

const s = clozeSentinel;

describe("parseCloze — the docs/04 §4.6 grammar table", () => {
  it("text blank with alternatives", () => {
    const parse = parseCloze("La loi de {{Newton|Isaac Newton}} lie F, m et a.");
    expect(parse.template).toBe(`La loi de ${s(0)} lie F, m et a.`);
    expect(parse.blanks).toEqual([
      { index: 0, weight: 1, kind: "text", answers: ["Newton", "Isaac Newton"] },
    ]);
    expect(parse.errors).toEqual([]);
  });

  it("leading weight", () => {
    expect(parseCloze("{{2*Newton}}").blanks[0]).toMatchObject({ weight: 2, kind: "text" });
    expect(parseCloze("{{1.5*Newton}}").blanks[0]).toMatchObject({ weight: 1.5 });
    expect(parseCloze("{{2*/^N$/}}").blanks[0]).toMatchObject({ weight: 2, kind: "regex", pattern: "^N$" });
  });

  it("number blank, absolute and relative tolerance", () => {
    expect(parseCloze("{{#10:0}}").blanks[0]).toEqual({
      index: 0,
      weight: 1,
      kind: "number",
      value: 10,
      tolerance: 0,
      mode: "abs",
    });
    expect(parseCloze("{{#3.14:1%}}").blanks[0]).toMatchObject({ value: 3.14, tolerance: 0.01, mode: "rel" });
    expect(parseCloze("{{#-2}}").blanks[0]).toMatchObject({ value: -2, tolerance: 0, mode: "abs" });
  });

  it("regex blank with flags", () => {
    expect(parseCloze("{{/^[0-9a-f]+$/i}}").blanks[0]).toEqual({
      index: 0,
      weight: 1,
      kind: "regex",
      pattern: "^[0-9a-f]+$",
      flags: "i",
    });
  });

  it("select blank: an alternative starting with = is correct, the authoring order is canonical", () => {
    const parse = parseCloze("{{=newton|joule|watt|pascal}}");
    expect(parse.blanks[0]).toEqual({
      index: 0,
      weight: 1,
      kind: "select",
      options: ["newton", "joule", "watt", "pascal"],
      correct: [0],
    });
  });

  it("select blank with two correct options", () => {
    expect(parseCloze("{{a|=b|=c}}").blanks[0]).toMatchObject({
      options: ["a", "b", "c"],
      correct: [1, 2],
    });
  });

  it("escapes: \\{{ is literal, \\| stays inside an alternative", () => {
    expect(parseCloze("un \\{{ littéral").template).toBe("un {{ littéral");
    expect(parseCloze("un \\{{ littéral").blanks).toEqual([]);
    expect(parseCloze("{{a\\|b|c}}").blanks[0]).toMatchObject({ answers: ["a|b", "c"] });
    expect(parseCloze("{{a\\*b}}").blanks[0]).toMatchObject({ answers: ["a*b"] });
    expect(parseCloze("{{a\\}b}}").blanks[0]).toMatchObject({ answers: ["a}b"] });
    expect(parseCloze("{{a\\\\b}}").blanks[0]).toMatchObject({ answers: ["a\\b"] });
  });

  it("keeps a blank alive inside a fenced code block", () => {
    const parse = parseCloze("```c\nfor (int i = 0; i < {{#10:0}}; i++) {\n```");
    expect(parse.template).toBe(`\`\`\`c\nfor (int i = 0; i < ${s(0)}; i++) {\n\`\`\``);
    expect(parse.blanks).toHaveLength(1);
  });

  it("records an unterminated {{ and renders it literally", () => {
    const parse = parseCloze("début {{Newton et la suite");
    expect(parse.errors).toEqual([{ at: 6, message: "cloze.unterminated" }]);
    expect(parse.template).toBe("début {{Newton et la suite");
    expect(parse.blanks).toEqual([]);
  });

  it("records a malformed blank and renders it literally", () => {
    expect(parseCloze("{{}}").errors[0]?.message).toBe("cloze.empty_blank");
    expect(parseCloze("{{  }}").errors[0]?.message).toBe("cloze.empty_blank");
    expect(parseCloze("{{|}}").errors[0]?.message).toBe("cloze.empty_blank");
    expect(parseCloze("{{=a|=}}").errors[0]?.message).toBe("cloze.empty_option");
    expect(parseCloze("{{#abc}}").errors[0]?.message).toBe("cloze.invalid_number");
    expect(parseCloze("{{/a/g}}").errors[0]?.message).toBe("cloze.invalid_regex_flags");
    expect(parseCloze("{{/([a-/i}}").errors[0]?.message).toBe("cloze.invalid_regex");
    expect(parseCloze("{{#abc}}").template).toBe("{{#abc}}");
  });

  it("treats an unclosed slash form as plain text", () => {
    expect(parseCloze("{{/abc}}").blanks[0]).toMatchObject({ kind: "text", answers: ["/abc"] });
  });

  it("strips a sentinel typed by the author, so no phantom input appears", () => {
    const parse = parseCloze(`${CLOZE_SENTINEL_OPEN}0${CLOZE_SENTINEL_CLOSE} {{a}}`);
    expect(parse.template).toBe(`0 ${s(0)}`);
    expect(parse.blanks).toHaveLength(1);
  });

  it("numbers the blanks in order of appearance and sums their weights", () => {
    const parse = parseCloze("{{a}} puis {{2*b}} puis {{=c|d}}");
    expect(parse.blanks.map((b) => b.index)).toEqual([0, 1, 2]);
    expect(parse.template).toBe(`${s(0)} puis ${s(1)} puis ${s(2)}`);
    expect(clozeTotalWeight(parse)).toBe(4);
    expect(clozeTotalWeight(parseCloze("aucun trou"))).toBe(0);
  });
});

describe("clozeStudentTemplate", () => {
  const parse = parseCloze("{{Newton}} {{#10:0}} {{/^N$/}} {{=newton|joule|watt|pascal}}");

  it("collapses text, number and regex to an opaque input", () => {
    const student = clozeStudentTemplate(parse, 7, "item-1", false);
    expect(student.template).toBe(parse.template);
    expect(student.blanks.slice(0, 3)).toEqual([
      { index: 0, weight: 1, kind: "input", numeric: false },
      { index: 1, weight: 1, kind: "input", numeric: true },
      { index: 2, weight: 1, kind: "input", numeric: false },
    ]);
    expect(JSON.stringify(student)).not.toContain("Newton");
    expect(JSON.stringify(student)).not.toContain("^N$");
  });

  it("keeps the canonical option ids while shuffling the display order (D4)", () => {
    const plain = clozeStudentTemplate(parse, 7, "item-1", false).blanks[3];
    const shuffled = clozeStudentTemplate(parse, 7, "item-1", true).blanks[3];
    expect(plain).toEqual({
      index: 3,
      weight: 1,
      kind: "select",
      options: [
        { id: 0, label: "newton" },
        { id: 1, label: "joule" },
        { id: 2, label: "watt" },
        { id: 3, label: "pascal" },
      ],
    });
    expect(shuffled).not.toEqual(plain);
    expect(shuffled?.kind === "select" && [...shuffled.options].sort((a, b) => a.id - b.id)).toEqual(
      plain?.kind === "select" ? plain.options : null,
    );
  });

  it("is stable for one (seed, itemId) and different for another", () => {
    const a = clozeStudentTemplate(parse, 7, "item-1", true);
    const b = clozeStudentTemplate(parse, 7, "item-1", true);
    const c = clozeStudentTemplate(parse, 7, "item-2", true);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe("gradeCloze", () => {
  const parse = parseCloze("{{2*Newton}} {{#3.14:1%}} {{/^[0-9a-f]+$/i}} {{=newton|joule}}");

  it("weights each blank and yields the fraction", () => {
    const grade = gradeCloze(parse, ["newton", "3,14", "FF", "0"], false);
    expect(grade.perBlank.map((b) => b.ok)).toEqual([true, true, true, true]);
    expect([grade.earned, grade.total, grade.fraction]).toEqual([5, 5, 1]);
  });

  it("scores a missing or empty answer 0", () => {
    const grade = gradeCloze(parse, [null, "", "  ", undefined as unknown as string], false);
    expect(grade.perBlank.map((b) => b.ok)).toEqual([false, false, false, false]);
    expect([grade.earned, grade.fraction]).toEqual([0, 0]);
    expect(grade.perBlank[0]?.given).toBeNull();
  });

  it("honours caseSensitive on text blanks only", () => {
    expect(gradeCloze(parse, ["NEWTON", null, null, null], false).perBlank[0]?.ok).toBe(true);
    expect(gradeCloze(parse, ["NEWTON", null, null, null], true).perBlank[0]?.ok).toBe(false);
  });

  it("matches a select on the canonical index, whatever the display order", () => {
    expect(gradeCloze(parse, [null, null, null, "0"], false).perBlank[3]?.ok).toBe(true);
    expect(gradeCloze(parse, [null, null, null, "1"], false).perBlank[3]?.ok).toBe(false);
    expect(gradeCloze(parse, [null, null, null, "x"], false).perBlank[3]?.ok).toBe(false);
    expect(gradeCloze(parse, [null, null, null, "0.5"], false).perBlank[3]?.ok).toBe(false);
  });

  it("reports the expected key for the teacher", () => {
    const grade = gradeCloze(parse, [null, null, null, null], false);
    expect(grade.perBlank.map((b) => b.expected)).toEqual([
      "Newton",
      "3.14 ± 1 %",
      "/^[0-9a-f]+$/i",
      "newton",
    ]);
  });

  it("gives a fraction of 0 for a text with no blank", () => {
    expect(gradeCloze(parseCloze("aucun trou"), [], false)).toEqual({
      perBlank: [],
      earned: 0,
      total: 0,
      fraction: 0,
    });
  });
});

describe("describeBlank", () => {
  it("renders an absolute numeric tolerance and a broken select", () => {
    const number: ClozeBlank = { index: 0, weight: 1, kind: "number", value: 4, tolerance: 1, mode: "abs" };
    expect(describeBlank(number)).toBe("4 ± 1");
    const select: ClozeBlank = { index: 0, weight: 1, kind: "select", options: ["a"], correct: [0, 9] };
    expect(describeBlank(select)).toBe("a | ");
  });

  it("matchBlank is null-safe", () => {
    expect(matchBlank({ index: 0, weight: 1, kind: "text", answers: ["a"] }, null, false)).toBe(false);
  });
});
