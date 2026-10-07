/**
 * The relay under ADR-078 §6, in the unit suite (real git on temporary
 * repositories, no forge, no network): never forced — a commit of Quiz's
 * App ahead on the forge is kept, the student's push is `rejected`,
 * `staging.git` takes the forge's head, the student's commit survives —;
 * no deletion relayed; heads declared before the push; Quiz's refusals on
 * the slow backoff; and the `quiz` forge's token in no argv, file, SQLite
 * row, `last_error` nor log line, dropped when the forge refuses it.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openGitDb } from "../db/client.js";
import { FIXTURE_ENV, makeSourceRepo, tempDir } from "./fixtures.js";
import { ForgeRefusedError, type Forge } from "./forge.js";
import { git, gitBare } from "./gitRunner.js";
import { createPushEventStore, lastRejectedPush, recordPush, NULL_OID } from "./pushEvents.js";
import { createQuizForge } from "./quizForge.js";
import { createRelayWorker, DELETION_NOT_RELAYED, parseRejections, refspecFor, stagingTargets, UNCONFIGURED_BACKOFF } from "./relay.js";
import { ensureStagingRepo } from "./staging.js";
import type { RepoRef, StagingSession } from "./types.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const SESSION: StagingSession = {
  sessionId: "s-noforce",
  student: "22222222-2222-4222-8222-222222222222",
  assignment: "11111111-1111-4111-8111-111111111111",
  containerIp: "10.77.0.8",
  uploadPack: true,
  targetRepo: { owner: "org", name: "lab-kid" },
};
const TOKEN = "forgejo-tok-0c9e1a";

function fakeForge(url: string): Forge {
  return {
    kind: "forgejo",
    pushUrl: () => url,
    authorization: async () => `token ${TOKEN}`,
    async ensureRepo() {},
  };
}

async function scenario(dbFile?: string) {
  const base = await tempDir("m610-relay-");
  dirs.push(base);
  const volumesRoot = join(base, "volumes");
  const src = await makeSourceRepo({ dir: join(base, "src"), files: { "main.c": "int main(){}\n" } });
  const staging = await ensureStagingRepo({
    volumesRoot,
    student: SESSION.student,
    assignment: SESSION.assignment,
    source: { mode: "lab", mirrorFrom: src.gitDir },
  });
  const forgeRepo = join(base, "forge.git");
  await git(["init", "-q", "--bare", forgeRepo], { env: FIXTURE_ENV });
  const { db, close } = openGitDb(dbFile ? join(base, dbFile) : ":memory:");
  const store = createPushEventStore(db);
  const repoOf = (): RepoRef | undefined => SESSION.targetRepo;
  return { base, volumesRoot, staging, forgeRepo, store, close, src, repoOf };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

/** The student commits in a clone of the staging repository and pushes; the channel records the `PushEvent`. */
async function studentCommit(s: Scenario, message: string, clone?: string) {
  const dir = clone ?? join(s.base, `clone-${Math.random().toString(36).slice(2)}`);
  if (!clone) await git(["clone", "-q", s.staging.gitDir, dir], { env: FIXTURE_ENV });
  await git(["-C", dir, "commit", "-q", "--allow-empty", "-m", message], { env: FIXTURE_ENV });
  const before = (await gitBare(s.staging.gitDir, ["rev-parse", "refs/heads/main"])).trim();
  await git(["-C", dir, "push", "-q", "origin", "HEAD:main"], { env: FIXTURE_ENV });
  const sha = (await git(["-C", dir, "rev-parse", "HEAD"], { env: FIXTURE_ENV })).trim();
  await recordPush({ store: s.store }, SESSION, [{ ref: "refs/heads/main", oldSha: before, sha }]);
  return { dir, sha };
}

/** Quiz's App commits on the forge meanwhile (a restore, a sync): the forge is ahead. */
async function appCommit(s: Scenario) {
  const dir = join(s.base, "app");
  await git(["clone", "-q", "-b", "main", s.forgeRepo, dir], { env: FIXTURE_ENV });
  await git(["-C", dir, "commit", "-q", "--allow-empty", "-m", "restore a protected file"], { env: FIXTURE_ENV });
  await git(["-C", dir, "push", "-q", "origin", "HEAD:main"], { env: FIXTURE_ENV });
  return (await git(["-C", dir, "rev-parse", "HEAD"], { env: FIXTURE_ENV })).trim();
}

