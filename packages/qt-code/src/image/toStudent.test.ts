/**
 * The type-specific half of the leak test of `codeimage` (invariant 4,
 * docs/spec/05 §5.7). The generic half — the full fixture of
 * `../testing.ts` searched for every forbidden key and secret value, and
 * parsed by the student schema — is the registry's contract test.
 *
 * The TARGET is not a secret: it is the picture to draw, published on
 * purpose like a visible case, and so are the compiler flags and the extra
 * files, public program inputs (ADR-096). The reference solution is secret.
 */
import { describe, expect, it } from "vitest";

import { IMG_COMPILE_ARGS, IMG_FILE, IMG_SECRET_REFERENCE, imageConfig } from "./test/fixtures.js";
import { codeimageServer } from "./server.js";

const view = { seed: 7, itemId: "item-1", shuffle: true };

describe("codeimageServer.toStudent", () => {
  const config = imageConfig();
  const student = codeimageServer.toStudent(config, view);

  it("publishes the target, the size and the palette on purpose", () => {
    expect(student.target).toEqual(config.target);
    expect(student.image).toEqual({ width: 4, height: 3, palette: "bw" });
  });

  it("passes the cooldown rule through, a UI pace and nothing of the key", () => {
    expect(student.cooldown).toBe("fixed");
    const progressive = imageConfig({ cooldown: "progressive" });
    expect(codeimageServer.toStudent(progressive, view).cooldown).toBe("progressive");
  });

  it("publishes the extra files whole and the compiler flags (ADR-096)", () => {
    expect(student.files).toEqual([{ name: "seed.csv", content: IMG_FILE }]);
    expect(student.compileArgs).toBe(IMG_COMPILE_ARGS);
  });

  it("keeps the reference solution for the solution view alone", () => {
    expect(codeimageServer.toSolution(config, view).referenceSolution).toBe(IMG_SECRET_REFERENCE);
  });
});
