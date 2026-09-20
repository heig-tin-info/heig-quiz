import { UnknownQuestionType } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { clientRegistry, questionTypeClient } from "./client.js";
import { QUESTION_TYPE_IDS, questionType, registeredServerIds, serverRegistry } from "./server.js";

describe("the static registries", () => {
  it("are still empty: WP2 and WP3 have not registered anything yet", () => {
    expect(registeredServerIds()).toEqual([]);
    expect(Object.keys(clientRegistry)).toEqual([]);
  });

  it("reject every id until a type is registered", () => {
    for (const id of QUESTION_TYPE_IDS) {
      expect(() => questionType(id)).toThrow(UnknownQuestionType);
      expect(() => questionTypeClient(id)).toThrow(UnknownQuestionType);
    }
  });

  it("expose the four MVP ids", () => {
    expect(QUESTION_TYPE_IDS).toEqual(["mcq", "short", "cloze", "code"]);
    expect(serverRegistry).toEqual({});
  });
});
