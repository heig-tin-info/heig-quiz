/**
 * The type-specific half of the leak test (PLAN-MVP §2.5, docs/05 §5.7,
 * N-SEC-04). The generic half — the full fixture of `./testing.ts` searched
 * for every forbidden key and secret value — is the registry's contract test.
 */
import { describe, expect, it } from "vitest";
import { SECRET_CONFIG } from "./testing.js";
import { richServer } from "./server.js";

describe("toStudent", () => {
  const view = { seed: 7, itemId: "i", shuffle: true };

  it("keeps exactly what the player needs", () => {
    const student = richServer.toStudent(SECRET_CONFIG, view);
    expect(student).toEqual({ prompt: SECRET_CONFIG.prompt, format: "markdown", maxChars: 3000 });
  });

  it("omits the limit when the teacher set none", () => {
    const { maxChars: _drop, ...unlimited } = SECRET_CONFIG;
    expect("maxChars" in richServer.toStudent(unlimited, view)).toBe(false);
  });
});
