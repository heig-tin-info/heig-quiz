/**
 * The type-specific half of the leak test of `codeimage` (invariant 4,
 * docs/spec/05 §5.7). The generic half — the full fixture of
 * `../testing.ts` searched for every forbidden key and secret value, and
 * parsed by the student schema — is the registry's contract test.
 *
 * The TARGET is not a secret: it is the picture to draw, published on
 * purpose like a visible case. The reference solution, the compiler flags
 * and the extra files' bytes are.
 */
import { describe, expect, it } from "vitest";

import { IMG_SECRET_FILE, IMG_SECRET_REFERENCE, imageConfig } from "../testing.js";
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

  it("names the extra files without their bytes", () => {
    expect(student.filesPreview).toEqual([{ name: "seed.csv", bytes: IMG_SECRET_FILE.length }]);
  });

  it("keeps the reference solution for the solution view alone", () => {
    expect(codeimageServer.toSolution(config, view).referenceSolution).toBe(IMG_SECRET_REFERENCE);
  });
});
