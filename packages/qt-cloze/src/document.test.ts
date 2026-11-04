import { describe, expect, it } from "vitest";

import { testGradeContext } from "@quiz/core/testing";
import { EN_LABELS, FR_LABELS, type Block, type Lang } from "@quiz/docexport";
import { markdownBody } from "@quiz/docexport/markdown";

import type { ClozeDetails } from "./schema.js";
import { clozeServer } from "./server.js";
import { SECRET_CONFIG } from "./testing.js";

const md = (blocks: readonly Block[], lang: Lang = "en") => markdownBody({ lang, blocks });
const shuffled = { seed: 7, itemId: "item-1", shuffle: true };
const teacher = { seed: 0, itemId: "item-1", shuffle: false };

const graded = async (answer: { blanks: (string | null)[] }) =>
  ((await clozeServer.grade(SECRET_CONFIG, answer, testGradeContext(6))) as { details: ClozeDetails }).details;

describe("the cloze question as a document (ADR-121 §2, ADR-125)", () => {
  it("numbers the blanks of the student template", () => {
    const student = clozeServer.toStudent(SECRET_CONFIG, shuffled);
    const body = md(clozeServer.statementDoc!(student, EN_LABELS));
    expect(body).toContain("La loi de ____(1) lie force");
    expect(body).toContain("| Force | ____(6) |");
    expect(body).not.toMatch(/⸢\d+⸣/);
  });

  it("gives one zone per blank, named by its part: a line to type on, a dropdown's options to tick", () => {
    const student = clozeServer.toStudent(SECRET_CONFIG, teacher);
    const zones = clozeServer.answerZone!(student).filter((b) => b.kind === "answerZone");
    expect(zones.map((z) => [z.part, z.zone])).toEqual([
      ["b0", "lines"],
      ["b1", "lines"],
      ["b2", "lines"],
      ["b3", "bubbles"],
      ["b4", "lines"],
      ["b5", "bubbles"],
    ]);
    expect(zones[3]).toMatchObject({ labels: ["newton", "joule", "watt", "pascal"] });
    expect(md(clozeServer.statementDoc!(student, EN_LABELS))).toContain("(4) newton / joule / watt / pascal");
  });

  it("gives the staff each blank: the answer, the key and the verdict", async () => {
    const student = clozeServer.toStudent(SECRET_CONFIG, teacher);
    const solution = md(clozeServer.solutionDoc!(clozeServer.toSolution(SECRET_CONFIG, teacher), student, EN_LABELS));
    expect(solution).toContain("| Blank | Expected |");
    expect(solution).toContain("| (4) | newton |");
    const answer = { blanks: ["Newton", "10", "+=", "0", "N", "2"] };
    const body = md(clozeServer.answerDoc!(SECRET_CONFIG, answer, await graded(answer), EN_LABELS));
    expect(body).toContain("| Blank | Given | Expected | Result |");
    // A dropdown's canonical index reads as its option (D4).
    expect(body).toContain("| (4) | newton | newton | right |");
    expect(body).toContain("| (6) | joule |");
    expect(md(clozeServer.answerDoc!(SECRET_CONFIG, { blanks: [null] }, null, EN_LABELS))).toContain("| (1) | — |");
    // A French teacher reads the same table in French (ADR-121 §4, amended 2026-11-04).
    const french = md(clozeServer.answerDoc!(SECRET_CONFIG, answer, await graded(answer), FR_LABELS), "fr");
    expect(french).toContain("| Trou | Réponse donnée | Attendu | Résultat |");
    expect(french).toContain("| (4) | newton | newton | juste |");
  });

  it("gives the student their blanks in their own view, the key only when the policy shows it", async () => {
    const student = clozeServer.toStudent(SECRET_CONFIG, shuffled);
    // The student's own words, none of them a secret of the key.
    const stored = { blanks: ["newton", "10", "+", "0", "N", "2"] };
    const answer = clozeServer.toStudentAnswer!(SECRET_CONFIG, shuffled, stored);
    const details = await graded(stored);
    const policy = { showKey: false, showHiddenCaseNames: false };
    const hidden = md(clozeServer.studentAnswerDoc!(student, answer, clozeServer.studentDetails!(details, policy), FR_LABELS), "fr");
    expect(hidden).toContain("| Trou | Votre réponse | Résultat |");
    expect(hidden).toContain("| (4) | newton | juste |");
    expect(hidden).toContain("| (6) | joule | faux |");
    expect(hidden).toContain("| (5) | N | juste |");
    const shown = clozeServer.studentDetails!(details, { ...policy, showKey: true });
    expect(md(clozeServer.studentAnswerDoc!(student, answer, shown, EN_LABELS))).toContain(
      "| Blank | Your answer | Result | Expected |",
    );
    expect(md(clozeServer.studentAnswerDoc!(student, answer, null, EN_LABELS))).toContain("| Blank | Your answer |\n");
  });
});
