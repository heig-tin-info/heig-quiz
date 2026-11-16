/**
 * The collection's token (ADR-078 §3, root invariant 15): on the paths where
 * GitHub fails — the fetch of a base the host lacks, the push — the token
 * reaches git through the environment only, never a spawned git's argv,
 * and no log line carries it. Every `execFile` of this file is recorded.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = ((file: string, args: readonly string[], ...rest: unknown[]) => {
    spawned.push([file, ...args]);
    return (actual.execFile as (...a: unknown[]) => unknown)(file, args, ...rest);
  }) as typeof actual.execFile;
  // `promisify(execFile)` resolves `{ stdout, stderr }` through this symbol.
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: (file: string, args: readonly string[], options: object) => {
      spawned.push([file, ...args]);
      return (actual.execFile as unknown as { [k: symbol]: (...a: unknown[]) => unknown })[Symbol.for("nodejs.util.promisify.custom")]!(file, args, options);
    },
  });
  return { ...actual, execFile };
});

const { collectWorkspace } = await import("./collect.js");
const { basicAuthorization } = await import("./quizForge.js");
const { FIXTURE_ENV, tempDir } = await import("./fixtures.js");
const { git } = await import("./gitRunner.js");
const { stagingPaths } = await import("./staging.js");

const TOKEN = "ghs_collectSecretToken0123456789";
const AUTHORIZATION = basicAuthorization(TOKEN);
const USER = "6f1c2a8e-1b2c-4d5e-8f90-123456789abc";
const PROJECT = "0b8e2f0a-6c1e-4c55-9a43-2f1e0c9d8a11";
/** An https origin nothing listens on: git sends the header there, and fails at once. */
const URL = "https://127.0.0.1:9/heig-tin-info/lab3-alice.git";

const roots: string[] = [];
afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

async function volume(): Promise<{ volumesRoot: string; base: string }> {
  const root = await tempDir("collect-test-");
  roots.push(root);
  const seed = join(root, "seed");
  await git(["init", "--quiet", "--initial-branch=main", seed]);
  await writeFile(join(seed, "main.c"), "int main(void) { return 1; }\n");
  await git(["-C", seed, "add", "-A"], { env: FIXTURE_ENV });
  await git(["-C", seed, "commit", "--quiet", "-m", "handout"], { env: FIXTURE_ENV });
  const base = (await git(["-C", seed, "rev-parse", "HEAD"])).trim();
  const volumesRoot = join(root, "volumes");
  const paths = stagingPaths(volumesRoot, USER, PROJECT);
  await mkdir(paths.dir, { recursive: true });
  await git(["clone", "--quiet", "--bare", seed, paths.gitDir]);
  await git(["clone", "--quiet", seed, paths.workDir]);
  await writeFile(join(paths.workDir, "main.c"), "changed\n");
  return { volumesRoot, base };
}

function secretsIn(text: string): string[] {
  return [TOKEN, AUTHORIZATION, AUTHORIZATION.split(" ")[1]!].filter((secret) => text.includes(secret));
}

describe("the collection's token", () => {
  for (const path of ["fetch", "push"] as const) {
    it(`stays out of argv and logs when the ${path} fails`, async () => {
      const { volumesRoot, base } = await volume();
      const lines: string[] = [];
      spawned.length = 0;
      const result = await collectWorkspace(
        {
          assignment: PROJECT,
          userId: USER,
          repository: "heig-tin-info/lab3-alice",
          // The fetch path asks GitHub for a base the host does not hold.
          base: path === "fetch" ? "b".repeat(40) : base,
          target: null,
          keep: [],
          ref: "refs/quiz/collect/r1-1794836400",
        },
        {
          volumesRoot,
          forge: { pushUrl: () => URL, authorization: async () => AUTHORIZATION },
          lastPushAt: null,
          log: { warn: (o, m) => void lines.push(JSON.stringify(o), m) },
        },
      );
      expect(result).toEqual({ outcome: "failed", reason: "forge_unavailable" });
      // The failing command did run, with the URL and without the token.
      expect(spawned.some((argv) => argv.includes(path) && argv.includes(URL))).toBe(true);
      expect(secretsIn(spawned.flat().join("\n"))).toEqual([]);
      expect(lines.length).toBeGreaterThan(0);
      expect(secretsIn(lines.join("\n"))).toEqual([]);
    });
  }
});
