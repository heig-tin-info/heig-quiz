import { UnknownQuestionType } from "@quiz/core/server";
import { describe, expect, it } from "vitest";

import { clientRegistry, questionTypeClient } from "./client.js";
import { QUESTION_TYPE_IDS, questionType, registeredServerIds, serverRegistry } from "./server.js";

/** Registered by WP3; `mcq`, `short` and `cloze` arrive with WP2. */
const REGISTERED = ["code"] as const;

describe("the static registries", () => {
  it("expose the four MVP ids and the types wired up so far", () => {
    expect(QUESTION_TYPE_IDS).toEqual(["mcq", "short", "cloze", "code"]);
    expect(registeredServerIds()).toEqual([...REGISTERED]);
    expect(Object.keys(clientRegistry)).toEqual([...REGISTERED]);
  });

  it("look a registered type up on both sides", () => {
    for (const id of REGISTERED) {
      expect(questionType(id).id).toBe(id);
      expect(questionTypeClient(id).id).toBe(id);
    }
  });

  it("reject an id no package has registered", () => {
    for (const id of QUESTION_TYPE_IDS.filter((i) => !REGISTERED.includes(i as "code"))) {
      expect(() => questionType(id)).toThrow(UnknownQuestionType);
      expect(() => questionTypeClient(id)).toThrow(UnknownQuestionType);
    }
  });

  it("gives every registered server type the whole contract", () => {
    for (const id of REGISTERED) {
      const type = serverRegistry[id]!;
      expect(typeof type.emptyDraft).toBe("function");
      expect(typeof type.migrate).toBe("function");
      expect(typeof type.toStudent).toBe("function");
      expect(typeof type.toSolution).toBe("function");
      expect(typeof type.grade).toBe("function");
      expect(typeof type.searchText).toBe("function");
      expect(type.configSchema.safeParse(type.emptyDraft()).success).toBe(true);
    }
  });

  it("gives every registered client type three lazy surfaces", () => {
    for (const id of REGISTERED) {
      const type = questionTypeClient(id);
      expect(type.labelKey).toBe(`qt.${id}.label`);
      for (const surface of [type.Editor, type.Player, type.Review]) {
        // React.lazy components are objects, not functions: that IS the check.
        expect(typeof surface).toBe("object");
      }
    }
  });
});
