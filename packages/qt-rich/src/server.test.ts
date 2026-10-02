import { describe, expect, it } from "vitest";
import { isGraded, type LlmService } from "@quiz/core/server";
import { richServer } from "./server.js";
import { config, gradeContext, SECRET_CONFIG } from "./test/fixtures.js";

describe("grade", () => {
  it("proposes 0 points for a written answer: a teacher grades it", async () => {
    const result = await richServer.grade(config(), { text: "The guard page." }, gradeContext(4));
    expect(result).toEqual({
      kind: "graded",
      points: 0,
      maxPoints: 4,
      details: { reason: "manual", chars: 15 },
      state: "proposed",
    });
  });

  it("gives a validated 0 to nothing written, null or blank", async () => {
    for (const answer of [null, { text: "" }, { text: "  \n " }]) {
      const result = await richServer.grade(config(), answer, gradeContext(4));
      expect(isGraded(result) && result.state).toBeUndefined();
      expect(isGraded(result) && result.details.reason).toBe("empty");
      expect(isGraded(result) && result.points).toBe(0);
    }
  });

  it("never asks the runner, nor an LLM the process does not have", async () => {
    const result = await richServer.grade(SECRET_CONFIG, { text: "x" }, gradeContext(1));
    expect(result.kind).toBe("graded");
  });

  it("sends a written answer to the LLM service when there is one", async () => {
    const ctx = { ...gradeContext(4), llm: unusedLlm };
    const result = await richServer.grade(SECRET_CONFIG, { text: "The guard page." }, ctx);
    expect(result).toEqual({
      kind: "pending",
      via: "llm",
      request: {
        statement: SECRET_CONFIG.prompt,
        form: "free text, in markdown",
        rubric: SECRET_CONFIG.rubric,
        reference: SECRET_CONFIG.reference,
        answer: "The guard page.",
        maxPoints: 4,
      },
      details: { reason: "llm", chars: 15 },
    });
  });

  it("keeps an essay with nothing to grade against, and a blank one, off the LLM", async () => {
    const ctx = { ...gradeContext(4), llm: unusedLlm };
    const bare = await richServer.grade(config(), { text: "The guard page." }, ctx);
    expect(isGraded(bare) && bare.details.reason).toBe("manual");
    const blank = await richServer.grade(SECRET_CONFIG, { text: "  " }, ctx);
    expect(isGraded(blank) && blank.details.reason).toBe("empty");
  });
});

/** `grade` only checks that a service exists; the grading pass is the one that calls it. */
const unusedLlm: LlmService = {
  grade() {
    throw new Error("the rich type must never call the LLM itself");
  },
};

describe("answerMisfit", () => {
  it("refuses an answer over the question's limit", () => {
    const limited = config({ maxChars: 10 });
    expect(richServer.answerMisfit?.(limited, { text: "a".repeat(10) })).toBeNull();
    expect(richServer.answerMisfit?.(limited, { text: "a".repeat(11) })).toBe("rich.too_long");
  });

  it("lets any answer through a question without a limit (the schema holds the cap)", () => {
    expect(richServer.answerMisfit?.(config(), { text: "a".repeat(20_000) })).toBeNull();
  });
});

describe("the dashboard and the list", () => {
  it("summarises by the count, never by the text", () => {
    expect(richServer.summarizeAnswer?.(config(), { text: "Secret first line" })).toBe("17");
    expect(richServer.summarizeAnswer?.(config({ maxChars: 3000 }), { text: "abc" })).toBe("3/3000");
  });

  it("counts a blank answer as not answered", () => {
    expect(richServer.isAnswered({ text: " \n" })).toBe(false);
    expect(richServer.isAnswered({ text: "a" })).toBe(true);
  });
});

describe("the key", () => {
  it("serves the rubric and the model answer to the grader", () => {
    expect(richServer.toSolution(SECRET_CONFIG, { seed: 0, itemId: "i", shuffle: false })).toEqual({
      rubric: SECRET_CONFIG.rubric,
      reference: SECRET_CONFIG.reference,
    });
    expect(richServer.toSolution(config(), { seed: 0, itemId: "i", shuffle: false })).toEqual({ rubric: "" });
  });

  it("gives a student the model answer and never the rubric (ADR-037)", () => {
    const view = { seed: 0, itemId: "i", shuffle: false };
    const student = richServer.studentSolution!(richServer.toSolution(SECRET_CONFIG, view), SECRET_CONFIG);
    expect(student).toEqual({ reference: SECRET_CONFIG.reference });
    expect(JSON.stringify(student)).not.toContain("RUBRIC-SECRET");
  });

  it("gives a student nothing when there is no model answer", () => {
    const view = { seed: 0, itemId: "i", shuffle: false };
    for (const cfg of [config({ rubric: "criteria" }), config({ rubric: "criteria", reference: "  " })]) {
      expect(richServer.studentSolution!(richServer.toSolution(cfg, view), cfg)).toBeNull();
    }
  });

  it("indexes the rubric and the model answer for the teacher's search", () => {
    const text = richServer.searchText(SECRET_CONFIG);
    expect(text).toContain("guard page");
    expect(text).toContain("unmapped memory");
  });

  it("refuses a version it never emitted", () => {
    expect(() => richServer.migrate(richServer.emptyDraft(), 0)).toThrow();
  });
});
