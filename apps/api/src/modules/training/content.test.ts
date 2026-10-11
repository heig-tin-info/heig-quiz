/**
 * The training content (ADR-105 §2, §3) holds against the gates it will meet
 * at install: every config parses with its type's schema and passes its
 * publication hook, every evaluation names questions that exist, the welcome
 * quiz holds exactly one question per automatically graded type, and no key
 * is free text that a label of the interface could spell (Assumption 5).
 */
import { describe, expect, it } from "vitest";

import { parseCloze } from "@quiz/domain/cloze";
import { questionType } from "@quiz/registry/server";

import { TRAINING_CONTENT } from "./content.js";

const { questions, evaluations } = TRAINING_CONTENT;
const byName = new Map(questions.map((q) => [q.internalName, q]));

/** ADR-105 §3, mission 1: the automatically graded types on `main`, in the quiz's order. */
const WELCOME_TYPES = ["mcq", "short", "cloze", "categorize", "math", "circuit", "code"];

describe("the training content", () => {
  it("names every question once", () => {
    expect(new Set(questions.map((q) => q.internalName)).size).toBe(questions.length);
  });

  it.each(questions.map((q) => [q.internalName, q] as const))(
    "%s parses with its type's schema and passes its publication gate",
    (_name, q) => {
      const type = questionType(q.type);
      const parsed = type.configSchema.safeParse(q.config);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues, null, 1)).toBe(true);
      if (!parsed.success) return;
      expect(type.publicationIssues?.(parsed.data) ?? []).toEqual([]);
    },
  );

  it("builds the two evaluations from questions that exist, in the states ADR-105 names", () => {
    for (const evaluation of evaluations) {
      for (const name of evaluation.questions) expect(byName.has(name), name).toBe(true);
    }
    const welcome = evaluations.find((e) => e.key === "welcome")!;
    expect(welcome.mode).toBe("exercise");
    expect(welcome.target).toBe("scheduled");
    expect(welcome.questions.map((name) => byName.get(name)!.type)).toEqual(WELCOME_TYPES);
    // The short asks for its own position in the navigator: its key IS that position.
    const shortIndex = welcome.questions.findIndex((name) => byName.get(name)!.type === "short");
    const short = byName.get(welcome.questions[shortIndex]!)!.config as { matchers: { value: number }[] };
    expect(short.matchers[0]!.value).toBe(shortIndex + 1);

    const live = evaluations.find((e) => e.key === "live")!;
    expect(live.mode).toBe("exam");
    expect(live.target).toBe("draft");
    const liveTypes = live.questions.map((name) => byName.get(name)!.type);
    expect(liveTypes).toContain("rich");
    expect(liveTypes).toContain("diagram");
  });

  it("keys no short or cloze question on free text, so no key can be a label of the interface", () => {
    for (const q of questions) {
      if (q.type === "short") {
        const { matchers } = q.config as { matchers: { kind: string }[] };
        expect(matchers.map((m) => m.kind), q.internalName).toEqual(matchers.map(() => "number"));
      }
      if (q.type === "cloze") {
        const { blanks } = parseCloze((q.config as { text: string }).text);
        expect(blanks.length, q.internalName).toBeGreaterThan(0);
        for (const blank of blanks) expect(["number", "select"], q.internalName).toContain(blank.kind);
      }
    }
  });
});
