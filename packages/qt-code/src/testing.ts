/**
 * `@quiz/qt-code/testing` — the full configurations of the leak test of both
 * types of the package, `code` and `codeimage` (invariant 4, docs/spec/05
 * §5.7). TEST-ONLY: nothing in `apps/*` imports it.
 */
import type { StudentLeakFixture } from "@quiz/core/testing";

import { encodeImage } from "./image/pixels.js";
import { CodeImageConfig } from "./image/schema.js";
import { CodeConfig } from "./schema.js";

// ---------------------------------------------------------------------------
// code
// ---------------------------------------------------------------------------

/** The C template of PLAN-MVP §2.4: two locked regions, two editable ones. */
export const C_TEMPLATE = `#include <stdio.h>
// @@lock
int sum(const int *t, int n)
{
// @@endlock
    int total = 0;
    return total;
// @@lock
}

int main(void) {
    int n;
    if (scanf("%d", &n) != 1) return 1;
    printf("%d\\n", 0);
    return 0;
}
// @@endlock
`;

export const SECRET_HIDDEN_STDIN = "4\n-1 -2 3 5\n";
export const SECRET_HIDDEN_EXPECTED = "5 (hidden-expected-marker)";
export const SECRET_HIDDEN_NAME = "negative-values";
/** A hidden case's command line is part of the key: it must never reach a student. */
export const SECRET_HIDDEN_ARG = "--secret-hidden-arg";
export const SECRET_REFERENCE = "int secret_reference_solution(void) { return 42; }";
export const SECRET_FILE_CONTENT = "id,answer\n1,0x1004\n";
export const SECRET_COMPILE_ARGS = "-Wall -Wextra -std=c17 -DSECRET_FLAG";

export function codeConfig(): CodeConfig {
  return CodeConfig.parse({
    configVersion: 1,
    prompt: "Sum the integers read on stdin.",
    language: "c",
    runtime: "backend",
    cooldown: "progressive",
    template: C_TEMPLATE,
    files: [{ name: "data.csv", content: SECRET_FILE_CONTENT }],
    action: "run",
    compileArgs: SECRET_COMPILE_ARGS,
    limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
    runsPerMinute: 10,
    allOrNothing: false,
    referenceSolution: SECRET_REFERENCE,
    tests: {
      mode: "io",
      compare: { trimTrailing: true, ignoreCase: false, numeric: null },
      cases: [
        { name: "three items", stdin: "3\n1 2 3\n", expected: "6\n", visible: true, points: 1 },
        { name: "empty array", stdin: "0\n", expected: "0\n", visible: true, points: 1 },
        {
          name: SECRET_HIDDEN_NAME,
          args: [SECRET_HIDDEN_ARG],
          stdin: SECRET_HIDDEN_STDIN,
          expected: SECRET_HIDDEN_EXPECTED,
          visible: false,
          points: 2,
        },
      ],
    },
  });
}

/*
 * `expected` is not forbidden: a VISIBLE case publishes its expected output
 * on purpose — the player shows "stdin / expected / got" and the student is
 * meant to compare them (docs/spec/04 §4.7). The hidden ones are covered by
 * the value search, which is the check that actually matters here. `compare`
 * is out of the floor since audit R-06 and published on purpose (HOW, never
 * WHAT); its exact shape is pinned by `toStudent.test.ts`.
 */
export const codeLeakFixture: StudentLeakFixture<CodeConfig> = {
  config: codeConfig(),
  forbiddenKeys: ["action", "content", "files", "policy", "tolerance"],
  secrets: [
    SECRET_HIDDEN_STDIN,
    SECRET_HIDDEN_EXPECTED,
    SECRET_HIDDEN_NAME,
    // A hidden case's command line says as much as its stdin does.
    SECRET_HIDDEN_ARG,
    SECRET_REFERENCE,
    SECRET_FILE_CONTENT,
    SECRET_COMPILE_ARGS,
    "0x1004",
  ],
};

// ---------------------------------------------------------------------------
// codeimage
// ---------------------------------------------------------------------------

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
    target: { width: 4, height: 3, palette: "bw", pixels: encodeImage(CHECKER, "bw") },
    ...overrides,
  });
}

/*
 * The TARGET is not a secret: it is the picture to draw, published on purpose
 * like a visible case. The reference solution, the compiler flags and the
 * extra files' bytes are.
 */
export const codeimageLeakFixture: StudentLeakFixture<CodeImageConfig> = {
  config: imageConfig(),
  forbiddenKeys: ["action", "content", "files", "compare", "policy", "tolerance", "configVersion"],
  secrets: [IMG_SECRET_REFERENCE, IMG_SECRET_COMPILE_ARGS, IMG_SECRET_FILE, "0x7e57"],
};
