/**
 * A static guard of the portal's invariant 15, run in CI (the property itself
 * is proved on a real engine, `engine/reader.integration.test.ts`, which CI
 * does not run): the collection's host-side code names the work tree in two
 * places only — whether it exists, and the confined reader's call. A new
 * host-side read of `work/` (a `readFile`, a `git --work-tree`, a walk) fails
 * here and has to be argued for.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

/** The code lines (comments dropped) that name the work tree. */
function workTreeLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\*\*|\/\/)/.test(line))
    .map((line) => line.trim())
    .filter((line) => /workDir|work\/|--work-tree|"work"/.test(line));
}

describe("invariant 15: no host-side read of work/ on the collection's path", () => {
  it("collect.ts only asks whether work/ exists and hands it to the reader", () => {
    expect(workTreeLines(source("./collect.ts"))).toEqual([
      'if (!(await isDirectory(paths.workDir))) return { outcome: "no_snapshot" };',
      "read = await readWorkTree(deps.reader, paths.workDir, repoDir, left(), deps.maxBytes ?? RECEIVE_MAX_INPUT_BYTES);",
    ]);
  });

  it("workTree.ts only hands work/ to the reader", () => {
    expect(workTreeLines(source("./workTree.ts"))).toEqual([
      "export async function readWorkTree(reader: WorkspaceReader, workDir: string, repoDir: string, timeoutMs: number, maxBytes: number): Promise<WorkTree> {",
      "return reader.read(workDir, timeoutMs, async (listing, archive) => {",
    ]);
  });

  it("workArchive.ts touches no file at all", () => {
    expect(source("./workArchive.ts")).not.toMatch(/node:fs|node:child_process/);
  });
});
