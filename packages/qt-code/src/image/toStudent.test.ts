/**
 * The mandatory leak test of `codeimage` (invariant 4, docs/spec/05 §5.7):
 * a forbidden-key list on the serialized student view AND a search for the
 * literal secret values of a fully populated configuration.
 *
 * The TARGET is not a secret: it is the picture to draw, published on
 * purpose like a visible case. The reference solution, the compiler flags
 * and the extra files' bytes are.
 */
import { describe, expect, it } from "vitest";

import { COMMON_FORBIDDEN_STUDENT_KEYS } from "@quiz/core/server";

import { CodeImageStudent } from "./schema.js";
import { codeimageServer } from "./server.js";
import {
  IMG_SECRET_COMPILE_ARGS,
  IMG_SECRET_FILE,
  IMG_SECRET_REFERENCE,
  imageConfig,
} from "./test/fixtures.js";

const FORBIDDEN_KEYS = [
  ...COMMON_FORBIDDEN_STUDENT_KEYS,
  "action",
  "content",
  "files",
  "compare",
  "policy",
  "tolerance",
  "configVersion",
];

const SECRET_VALUES = [IMG_SECRET_REFERENCE, IMG_SECRET_COMPILE_ARGS, IMG_SECRET_FILE, "0x7e57"];

const view = { seed: 7, itemId: "item-1", shuffle: true };

describe("codeimageServer.toStudent", () => {
  const config = imageConfig();
  const student = codeimageServer.toStudent(config, view);
  const serialized = JSON.stringify(student);

  it("produces a value its own schema accepts", () => {
    expect(CodeImageStudent.safeParse(student).success).toBe(true);
  });

  it("leaks no forbidden key", () => {
    for (const key of FORBIDDEN_KEYS) expect(serialized, key).not.toContain(`"${key}"`);
  });

  it("leaks no secret value", () => {
    for (const secret of SECRET_VALUES) expect(serialized, secret).not.toContain(secret);
  });

  it("publishes the target, the size and the palette on purpose", () => {
    expect(student.target).toEqual(config.target);
    expect(student.image).toEqual({ width: 4, height: 3, palette: "bw" });
  });

  it("names the extra files without their bytes", () => {
    expect(student.filesPreview).toEqual([{ name: "seed.csv", bytes: IMG_SECRET_FILE.length }]);
  });

  it("keeps the reference solution for the solution view alone", () => {
    expect(codeimageServer.toSolution(config, view).referenceSolution).toBe(IMG_SECRET_REFERENCE);
  });
});
