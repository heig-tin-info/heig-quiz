import { UnknownQuestionType } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { clientRegistry, questionTypeClient } from "./client.js";
import { QUESTION_TYPE_IDS, questionType, registeredServerIds, serverRegistry } from "./server.js";

/** The four MVP types. */
const REGISTERED = ["mcq", "short", "cloze", "code"] as const;

describe("the static registries", () => {
  it("hold the four MVP types, in both halves", () => {
    expect(registeredServerIds()).toEqual([...REGISTERED]);
    expect(Object.keys(clientRegistry)).toEqual([...REGISTERED]);
  });

  it("look a type up by its id", () => {
    for (const id of REGISTERED) {
      expect(questionType(id).id).toBe(id);
      expect(questionTypeClient(id).id).toBe(id);
    }
  });

  it("reject an id that no package registers", () => {
    expect(() => questionType("rich")).toThrow(UnknownQuestionType);
  });

  it("expose the four MVP ids", () => {
    expect(QUESTION_TYPE_IDS).toEqual(["mcq", "short", "cloze", "code"]);
    expect(Object.keys(serverRegistry)).toEqual([...REGISTERED]);
  });

  it("agree with themselves: one client entry per server entry", () => {
    expect(Object.keys(clientRegistry)).toEqual(Object.keys(serverRegistry));
  });

  /**
   * The generic version of the §2.5 leak test, over every registered type: a
   * type added later cannot forget it. The per-package suites own the
   * secret-VALUE half, which needs a fixture only they can write.
   */
  it("expose no forbidden key through any toStudent", () => {
    const forbidden = [
      "correct",
      "matchers",
      "answers",
      "expected",
      "pattern",
      "tolerance",
      "policy",
      "penalty",
      "rubric",
      "explanation",
      "tags",
      "difficulty",
    ];
    for (const id of REGISTERED) {
      const type = questionType(id);
      const student = type.toStudent(type.emptyDraft(), { seed: 7, itemId: "i", shuffle: true });
      const out = JSON.stringify(student);
      for (const key of forbidden) expect(out, `${id}.${key}`).not.toContain(`"${key}"`);
      expect(type.studentSchema.safeParse(student).success).toBe(true);
    }
  });

  it("emit a draft that validates, for every registered type", () => {
    for (const id of REGISTERED) {
      const type = questionType(id);
      expect(type.configSchema.safeParse(type.emptyDraft()).success, id).toBe(true);
    }
  });

  it("migrate their own current version by identity", () => {
    for (const id of REGISTERED) {
      const type = questionType(id);
      const draft = type.emptyDraft();
      expect(type.migrate(draft, type.configVersion), id).toBe(draft);
    }
  });
});
