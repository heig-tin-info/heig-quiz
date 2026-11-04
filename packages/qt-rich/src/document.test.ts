import { describe, expect, it } from "vitest";

import { EN_LABELS, FR_LABELS, type Block, type Lang } from "@quiz/docexport";
import { markdownBody } from "@quiz/docexport/markdown";

import { richServer } from "./server.js";
import { richLeakFixture, SECRET_CONFIG } from "./testing.js";

const md = (blocks: readonly Block[], lang: Lang = "en") => markdownBody({ lang, blocks });
const view = { seed: 0, itemId: "item-1", shuffle: false };

describe("the essay as a document (ADR-121 §2, ADR-125)", () => {
  it("states the length limit in the reader's language", () => {
    const student = richServer.toStudent({ ...SECRET_CONFIG, maxChars: 1500 }, view);
    const body = md(richServer.statementDoc!(student, FR_LABELS), "fr");
    expect(body).toBe(`${SECRET_CONFIG.prompt}\n\nLongueur maximale\u202F: 1500 caractères\n`);
  });

  it("sizes the frame by the limit, within a page", () => {
    const zone = (maxChars?: number) => richServer.answerZone!(richServer.toStudent({ ...SECRET_CONFIG, maxChars }, view))[0];
    expect(zone(1500)).toMatchObject({ zone: "free", heightMm: 115 });
    expect(zone(100)).toMatchObject({ heightMm: 60 });
    expect(zone(undefined)).toMatchObject({ heightMm: 230 });
    expect(zone(20_000)).toMatchObject({ heightMm: 230 });
  });

  it("renders what the solution holds: everything for the staff, the model answer alone for a student", () => {
    const student = richServer.toStudent(SECRET_CONFIG, view);
    const solution = richServer.toSolution(SECRET_CONFIG, view);
    const staff = md(richServer.solutionDoc!(solution, student, EN_LABELS));
    // Every text secret of the key (the last one is `totalPoints`, no part of a solution).
    for (const secret of richLeakFixture.secrets.slice(0, 4)) expect(staff).toContain(secret);
    const own = md(richServer.solutionDoc!(richServer.studentSolution!(solution, SECRET_CONFIG)!, student, EN_LABELS));
    expect(own).toBe(`${SECRET_CONFIG.reference}\n`);
  });

  it("gives an essay formatted, or verbatim when the field was plain, with the validated breakdown", () => {
    const breakdown = [{ id: "c-guard", title: "Guard page", points: 1.5, maxPoints: 2 }];
    const graded = { reason: "manual" as const, chars: 13, breakdown };
    const body = md(richServer.answerDoc!(SECRET_CONFIG, { text: "The *stack*." }, graded, EN_LABELS));
    expect(body).toBe("The *stack*.\n\n| Criterion | Points |\n|---|---|\n| Guard page | 1.5 / 2 |\n");
    expect(md(richServer.answerDoc!(SECRET_CONFIG, { text: "The *stack*." }, graded, FR_LABELS), "fr")).toContain(
      "| Critère | Points |",
    );
    expect(md(richServer.answerDoc!(SECRET_CONFIG, { text: "" }, null, EN_LABELS))).toBe("No answer.\n");
    const plain = richServer.toStudent({ ...SECRET_CONFIG, format: "plain" }, view);
    expect(md(richServer.studentAnswerDoc!(plain, { text: "# not a title" }, null, EN_LABELS))).toBe("```text\n# not a title\n```\n");
    expect(md(richServer.studentAnswerDoc!(plain, { text: "" }, null, FR_LABELS), "fr")).toBe("Pas de réponse.\n");
  });
});
