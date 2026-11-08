/**
 * The type-specific half of the leak test (docs/05 §5.7, N-SEC-04). The
 * generic half — the full fixture of `./testing.ts` through `toStudent`,
 * shuffle on and off — is the registry's contract test. A brainstorm has no
 * key (ADR-071): its view is exactly the prompt and the cap, nothing else.
 */
import { findStudentLeaks } from "@quiz/core/testing";
import { describe, expect, it } from "vitest";

import { brainstormServer } from "./server.js";
import { brainstormLeakFixture } from "./testing.js";

const view = { seed: 7, itemId: "i", shuffle: true };

describe("toStudent", () => {
  it("keeps exactly what the player needs: the prompt and the cap", () => {
    const student = brainstormServer.toStudent(brainstormLeakFixture.config, view);
    expect(student).toEqual({ prompt: "What makes something a living being?", maxIdeas: 4 });
    expect(findStudentLeaks(student, brainstormLeakFixture)).toEqual([]);
  });

  it("does not depend on the seed: there is nothing to shuffle", () => {
    expect(brainstormServer.toStudent(brainstormLeakFixture.config, { ...view, seed: 1 })).toEqual(
      brainstormServer.toStudent(brainstormLeakFixture.config, { ...view, seed: 2 }),
    );
  });
});
