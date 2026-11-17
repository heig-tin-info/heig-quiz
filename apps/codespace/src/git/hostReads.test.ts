/**
 * A static guard of the portal's invariant 15, run in CI (the property itself
 * is proved on a real engine, `engine/reader.integration.test.ts`, which CI
 * does not run): the collection's host-side code names the work tree — its
 * host path, the volume's directory, or `/work` — in the places listed here
 * only. A new host-side read of `work/` (a `readFile`, a `git --work-tree`, a
 * walk, a path built from a template literal or through `paths.dir`) fails
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
    .filter((line) => /workDir|paths\.dir|work\/|\/work\b|--work-tree|"work"/.test(line));
}

describe("invariant 15: no host-side read of work/ on the collection's path", () => {
  it("collect.ts only asks whether work/ exists and hands it to the reader", () => {
    expect(workTreeLines(source("./collect.ts"))).toEqual([
      'if (!(await isDirectory(paths.workDir))) return { outcome: "no_snapshot" };',
      "read = await readWorkTree(deps.reader, paths.workDir, repoDir, left(), caps);",
    ]);
  });

  it("workTree.ts only hands work/ to the reader", () => {
    expect(workTreeLines(source("./workTree.ts"))).toEqual([
      "export async function readWorkTree(reader: WorkspaceReader, workDir: string, repoDir: string, timeoutMs: number, caps: Caps): Promise<WorkTree> {",
      "return reader.read(workDir, timeoutMs, async (listing, archive) => {",
    ]);
  });

  it("reader.ts names the host path only to mount it; /work is the container's own", () => {
    const lines = workTreeLines(source("../engine/reader.ts"));
    // The host path: received, handed to `readerArgs`, and the `-v` mount argument — nothing else.
    expect(lines.filter((l) => /workDir|paths\.dir/.test(l))).toEqual([
      "export function readerArgs(o: ReaderOptions, name: string, workDir: string, lifetimeSeconds: number): string[] {",
      "`${workDir}:/work:ro,nosuid,nodev,noexec`,",
      "read<T>(workDir: string, timeoutMs: number, consume: (listing: WorkListing, archive: Readable) => Promise<T>, maxEntries?: number): Promise<T>;",
      "workDir: string,",
      'await ok(readerArgs(o, name, workDir, Math.max(1, Math.ceil(timeoutMs / 1000))), deadline, "starting the reader");',
    ]);
    // `/work` otherwise only as the argument of a command run inside the reader.
    expect(lines.filter((l) => !/workDir|paths\.dir/.test(l))).toEqual(['"--work-tree=/work",', '"--directory=/work",']);
  });

  it("workArchive.ts touches no file at all", () => {
    expect(source("./workArchive.ts")).not.toMatch(/node:fs|node:child_process/);
  });
});
