import { describe, expect, it } from "vitest";
import { isGraded } from "@quiz/core/server";
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

  it("never asks the runner nor the LLM", async () => {
    const result = await richServer.grade(config(), { text: "x" }, gradeContext(1));
    expect(result.kind).toBe("graded");
  });
});

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

  it("migrates its own version by identity and refuses an unknown one", () => {
    const draft = richServer.emptyDraft();
    expect(richServer.migrate(draft, 1)).toBe(draft);
    expect(() => richServer.migrate(draft, 0)).toThrow();
  });
});
