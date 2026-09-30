/**
 * The type-specific half of the leak test (PLAN-MVP §2.5, docs/05 §5.7,
 * N-SEC-04). The generic half — the full fixture of `./testing.ts` searched
 * for every forbidden key and secret value — is the registry's contract test.
 */
import { describe, expect, it } from "vitest";
import { SECRET_CONFIG } from "./testing.js";
import { shortServer } from "./server.js";

describe("toStudent", () => {
  const view = { seed: 7, itemId: "i", shuffle: true };

  it("keeps exactly what the player needs", () => {
    const student = shortServer.toStudent(SECRET_CONFIG, view);
    expect(Object.keys(student).sort()).toEqual(["constraints", "kind", "placeholder", "prompt"]);
  });

  it("carries the constraints, which are what the FIELD takes and not the key", () => {
    const student = shortServer.toStudent(SECRET_CONFIG, view);
    expect(student.constraints).toEqual({
      minLength: 0,
      maxLength: 255,
      integer: true,
      min: 1,
      max: 100,
    });
  });

  it("omits the placeholder when the teacher set none", () => {
    const student = shortServer.toStudent(
      { ...SECRET_CONFIG, placeholder: undefined },
      view,
    );
    expect("placeholder" in student).toBe(false);
  });

  it("does not depend on the seed: there is nothing to shuffle", () => {
    expect(shortServer.toStudent(SECRET_CONFIG, { ...view, seed: 1 })).toEqual(
      shortServer.toStudent(SECRET_CONFIG, { ...view, seed: 2 }),
    );
  });
});
