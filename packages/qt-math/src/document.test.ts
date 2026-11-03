import { describe, expect, it } from "vitest";

import { EN_LABELS, FR_LABELS, type Block, type Lang } from "@quiz/docexport";
import { markdownBody } from "@quiz/docexport/markdown";

import { mathServer } from "./server.js";
import { SECRET_CONFIG } from "./testing.js";

const md = (blocks: readonly Block[], lang: Lang = "en") => markdownBody({ lang, blocks });
const view = { seed: 0, itemId: "item-1", shuffle: false };

describe("the math question as a document (ADR-121 §2, ADR-125)", () => {
  it("names the symbols in the reader's language, and gives two lines", () => {
    const student = mathServer.toStudent(SECRET_CONFIG, view);
    const body = md([...mathServer.statementDoc!(student, FR_LABELS), ...mathServer.answerZone!(student)], "fr");
    expect(body).toContain(SECRET_CONFIG.prompt);
    expect(body).toContain("Symboles\u202F: $R_1$, $R_2$");
    expect(body.match(/`_{40}`/g)).toHaveLength(2);
  });

  it("lists the accepted formulas with their share of the points", () => {
    const student = mathServer.toStudent(SECRET_CONFIG, view);
    const body = md(mathServer.solutionDoc!(mathServer.toSolution(SECRET_CONFIG, view), student, EN_LABELS));
    expect(body).toBe("- $\\frac{R_1 R_2}{R_1+R_2}$ (100 %)\n- $R_1+R_2$ (25 %)\n");
  });

  it("writes an answer as math that cannot close early, and why it was not read", () => {
    const answer = { latex: "a$\n# b" };
    const details = { status: "invalid" as const, problem: { code: "syntax" as const }, matchedIndex: null, fraction: 0, latex: null };
    expect(md(mathServer.answerDoc!(SECRET_CONFIG, answer, details))).toBe("$a\\$ # b$\n\nNot read: syntax.\n");
    expect(md(mathServer.answerDoc!(SECRET_CONFIG, { latex: "" }, null))).toBe("No answer.\n");
    const student = mathServer.toStudent(SECRET_CONFIG, view);
    expect(md(mathServer.studentAnswerDoc!(student, { latex: "R_1" }, null, EN_LABELS))).toBe("$R_1$\n");
    expect(md(mathServer.studentAnswerDoc!(student, { latex: "" }, null, EN_LABELS))).toBe("No answer.\n");
  });
});
