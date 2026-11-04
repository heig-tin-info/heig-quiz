import { describe, expect, it } from "vitest";

import { EN_LABELS, FR_LABELS, type Block, type Lang } from "@quiz/docexport";
import { markdownBody } from "@quiz/docexport/markdown";

import { shortServer } from "./server.js";
import { SECRET_CONFIG } from "./testing.js";

const md = (blocks: readonly Block[], lang: Lang = "en") => markdownBody({ lang, blocks });
const view = { seed: 0, itemId: "item-1", shuffle: false };

describe("the short question as a document (ADR-121 §2, ADR-125)", () => {
  it("says what kind of answer a number field takes, in the reader's language, on one line", () => {
    const student = shortServer.toStudent(SECRET_CONFIG, view);
    const body = md([...shortServer.statementDoc!(student, FR_LABELS), ...shortServer.answerZone!(student)], "fr");
    expect(body).toContain(SECRET_CONFIG.prompt);
    expect(body).toContain(FR_LABELS.expectNumber);
    expect(shortServer.answerZone!(student)).toEqual([{ kind: "answerZone", zone: "lines", lines: 1 }]);
  });

  it("gives a text field the prompt alone and two lines", () => {
    const text = shortServer.toStudent({ ...SECRET_CONFIG, kind: "text" }, view);
    expect(md(shortServer.statementDoc!(text, EN_LABELS))).toBe(`${SECRET_CONFIG.prompt}\n`);
    expect(shortServer.answerZone!(text)).toEqual([{ kind: "answerZone", zone: "lines", lines: 2 }]);
  });

  it("lists the accepted answers and tells the staff which one matched", () => {
    const student = shortServer.toStudent(SECRET_CONFIG, view);
    expect(md(shortServer.solutionDoc!(shortServer.toSolution(SECRET_CONFIG, view), student, EN_LABELS))).toContain("- 0x1004");
    const details = { matchedIndex: 1, matchedKind: "regex", normalized: "n42", fraction: 1 };
    expect(md(shortServer.answerDoc!(SECRET_CONFIG, { text: "N42" }, details, EN_LABELS))).toBe(
      "```text\nN42\n```\n\nMatched accepted answer 2 (regex).\n",
    );
    expect(md(shortServer.answerDoc!(SECRET_CONFIG, { text: "N42" }, details, FR_LABELS), "fr")).toContain(
      "Correspond à la réponse acceptée 2 (regex).",
    );
    expect(md(shortServer.answerDoc!(SECRET_CONFIG, { text: "x" }, { ...details, matchedIndex: null }, EN_LABELS))).toContain(
      "No accepted answer matched.",
    );
    expect(md(shortServer.answerDoc!(SECRET_CONFIG, { text: "" }, null, EN_LABELS))).toBe("No answer.\n");
  });

  it("gives the student their answer in a block no answer can close", () => {
    const student = shortServer.toStudent(SECRET_CONFIG, view);
    expect(md(shortServer.studentAnswerDoc!(student, { text: "a ``` b" }, null, EN_LABELS))).toBe("````text\na ``` b\n````\n");
    expect(md(shortServer.studentAnswerDoc!(student, { text: " " }, null, EN_LABELS))).toBe("No answer.\n");
  });
});
