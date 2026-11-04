import { describe, expect, it } from "vitest";

import { EN_LABELS, FR_LABELS, scopeZones, type Block, type Lang } from "@quiz/docexport";
import { markdownBody } from "@quiz/docexport/markdown";

import type { McqDetails } from "./schema.js";
import { mcqServer } from "./server.js";
import { SECRET_CONFIG } from "./testing.js";

const md = (blocks: readonly Block[], lang: Lang = "en") => markdownBody({ lang, blocks });
const shuffled = { seed: 7, itemId: "item-1", shuffle: true };
const teacher = { seed: 0, itemId: "item-1", shuffle: false };

/** The letter the student saw `text` under, read off the statement's task list. */
const letterOf = (body: string, text: string): string => new RegExp(`- \\[ \\] \\*\\*([A-Z])\\.\\*\\* ${text}`).exec(body)![1]!;

/** The task-list lines of `body`, as `x A` or `  B`. */
const ticks = (body: string): string[] =>
  [...body.matchAll(/^- \[([ x])\] \*\*([A-Z])\.\*\*/gm)].map((m) => `${m[1] === "x" ? "x" : " "} ${m[2]}`);

describe("the mcq question as a document (ADR-121 §2, ADR-125)", () => {
  it("lists the choices as served, each beside an empty box", () => {
    const student = mcqServer.toStudent(SECRET_CONFIG, shuffled);
    const body = md(mcqServer.statementDoc!(student, EN_LABELS));
    expect(body).toContain(SECRET_CONFIG.prompt);
    for (const choice of SECRET_CONFIG.choices) expect(body).toMatch(new RegExp(`^- \\[ \\] \\*\\*[A-C]\\.\\*\\* ${choice.text}$`, "m"));
    expect(ticks(body)).toEqual(["  A", "  B", "  C"]);
  });

  it("is its own paper zone: no zone of its own, the statement's choices keyed to the item", () => {
    const student = mcqServer.toStudent(SECRET_CONFIG, shuffled);
    expect(mcqServer.answerZone!(student)).toEqual([]);
    const scoped = scopeZones("item-1", mcqServer.statementDoc!(student, EN_LABELS));
    expect(scoped.filter((b) => b.kind === "choices").map((b) => b.kind === "choices" && b.id)).toEqual(["item-1"]);
  });

  it("ticks the key and the student's own answer on every choice, lettered as the statement", () => {
    const student = mcqServer.toStudent(SECRET_CONFIG, shuffled);
    const letter = letterOf(md(mcqServer.statementDoc!(student, EN_LABELS)), "0x1004");
    const key = md(mcqServer.solutionDoc!(mcqServer.toSolution(SECRET_CONFIG, shuffled), student, EN_LABELS));
    expect(key).toContain(`- [x] **${letter}.** 0x1004`);
    // Every choice is listed; only the right one is ticked.
    expect(ticks(key)).toHaveLength(3);
    expect(ticks(key).filter((t) => t.startsWith("x"))).toEqual([`x ${letter}`]);
    // The stored answer is canonical; the student reads it in their view (ADR-097).
    const answer = mcqServer.toStudentAnswer!(SECRET_CONFIG, shuffled, { selected: [1] });
    const own = md(mcqServer.studentAnswerDoc!(student, answer, null, EN_LABELS));
    expect(ticks(own).filter((t) => t.startsWith("x"))).toEqual([`x ${letter}`]);
    expect(ticks(own)).toHaveLength(3);
    expect(md(mcqServer.studentAnswerDoc!(student, { selected: [] }, null, FR_LABELS), "fr")).toBe("Pas de réponse.\n");
  });

  it("gives the staff the ticks by canonical letter and how the policy scored them, in their language", () => {
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
    const body = md(mcqServer.answerDoc!(SECRET_CONFIG, { selected: [2, 1] }, details, EN_LABELS));
    expect(body).toContain("- [ ] **A.** 0x1001\n- [x] **B.** 0x1004\n- [x] **C.** 0x1008");
    expect(body).toContain("| Policy | Fraction | Right ticks | Wrong ticks | Right choices | Wrong choices |");
    expect(body).toContain("| discordance | 0.5 | 1 | 1 | 1 | 2 |");
    expect(md(mcqServer.answerDoc!(SECRET_CONFIG, { selected: [] }, null, EN_LABELS))).toBe("No answer.\n");
    const french = md(mcqServer.answerDoc!(SECRET_CONFIG, { selected: [1] }, { ...details, negativeMarking: true }, FR_LABELS), "fr");
    expect(french).toContain("| Règle de notation | Fraction |");
    expect(french).toContain("| discordance, points négatifs |");
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
    const body = md(mcqServer.statementDoc!(student, FR_LABELS), "fr");
    // A choice of several lines never shares the letter's line: the fence stays whole, inside its item.
    expect(body).toContain("- [ ] **A.**\n  ```c\n  int x;\n  ```\n- [ ] **B.** y");
    expect(body).toContain(FR_LABELS.severalAnswers);
    expect(body).toContain(FR_LABELS.negativeMarking);
    expect(mcqServer.statementDoc!(student, FR_LABELS).find((b) => b.kind === "choices")).toMatchObject({ multiple: true });
  });
});
