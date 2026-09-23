/** Fixtures of the `codeimage` tests: one fully populated config and its target. */
import { encodeImage } from "../pixels.js";
import { CodeImageConfig } from "../schema.js";

export const IMG_SECRET_REFERENCE =
  "    for (int y = 0; y < 4; y++) { /* secret-image-reference */ }";
export const IMG_SECRET_COMPILE_ARGS = "-std=c17 -DIMAGE_SECRET_FLAG";
export const IMG_SECRET_FILE = "seed,0x7e57\n";

export const IMG_TEMPLATE = `// @@lock
#include <stdio.h>

int main(void) {
// @@endlock
    // draw here
// @@lock
    return 0;
}
// @@endlock
`;

/** A 4 × 3 checkerboard, row-major: 1 0 1 0 / 0 1 0 1 / 1 0 1 0. */
export const CHECKER = [1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0];
export const CHECKER_STDOUT = "1 0 1 0\n0 1 0 1\n1 0 1 0\n";

export function imageConfig(overrides: Record<string, unknown> = {}): CodeImageConfig {
  return CodeImageConfig.parse({
    configVersion: 1,
    prompt: "Draw a checkerboard.",
    language: "c",
    template: IMG_TEMPLATE,
    files: [{ name: "seed.csv", content: IMG_SECRET_FILE }],
    compileArgs: IMG_SECRET_COMPILE_ARGS,
    referenceSolution: IMG_SECRET_REFERENCE,
    image: { width: 4, height: 3, palette: "bw" },
    target: encodeImage(CHECKER, "bw"),
    ...overrides,
  });
}
