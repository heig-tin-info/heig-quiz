/**
 * The type-specific half of the leak test (docs/05 §5.7, N-SEC-04). The
 * generic half — the full fixture of `./testing.ts` through `toStudent`,
 * shuffle on and off — is the registry's contract test. A brainstorm has no
 * key (ADR-071), so what must not leak is whatever else a stored config may
 * carry: the version and any field the view does not name.
 */
import { findStudentLeaks } from "@quiz/core/testing";
import { describe, expect, it } from "vitest";

import { brainstormServer } from "./server.js";
import { brainstormLeakFixture } from "./testing.js";

const view = { seed: 7, itemId: "i", shuffle: true };

/** Fields a stored row could carry beside the config, each with a value searched for in the output. */
const STRAY = {
  internalName: "SECRET-INTERNAL-NAME",
  explanation: "SECRET-EXPLANATION",
  concepts: ["SECRET-CONCEPT"],
  difficulty: "SECRET-DIFFICULTY",
};

describe("toStudent", () => {
  it("keeps exactly what the player needs: the prompt and the cap", () => {
    const student = brainstormServer.toStudent(brainstormLeakFixture.config, view);
    expect(student).toEqual({ prompt: "What makes something a living being?", maxIdeas: 4 });
    expect(findStudentLeaks(student, brainstormLeakFixture)).toEqual([]);
  });

  it("names its fields rather than copying the config: nothing stray comes out, by key or by value", () => {
    const config = { ...brainstormLeakFixture.config, ...STRAY };
    const student = brainstormServer.toStudent(config, view);
    const forbiddenKeys = [...brainstormLeakFixture.forbiddenKeys, ...Object.keys(STRAY)];
    const secrets = ["SECRET-INTERNAL-NAME", "SECRET-EXPLANATION", "SECRET-CONCEPT", "SECRET-DIFFICULTY"];
    expect(findStudentLeaks(student, { forbiddenKeys, secrets })).toEqual([]);
    expect(Object.keys(student).sort()).toEqual(["maxIdeas", "prompt"]);
  });

  it("does not depend on the seed: there is nothing to shuffle", () => {
    expect(brainstormServer.toStudent(brainstormLeakFixture.config, { ...view, seed: 1 })).toEqual(
      brainstormServer.toStudent(brainstormLeakFixture.config, { ...view, seed: 2 }),
    );
  });
});
