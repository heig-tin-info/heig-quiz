import { describe, expect, it } from "vitest";

import { EN_LABELS, FR_LABELS, type Block, type Lang } from "@quiz/docexport";
import { markdownBody } from "@quiz/docexport/markdown";

import type { McqDetails } from "./schema.js";
import { mcqServer } from "./server.js";
import { SECRET_CONFIG } from "./testing.js";

const md = (blocks: readonly Block[], lang: Lang = "en") => markdownBody({ lang, blocks });
const shuffled = { seed: 7, itemId: "item-1", shuffle: true };
const teacher = { seed: 0, itemId: "item-1", shuffle: false };

/** The letter the student saw `text` under, read off the statement. */
const letterOf = (body: string, text: string): string => new RegExp(`\\*\\*([A-Z])\\.\\*\\* ${text}`).exec(body)![1]!;

describe("the mcq question as a document (ADR-121 §2, ADR-125)", () => {
  it("letters the choices as served, one bubble per letter", () => {
    const student = mcqServer.toStudent(SECRET_CONFIG, shuffled);
    const body = md([...mcqServer.statementDoc!(student, EN_LABELS), ...mcqServer.answerZone!(student)]);
    expect(body).toContain(SECRET_CONFIG.prompt);
    for (const choice of SECRET_CONFIG.choices) expect(body).toContain(`.** ${choice.text}`);
    expect(body).toContain("○ A  ○ B  ○ C");
  });

  it("letters the key and the student's own answer as the statement does", () => {
    const student = mcqServer.toStudent(SECRET_CONFIG, shuffled);
    const letter = letterOf(md(mcqServer.statementDoc!(student, EN_LABELS)), "0x1004");
    const key = md(mcqServer.solutionDoc!(mcqServer.toSolution(SECRET_CONFIG, shuffled), student, EN_LABELS));
    expect(key).toBe(`**${letter}.** 0x1004\n`);
    // The stored answer is canonical; the student reads it in their view (ADR-097).
    const answer = mcqServer.toStudentAnswer!(SECRET_CONFIG, shuffled, { selected: [1] });
    expect(md(mcqServer.studentAnswerDoc!(student, answer, null, EN_LABELS))).toBe(`**${letter}.** 0x1004\n`);
    expect(md(mcqServer.studentAnswerDoc!(student, { selected: [] }, null, FR_LABELS), "fr")).toBe("Pas de réponse.\n");
  });

  it("gives the staff the ticks by canonical letter and how the policy scored them", () => {
    const details: McqDetails = {
      policy: "discordance",
      correct: [1],
      selected: [1, 2],
      c: 1,
      w: 1,
      C: 1,
      W: 2,
      fraction: 0.5,
      truncated: false,
    };
    const body = md(mcqServer.answerDoc!(SECRET_CONFIG, { selected: [2, 1] }, details));
    expect(body).toContain("**B.** 0x1004\n\n**C.** 0x1008");
    expect(body).toContain("| discordance | 0.5 | 1 | 1 | 1 | 2 |");
    expect(md(mcqServer.answerDoc!(SECRET_CONFIG, { selected: [] }, null))).toBe("No answer.\n");
  });

  it("tells a student several may be right, and that a wrong tick costs", () => {
    const config = {
      ...SECRET_CONFIG,
      mode: "multiple" as const,
      choices: [
        { text: "```c\nint x;\n```", correct: true },
        { text: "y", correct: true },
      ],
    };
    const student = mcqServer.toStudent(config, { ...teacher, defaults: { mcq: { policy: "symmetric", negativeMarking: true } } });
    const body = md([...mcqServer.statementDoc!(student, FR_LABELS), ...mcqServer.answerZone!(student)], "fr");
    // A choice of several lines never shares the letter's line: the fence stays whole.
    expect(body).toContain("**A.**\n\n```c\nint x;\n```\n\n**B.** y");
    expect(body).toContain(FR_LABELS.severalAnswers);
    expect(body).toContain(FR_LABELS.negativeMarking);
    expect(body).toContain("☐ A  ☐ B");
  });
});
