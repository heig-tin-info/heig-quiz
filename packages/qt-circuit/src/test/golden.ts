/**
 * A minimal golden-file check, independent of vitest's snapshot machinery:
 * the value is serialised as pretty JSON and compared with a committed file
 * under `src/test/golden/`. `GOLDEN_UPDATE=1` writes the files instead — do
 * that only against code whose behaviour is the reference.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

export function expectGolden(name: string, value: unknown): void {
  const file = join(DIR, `${name}.json`);
  const text = `${JSON.stringify(value, null, 1)}\n`;
  if (process.env.GOLDEN_UPDATE === "1") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return;
  }
  if (!existsSync(file)) throw new Error(`missing golden file ${file}; run with GOLDEN_UPDATE=1`);
  expect(text).toBe(readFileSync(file, "utf8"));
}
