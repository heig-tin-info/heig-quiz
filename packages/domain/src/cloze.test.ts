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
  formatBlank,
  matchClozeHole,
  parseBlankBody,
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

/*
 * `formatBlank` is the inverse of `parseBlankBody`, and the blank editor of the
 * rich text field writes through it. A body it produced that the grader read
 * back as something else would be the one bug this popup can cause, so the
 * round trip is asserted on every kind AND on the characters that mean
 * something inside a blank.
 */
describe("formatBlank / parseBlankBody — the round trip the popup rides on", () => {
  const CASES: ClozeBlank[] = [
    { index: 0, weight: 1, kind: "text", answers: ["Newton"] },
    { index: 0, weight: 1, kind: "text", answers: ["Newton", "Isaac Newton"] },
    { index: 0, weight: 2.5, kind: "text", answers: ["a"] },
    // The four escapes of the grammar table, each in an answer.
    { index: 0, weight: 1, kind: "text", answers: ["a|b", "c}d", "e*f", "g\\h"] },
    // …and the heads the parser reads as another kind entirely.
    { index: 0, weight: 1, kind: "text", answers: ["#3"] },
    { index: 0, weight: 1, kind: "text", answers: ["/a/"] },
    { index: 0, weight: 1, kind: "text", answers: ["=x", "=y"] },
    { index: 0, weight: 1, kind: "text", answers: ["2*3"] },
    { index: 0, weight: 3, kind: "text", answers: ["2*3", "6"] },
    { index: 0, weight: 1, kind: "select", options: ["oui", "non"], correct: [0] },
    { index: 0, weight: 1, kind: "select", options: ["a", "b", "c"], correct: [1, 2] },
    { index: 0, weight: 2, kind: "select", options: ["=a", "#b", "c|d"], correct: [0, 2] },
    { index: 0, weight: 1, kind: "number", value: 10, tolerance: 0, mode: "abs" },
    { index: 0, weight: 1, kind: "number", value: 3.14, tolerance: 0.01, mode: "abs" },
    { index: 0, weight: 1, kind: "number", value: -2, tolerance: 0.05, mode: "rel" },
    { index: 0, weight: 4, kind: "number", value: 9.81, tolerance: 0.1, mode: "rel" },
    { index: 0, weight: 1, kind: "regex", pattern: "^N$", flags: "" },
    { index: 0, weight: 2, kind: "regex", pattern: "a|b", flags: "i" },
  ];

  it.each(CASES.map((blank) => [`${blank.kind}: ${formatBlank(blank)}`, blank] as const))(
    "%s",
    (_name, blank) => {
      expect(parseBlankBody(formatBlank(blank))).toEqual(blank);
    },
  );

  it("writes the body a whole hole parses back to, blank for blank", () => {
    for (const blank of CASES) {
      const parse = parseCloze(`x {{${formatBlank(blank)}}} y`);
      expect(parse.errors).toEqual([]);
      expect(parse.blanks).toEqual([blank]);
    }
  });

  it("leaves the weight out when it is 1, and writes it when it is not", () => {
    expect(formatBlank({ index: 0, weight: 1, kind: "text", answers: ["a"] })).toBe("a");
    expect(formatBlank({ index: 0, weight: 2, kind: "text", answers: ["a"] })).toBe("2*a");
  });

  it("writes a dropdown with `=` on every correct option", () => {
    expect(
      formatBlank({ index: 0, weight: 1, kind: "select", options: ["a", "b", "c"], correct: [0, 2] }),
    ).toBe("=a|b|=c");
  });

  it("writes a relative tolerance as a percentage, exactly", () => {
    expect(formatBlank({ index: 0, weight: 1, kind: "number", value: 2, tolerance: 0.05, mode: "rel" })).toBe(
      "#2:5%",
    );
  });

  it("reports the same i18n key the parser does on an invalid body", () => {
    expect(parseBlankBody("")).toBe("cloze.empty_blank");
    expect(parseBlankBody("#nope")).toBe("cloze.invalid_number");
    expect(parseBlankBody("/(/")).toBe("cloze.invalid_regex");
    expect(parseBlankBody("/a/zz")).toBe("cloze.invalid_regex_flags");
    expect(parseBlankBody("=a|")).toBe("cloze.empty_option");
  });
});

describe("matchClozeHole — what the rich editor tokenizes", () => {
  it("reads one hole at the head of the source", () => {
    expect(matchClozeHole("{{=a|b}} suite")).toEqual({ raw: "{{=a|b}}", body: "=a|b" });
  });

  it("stops at the first UNESCAPED closing braces", () => {
    expect(matchClozeHole("{{a\\}}b}}")).toEqual({ raw: "{{a\\}}b}}", body: "a\\}}b" });
  });

  it("reads the escaped opening as a literal, with no body", () => {
    expect(matchClozeHole("\\{{ is a literal")).toEqual({ raw: "\\{{", body: null });
  });

  it("returns nothing for an unterminated hole or for ordinary text", () => {
    expect(matchClozeHole("{{ never closed")).toBeUndefined();
    expect(matchClozeHole("plain text")).toBeUndefined();
  });

  it("agrees with the parser on where a hole ends", () => {
    const source = "{{a}}{{b}}";
    const first = matchClozeHole(source)!;
    expect(first.raw).toBe("{{a}}");
    expect(matchClozeHole(source.slice(first.raw.length))?.body).toBe("b");
  });
});