describe("refspecs (ADR-078 §6)", () => {
  it("pushes an exact sha, never forced: a fast-forward or nothing", () => {
    const spec = refspecFor({ ref: "refs/heads/main", sha: "a".repeat(40) });
    expect(spec).toBe(`${"a".repeat(40)}:refs/heads/main`);
    expect(spec.startsWith("+")).toBe(false);
  });

  it("reads git's verdicts: a non-fast-forward, a forge's refusal, and the atomic push's collateral left out", () => {
    const out = [
      "To https://github.com/org/lab.git",
      `!\t${"a".repeat(40)}:refs/heads/main\t[rejected] (fetch first)`,
      `!\t${"b".repeat(40)}:refs/heads/side\t[rejected] (atomic push failed)`,
      `!\t${"c".repeat(40)}:refs/heads/ci\t[remote rejected] (refusing to allow a GitHub App to create or update workflow \`.github/workflows/x.yml\` without \`workflows\` permission)`,
      `!\t${"d".repeat(40)}:refs/heads/old\t[rejected] (non-fast-forward)`,
      `!\t${"e".repeat(40)}:refs/heads/x\t[remote rejected] (atomic transaction failed)`,
      "Done",
    ].join("\n");
    expect(parseRejections(out)).toEqual([
      { ref: "refs/heads/main", reason: "fetch first", behind: true },
      {
        ref: "refs/heads/ci",
        reason: "refusing to allow a GitHub App to create or update workflow `.github/workflows/x.yml` without `workflows` permission",
        behind: false,
      },
      { ref: "refs/heads/old", reason: "non-fast-forward", behind: true },
    ]);
  });
});

describe("the relay never forces (ADR-078 §6)", () => {
  it("keeps the App's commit, rejects the push, moves staging.git to the forge's head; the student's commit survives", async () => {
    const s = await scenario();
    await git(["--git-dir", s.staging.gitDir, "push", "-q", s.forgeRepo, `${s.src.sha}:refs/heads/main`], { env: FIXTURE_ENV });
    const appHead = await appCommit(s);
    const student = await studentCommit(s, "the student's work");
    const order: string[] = [];
    const forge: Forge = {
      ...fakeForge(s.forgeRepo),
      async authorization(_repo, owner) {
        order.push(`authorization ${owner.assignment}/${owner.student}`);
        return `token ${TOKEN}`;
      },
      async declareHeads(_repo, owner, heads) {
        order.push(`declare ${owner.assignment}/${owner.student} ${heads.map((h) => `${h.ref}=${h.sha}`).join(",")}`);
      },
    };
    const worker = createRelayWorker({ store: s.store, forge, targets: stagingTargets(s.volumesRoot, s.repoOf), backoffMs: () => 0 });

    expect(await worker.runOnce()).toEqual({ relayed: 0, retried: 0, failed: 0, rejected: 1 });
    // Declared before the push: the student's head, for this owner.
    const who = `${SESSION.assignment}/${SESSION.student}`;
    expect(order).toEqual([`authorization ${who}`, `declare ${who} refs/heads/main=${student.sha}`]);
    // Nothing erased on the forge.
    expect((await gitBare(s.forgeRepo, ["rev-parse", "refs/heads/main"])).trim()).toBe(appHead);
    // The staging branch moved to the forge's head.
    expect((await gitBare(s.staging.gitDir, ["rev-parse", "refs/heads/main"])).trim()).toBe(appHead);
    const [row] = await s.store.bySession(SESSION.sessionId);
    expect(row).toMatchObject({ state: "rejected", sha: student.sha, lastError: "fetch first", nextAttemptAt: null });
    expect(lastRejectedPush(await s.store.bySession(SESSION.sessionId))).toMatchObject({ ref: "refs/heads/main", reason: "fetch first" });
    // The student's commit is not lost: in their clone, and in the row.
    await git(["-C", student.dir, "cat-file", "-e", `${student.sha}^{commit}`], { env: FIXTURE_ENV });
    // Terminal: the next pass has nothing to do.
    expect(await worker.runOnce()).toEqual({ relayed: 0, retried: 0, failed: 0, rejected: 0 });

    // The student pulls (the App's commit comes in), commits, pushes: a fast-forward, relayed.
    await git(["-C", student.dir, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main"], { env: FIXTURE_ENV });
    const again = await studentCommit(s, "after the pull", student.dir);
    expect(await worker.runOnce()).toEqual({ relayed: 1, retried: 0, failed: 0, rejected: 0 });
    expect((await gitBare(s.forgeRepo, ["rev-parse", "refs/heads/main"])).trim()).toBe(again.sha);
    await gitBare(s.forgeRepo, ["merge-base", "--is-ancestor", appHead, again.sha]);
    // A later push of the branch replaces the rejection in what the student and the staff read.
    expect(lastRejectedPush(await s.store.bySession(SESSION.sessionId))).toBeNull();
    s.close();
  });

  it("relays no branch deletion", async () => {
    const s = await scenario();
    await git(["--git-dir", s.staging.gitDir, "push", "-q", s.forgeRepo, `${s.src.sha}:refs/heads/old`], { env: FIXTURE_ENV });
    await recordPush({ store: s.store }, SESSION, [{ ref: "refs/heads/old", oldSha: s.src.sha, sha: NULL_OID }]);
    const worker = createRelayWorker({ store: s.store, forge: fakeForge(s.forgeRepo), targets: stagingTargets(s.volumesRoot, s.repoOf), backoffMs: () => 0 });
    expect(await worker.runOnce()).toEqual({ relayed: 0, retried: 0, failed: 0, rejected: 1 });
    expect((await gitBare(s.forgeRepo, ["rev-parse", "refs/heads/old"])).trim()).toBe(s.src.sha);
    expect((await s.store.bySession(SESSION.sessionId))[0]).toMatchObject({ state: "rejected", lastError: DELETION_NOT_RELAYED });
    s.close();
  });

  it("a declaration Quiz refuses pushes nothing and waits on the slow backoff, never failed", async () => {
    const s = await scenario();
    await recordPush({ store: s.store }, SESSION, [{ ref: "refs/heads/main", oldSha: null, sha: s.src.sha }]);
    const clock = new Date("2026-10-14T22:31:00Z");
    const forge: Forge = {
      ...fakeForge(s.forgeRepo),
      async declareHeads() {
        throw new ForgeRefusedError("closed");
      },
    };
    const worker = createRelayWorker({ store: s.store, forge, targets: stagingTargets(s.volumesRoot, s.repoOf), maxAttempts: 1, now: () => clock });
    expect(await worker.runOnce()).toEqual({ relayed: 0, retried: 1, failed: 0, rejected: 0 });
    await expect(gitBare(s.forgeRepo, ["rev-parse", "--verify", "refs/heads/main"])).rejects.toThrow();
    const [row] = await s.store.bySession(SESSION.sessionId);
    expect(row).toMatchObject({ state: "pending", lastError: "Quiz refused the relay: closed" });
    expect((row!.nextAttemptAt as Date).getTime() - clock.getTime()).toBe(UNCONFIGURED_BACKOFF(1));
    s.close();
  });
});

// ---------------------------------------------------------------- the quiz forge's token

/** Every `/proc/<pid>/cmdline` that contains `needle`. */
async function cmdlinesContaining(needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const raw = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    if (raw.includes(needle)) hits.push(`${entry}: ${raw.replace(/\0/g, " ")}`);
  }
  return hits;
}

/** Every file under `dir` whose bytes contain `needle`. */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...(await filesContaining(path, needle)));
    else if (entry.isFile() && (await readFile(path).catch(() => Buffer.alloc(0))).includes(needle)) hits.push(path);
  }
  return hits;
}

