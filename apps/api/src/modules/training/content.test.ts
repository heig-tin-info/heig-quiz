/**
 * The training content (ADR-105 §2, §3) holds against the gates it will meet
 * at install: every config parses with its type's schema and passes its
 * publication hook, every evaluation names questions that exist, the welcome
 * quiz holds exactly one question per automatically graded type, and no key
 * of a short or cloze question is a string of the interface (Assumption 5).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCloze } from "@quiz/domain/cloze";
import { questionType } from "@quiz/registry/server";

import { TRAINING_CONTENT } from "./content.js";

const { questions, evaluations } = TRAINING_CONTENT;
const byName = new Map(questions.map((q) => [q.internalName, q]));

/** ADR-105 §3, mission 1: the automatically graded types on `main`. */
const WELCOME_TYPES = ["mcq", "short", "cloze", "categorize", "math", "circuit", "code"] as const;

/** The two dictionaries of the web app, read as text: `apps/web` is not a dependency of the API. */
const I18N = ["en", "fr"].map((locale) =>
  fileURLToPath(new URL(`../../../../web/src/i18n/${locale}.ts`, import.meta.url)),
);

/** Every double-quoted string literal of the dictionaries, lower-cased: keys, values and fragments. */
function uiStrings(): Set<string> {
  const strings = new Set<string>();
  for (const file of I18N) {
    for (const match of readFileSync(file, "utf8").matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      strings.add(match[1]!.trim().toLowerCase());
    }
  }
  return strings;
}

/** The expected answers of a `short` or `cloze` question, as a student would type them. */
function expectedAnswers(type: string, config: unknown): string[] {
  if (type === "short") {
    const { matchers } = config as { matchers: ({ kind: "exact"; value: string } | { kind: "number"; value: number } | { kind: string })[] };
    return matchers.flatMap((m) => ("value" in m ? [String(m.value)] : []));
  }
  if (type === "cloze") {
    const { blanks } = parseCloze((config as { text: string }).text);
    return blanks.flatMap((blank) => {
      if (blank.kind === "text") return blank.answers;
      if (blank.kind === "number") return [String(blank.value)];
      if (blank.kind === "select") return blank.correct.map((i) => blank.options[i]!);
      return [];
    });
  }
  return [];
}

describe("the training content", () => {
  it("names a pool, two categories and stable internal names", () => {
    expect(TRAINING_CONTENT.pool.name).toBe("Prise en main de Quiz");
    expect(TRAINING_CONTENT.pool.icon).toBe("graduation-cap");
    expect(new Set(questions.map((q) => q.category))).toEqual(new Set(["Quiz d'accueil", "Quiz en direct"]));
    expect(new Set(questions.map((q) => q.internalName)).size).toBe(questions.length);
    for (const q of questions) {
      expect(q.internalName).toMatch(/^init-[a-z0-9-]+$/);
      expect(q.difficulty).toBeGreaterThanOrEqual(1);
      expect(q.difficulty).toBeLessThanOrEqual(2);
      expect(q.explanation.length).toBeGreaterThan(40);
    }
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
    expect(evaluations.map((e) => e.key)).toEqual(["welcome", "live"]);
    for (const evaluation of evaluations) {
      expect(new Set(evaluation.questions).size).toBe(evaluation.questions.length);
      for (const name of evaluation.questions) expect(byName.has(name), name).toBe(true);
    }
    const welcome = evaluations.find((e) => e.key === "welcome")!;
    expect(welcome.mode).toBe("exercise");
    expect(welcome.target).toBe("scheduled");
    expect(welcome.questions.map((name) => byName.get(name)!.type)).toEqual([...WELCOME_TYPES]);

    const live = evaluations.find((e) => e.key === "live")!;
    expect(live.mode).toBe("exam");
    expect(live.target).toBe("draft");
    const liveTypes = live.questions.map((name) => byName.get(name)!.type);
    expect(liveTypes).toContain("rich");
    expect(liveTypes).toContain("diagram");
    expect(liveTypes).toContain("mcq");
    expect(liveTypes).toContain("short");
  });

  it("keys no short or cloze question on a string of the interface (Assumption 5)", () => {
    const strings = uiStrings();
    expect(strings.size).toBeGreaterThan(1000);
    const checked: string[] = [];
    for (const q of questions) {
      for (const answer of expectedAnswers(q.type, q.config)) {
        checked.push(answer);
        expect(strings.has(answer.trim().toLowerCase()), `${q.internalName}: "${answer}" is a UI string`).toBe(false);
      }
    }
    // The check looked at something: the short's number and the cloze's four blanks.
    expect(checked.length).toBeGreaterThanOrEqual(5);
  });
});
