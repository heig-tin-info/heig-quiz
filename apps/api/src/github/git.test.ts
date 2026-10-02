import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { credentialEnv, gitRunner, repoUrl, setRemoteBaseForTests } from "./git.js";

// The real git, observed: every call's argv and environment are recorded.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
  };
});
const spawned = vi.mocked(execFile);

const TOKEN = "ghs_secret123FAKEFAKE";
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

describe("gitRunner", () => {
  const dir = mkdtempSync(join(tmpdir(), "quiz-git-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Braces: a function returned by beforeEach is run as its cleanup, and
  // mockClear() returns the mock itself.
  beforeEach(() => {
    spawned.mockClear();
  });

  // A local bare repository stands for GitHub: offline, and a clone of it
  // writes a real `.git/config` to inspect. Seeded with git itself, not the
  // runner, so the calls below are the only ones observed.
  const plain = gitRunner({ identity: true });
  const remote = join(dir, "remote.git");
  const seed = join(dir, "seed");
  const sh = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  sh("init", "-q", "--bare", "-b", "main", remote);
  sh("init", "-q", "-b", "main", seed);
  // No signing: a workstation's global config must not change the outcome.
  sh("-C", seed, "-c", "user.name=seed", "-c", "user.email=seed@x", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "seed");
  sh("-C", seed, "push", "-q", remote, "main");

  it("runs git without blocking the event loop", async () => {
    let ticked = false;
    setImmediate(() => (ticked = true));
    const out = plain.git(dir, "ls-remote", `file://${remote}`);
    expect(out).toBeInstanceOf(Promise);
    await out;
    expect(ticked).toBe(true);
  });

  it("commits as the bot when asked for an identity, never signing", async () => {
    await plain.git(seed, "commit", "-q", "--allow-empty", "-m", "bot");
    expect(JSON.stringify(spawned.mock.calls.at(-1)![1])).toContain("commit.gpgsign=false");
    expect((await plain.git(seed, "log", "-1", "--format=%an <%ae>")).trim()).toBe("heig-quiz <bot@heig-quiz.local>");
  });

  it("leaves no token in a clone's config (N-SEC-16)", async () => {
    const { git } = gitRunner({ token: TOKEN });
    await git(dir, "clone", "--quiet", `file://${remote}`, "clone");
    const clone = join(dir, "clone");
    expect((await git(clone, "config", "--get", "remote.origin.url")).trim()).toBe(`file://${remote}`);
    const config = readFileSync(join(clone, ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain(BASIC);
    expect(config).not.toMatch(/extraheader|authorization/i);
  });

  it("hands the token to git through the environment only, never the argv", async () => {
    const { git } = gitRunner({ identity: true, token: TOKEN });
    await git(dir, "ls-remote", `file://${remote}`);
    expect(spawned).toHaveBeenCalledTimes(1);
    const [, args, options] = spawned.mock.calls[0]!;
    expect(JSON.stringify(args)).not.toContain(TOKEN);
    expect(JSON.stringify(args)).not.toContain(BASIC);
    expect(options?.env).toMatchObject(credentialEnv(TOKEN));
    expect(options?.env?.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${BASIC}`);
    // Scoped to github.com: no other host is ever sent the header.
    expect(options?.env?.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    // And this git really reads it (GIT_CONFIG_COUNT needs git >= 2.31).
    expect((await git(dir, "config", "--get", "http.https://github.com/.extraheader")).trim()).toBe(
      `AUTHORIZATION: basic ${BASIC}`,
    );
  });

  it("sets no credential without a token", async () => {
    await plain.git(dir, "ls-remote", `file://${remote}`);
    expect(spawned.mock.calls[0]![2]?.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it("throws a redacted error on failure", async () => {
    const { git } = gitRunner({ token: TOKEN });
    let message = "";
    try {
      // Not a repository: git fails locally, echoing its arguments.
      await git(dir, "push", `https://x-access-token:${TOKEN}@github.com/none/none.git`);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(TOKEN);
  });
});

describe("repoUrl", () => {
  it("carries no credential", () => {
    expect(repoUrl("org", "repo")).toBe("https://github.com/org/repo.git");
  });

  it("points at local bare repositories for the tests, and back at GitHub", () => {
    setRemoteBaseForTests("file:///tmp/remotes");
    expect(repoUrl("org", "repo")).toBe("file:///tmp/remotes/org/repo.git");
    setRemoteBaseForTests(null);
    expect(repoUrl("org", "repo")).toBe("https://github.com/org/repo.git");
  });
});