describe("the quiz forge's token during a relay (ADR-078 §3)", () => {
  it("is in no argv, file, SQLite row, last_error nor log line; scoped to GitHub; dropped when refused", async () => {
    const SECRET_TOKEN = "ghs_m610leakprobe0123456789";
    const s = await scenario("portal.sqlite");
    // Quiz's answers.
    const quizFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app/codespace/relay-heads")) return new Response(null, { status: 204 });
      return Response.json({
        token: SECRET_TOKEN,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        useUntil: new Date(Date.now() + 3_600_000).toISOString(),
        repository: { fullName: "org/lab-kid", githubRepoId: 7 },
        permission: "write",
      });
    }) as typeof fetch;
    const logs: string[] = [];
    const log = { info: (o: object, m: string) => logs.push(`${m} ${JSON.stringify(o)}`), warn: (o: object, m: string) => logs.push(`${m} ${JSON.stringify(o)}`) };
    const quiz = createQuizForge({ platformUrl: "https://quiz.test", secret: "q".repeat(40), fetchImpl: quizFetch, log });
    // A local "forge" that refuses every credential, and records what it was sent.
    const seen: IncomingHttpHeaders[] = [];
    const server: Server = createServer((req, res) => {
      seen.push(req.headers);
      setTimeout(() => res.writeHead(401, { "www-authenticate": 'Basic realm="x"' }).end(), 300);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    // The quiz forge, its push URL pointed at the local server (GitHub is never reached in a test).
    const forge: Forge = { ...quiz, pushUrl: () => `http://127.0.0.1:${port}/org/lab-kid.git` };

    await recordPush({ store: s.store }, SESSION, [{ ref: "refs/heads/main", oldSha: null, sha: s.src.sha }]);
    const worker = createRelayWorker({ store: s.store, forge, targets: stagingTargets(s.volumesRoot, s.repoOf), backoffMs: () => 0, log });
    const inFlight = worker.runOnce();
    const argv: string[] = [];
    let sawPush = false;
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      argv.push(...(await cmdlinesContaining(SECRET_TOKEN)));
      if ((await cmdlinesContaining(`127.0.0.1:${port}`)).length > 0) sawPush = true;
    }
    expect((await inFlight).retried).toBe(1);
    server.close();

    expect(sawPush).toBe(true);
    expect(argv).toEqual([]);
    // The header is scoped to https://github.com/: another host never receives it.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h.authorization === undefined)).toBe(true);
    // Refused by the forge: dropped, the next attempt asks Quiz again.
    expect(quiz.cached()).toEqual([]);
    const [row] = await s.store.bySession(SESSION.sessionId);
    expect(row?.state).toBe("pending");
    expect(row?.lastError).toBeTruthy();
    expect(row?.lastError).not.toContain(SECRET_TOKEN);
    const basic = Buffer.from(`x-access-token:${SECRET_TOKEN}`).toString("base64");
    for (const needle of [SECRET_TOKEN, basic]) {
      expect(logs.join("\n")).not.toContain(needle);
      // The SQLite file, the staging repository's config, any stray file.
      expect(await filesContaining(s.base, needle)).toEqual([]);
    }
    s.close();
  });
});
