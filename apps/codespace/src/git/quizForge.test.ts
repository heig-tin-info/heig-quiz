/**
 * The `quiz` forge (ADR-078 §3): the requests it signs, its per-repository
 * cache (the 10-minute refresh margin, the hard stop at `useUntil` with no
 * new request, one request in flight per entry, dropped on GitHub's 401/403
 * and when its workspace is forgotten, revoked when dropped early), the
 * declaration of heads, and Quiz's refusals told from outages.
 */
import {
  GIT_TOKEN_AUDIENCE,
  GitTokenRequestClaims,
  PORTAL_ISSUER,
  RELAY_HEADS_AUDIENCE,
  RelayHeadsClaims,
} from "@quiz/contracts";
import { verifyHs256 } from "@quiz/domain";
import { describe, expect, it } from "vitest";

import { ForgeRefusedError, ForgeUnconfiguredError } from "./forge.js";
import { gitAuthEnv } from "./gitRunner.js";
import { basicAuthorization, createQuizForge, REFRESH_MARGIN_MS } from "./quizForge.js";

const SECRET = "q".repeat(40);
const PLATFORM = "https://quiz.test";
const REPO = { owner: "org", name: "lab-kid" };
const OWNER = { assignment: "11111111-1111-4111-8111-111111111111", student: "22222222-2222-4222-8222-222222222222" };
const T0 = Date.parse("2026-10-07T08:00:00Z");
const MIN = 60_000;

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

/** A Quiz and a GitHub in one fetch: grants numbered `ghs_tokN`, a status to answer instead when set. */
function world(opts: { useUntil?: (now: number) => number; status?: () => number | null } = {}) {
  let clock = T0;
  let n = 0;
  const calls: Call[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method ?? "GET", authorization: headers.get("authorization"), body: init.body ?? null });
    if (url.startsWith("https://api.github.com/")) return new Response(null, { status: 204 });
    if (hold) await new Promise<void>((r) => (release = r));
    const status = opts.status?.() ?? null;
    if (status !== null) return Response.json({ error: status === 409 ? "closed" : "not_found" }, { status });
    if (url.endsWith("/app/codespace/relay-heads")) return new Response(null, { status: 204 });
    n += 1;
    const expiresAt = clock + 60 * MIN;
    return Response.json({
      token: `ghs_tok${n}`,
      expiresAt: new Date(expiresAt).toISOString(),
      useUntil: new Date(Math.min(expiresAt, opts.useUntil?.(clock) ?? expiresAt)).toISOString(),
      repository: { fullName: "org/lab-kid", githubRepoId: 7 },
      permission: "write",
    });
  }) as typeof fetch;
  const logs: string[] = [];
  const log = { info: (o: object, m: string) => logs.push(`${m} ${JSON.stringify(o)}`), warn: (o: object, m: string) => logs.push(`${m} ${JSON.stringify(o)}`) };
  const forge = createQuizForge({ platformUrl: `${PLATFORM}/`, secret: SECRET, fetchImpl, now: () => new Date(clock), log });
  return {
    forge,
    calls,
    logs,
    quizCalls: () => calls.filter((c) => c.url.startsWith(PLATFORM)),
    revocations: () => calls.filter((c) => c.method === "DELETE"),
    advance: (ms: number) => (clock += ms),
    holdNext: () => (hold = true),
    releaseHeld: () => {
      hold = false;
      release?.();
    },
  };
}

const tokenOf = (authorization: string) => Buffer.from(authorization.replace(/^basic /, ""), "base64").toString().replace(/^x-access-token:/, "");

describe("the requests it signs (ADR-078 §2)", () => {
  it("asks for one repository, for one owner, with a one-minute token and no body", async () => {
    const w = world();
    const header = await w.forge.authorization(REPO, OWNER);
    expect(header).toBe(basicAuthorization("ghs_tok1"));
    const [call] = w.quizCalls();
    expect(call).toMatchObject({ url: `${PLATFORM}/app/codespace/git-token`, method: "POST", body: null });
    const verdict = await verifyHs256<Record<string, unknown>>(call!.authorization!.replace(/^Bearer /, ""), SECRET, {
      audience: GIT_TOKEN_AUDIENCE,
      issuer: PORTAL_ISSUER,
      requireJti: true,
      now: () => Math.floor(T0 / 1000),
    });
    expect(verdict.ok).toBe(true);
    const claims = GitTokenRequestClaims.parse(verdict.ok ? verdict.claims : null);
    expect(claims).toMatchObject({ projectId: OWNER.assignment, userId: OWNER.student, repository: "org/lab-kid" });
    expect(claims.exp - claims.iat).toBe(60);
  });

  it("presents the token to git as x-access-token, scoped to github.com, through the environment only", async () => {
    const w = world();
    const header = await w.forge.authorization(REPO, OWNER);
    expect(tokenOf(header)).toBe("ghs_tok1");
    expect(w.forge.pushUrl(REPO)).toBe("https://github.com/org/lab-kid.git");
    expect(w.forge.pushUrl(REPO)).not.toContain("ghs_");
    const env = gitAuthEnv(header, w.forge.headerScope);
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: ${header}`,
    });
    // Nothing of it in what the forge logs.
    expect(w.logs.join("\n")).not.toContain("ghs_tok1");
    expect(w.logs.join("\n")).not.toContain(header.split(" ")[1]!);
  });

  it("declares heads in chunks of 50 under their own audience", async () => {
    const w = world();
    const heads = Array.from({ length: 51 }, (_, i) => ({ ref: `refs/heads/b${i}`, sha: "a".repeat(40) }));
    await w.forge.declareHeads!(REPO, OWNER, heads);
    const posts = w.quizCalls();
    expect(posts.map((c) => c.url)).toEqual([`${PLATFORM}/app/codespace/relay-heads`, `${PLATFORM}/app/codespace/relay-heads`]);
    const sizes = [];
    for (const post of posts) {
      const verdict = await verifyHs256<Record<string, unknown>>(post.authorization!.replace(/^Bearer /, ""), SECRET, {
        audience: RELAY_HEADS_AUDIENCE,
        issuer: PORTAL_ISSUER,
        requireJti: true,
        now: () => Math.floor(T0 / 1000),
      });
      sizes.push(RelayHeadsClaims.parse(verdict.ok ? verdict.claims : null).heads.length);
    }
    expect(sizes).toEqual([50, 1]);
  });
});

describe("the cache (ADR-078 §3)", () => {
  it("serves the cached token until 10 minutes before GitHub's expiry, then asks once more", async () => {
    const w = world();
    await w.forge.authorization(REPO, OWNER);
    w.advance(60 * MIN - REFRESH_MARGIN_MS - 1);
    expect(tokenOf(await w.forge.authorization(REPO, OWNER))).toBe("ghs_tok1");
    expect(w.quizCalls()).toHaveLength(1);
    w.advance(1);
    expect(tokenOf(await w.forge.authorization(REPO, OWNER))).toBe("ghs_tok2");
    expect(w.quizCalls()).toHaveLength(2);
    // A refresh does not revoke the token it replaces: a push may still use it.
    expect(w.revocations()).toHaveLength(0);
  });

  it("keeps one entry per (project, user, repository)", async () => {
    const w = world();
    await w.forge.authorization(REPO, OWNER);
    await w.forge.authorization({ owner: "org", name: "lab-squashed" }, OWNER);
    await w.forge.authorization(REPO, { ...OWNER, student: "33333333-3333-4333-8333-333333333333" });
    await w.forge.authorization({ owner: "ORG", name: "Lab-Kid" }, OWNER);
    expect(w.quizCalls()).toHaveLength(3);
    expect(w.forge.cached()).toHaveLength(3);
  });

  it("never uses a token past useUntil, asks nothing then, and revokes it", async () => {
    // The deadline plus the grace falls 20 minutes after the grant.
    const w = world({ useUntil: (now) => now + 20 * MIN });
    await w.forge.authorization(REPO, OWNER);
    w.advance(20 * MIN - 1);
    expect(tokenOf(await w.forge.authorization(REPO, OWNER))).toBe("ghs_tok1");
    w.advance(1);
    const stopped = w.forge.authorization(REPO, OWNER);
    await expect(stopped).rejects.toBeInstanceOf(ForgeRefusedError);
    await expect(stopped).rejects.toBeInstanceOf(ForgeUnconfiguredError);
    expect(w.quizCalls()).toHaveLength(1);
    expect(w.forge.cached()).toEqual([]);
    const [revoked] = w.revocations();
    expect(revoked).toMatchObject({ url: "https://api.github.com/installation/token", authorization: "token ghs_tok1" });
    // The next attempt asks again: Quiz answers for itself (an extension grants, else 409).
    await w.forge.authorization(REPO, OWNER);
    expect(w.quizCalls()).toHaveLength(2);
  });

  it("has one request in flight per entry", async () => {
    const w = world();
    w.holdNext();
    const many = [w.forge.authorization(REPO, OWNER), w.forge.authorization(REPO, OWNER), w.forge.authorization(REPO, OWNER)];
    await new Promise((r) => setTimeout(r, 10));
    w.releaseHeld();
    const headers = await Promise.all(many);
    expect(new Set(headers.map(tokenOf))).toEqual(new Set(["ghs_tok1"]));
    expect(w.quizCalls()).toHaveLength(1);
  });

  it("drops a token GitHub refused, without revoking it; the next attempt asks again", async () => {
    const w = world();
    await w.forge.authorization(REPO, OWNER);
    w.forge.invalidate!(REPO, OWNER);
    expect(w.forge.cached()).toEqual([]);
    expect(w.revocations()).toHaveLength(0);
    expect(tokenOf(await w.forge.authorization(REPO, OWNER))).toBe("ghs_tok2");
  });

  it("forgets and revokes a closed workspace's tokens, and only its own", async () => {
    const w = world();
    const other = { ...OWNER, student: "33333333-3333-4333-8333-333333333333" };
    await w.forge.authorization(REPO, OWNER);
    await w.forge.authorization(REPO, other);
    w.forge.forget!(OWNER);
    expect(w.forge.cached()).toHaveLength(1);
    expect(w.revocations().map((c) => c.authorization)).toEqual(["token ghs_tok1"]);
  });
});

describe("Quiz's answers", () => {
  it("401, 404 and 409 are refusals (the slow backoff), anything else an outage", async () => {
    for (const status of [401, 404, 409]) {
      const w = world({ status: () => status });
      await expect(w.forge.authorization(REPO, OWNER)).rejects.toBeInstanceOf(ForgeRefusedError);
      await expect(w.forge.declareHeads!(REPO, OWNER, [{ ref: "refs/heads/main", sha: "a".repeat(40) }])).rejects.toBeInstanceOf(ForgeRefusedError);
    }
    const closed = world({ status: () => 409 });
    await expect(closed.forge.authorization(REPO, OWNER)).rejects.toThrow(/closed/);
    const down = world({ status: () => 503 });
    const outage = down.forge.authorization(REPO, OWNER);
    await expect(outage).rejects.not.toBeInstanceOf(ForgeUnconfiguredError);
    await expect(outage).rejects.toThrow(/Quiz answered 503/);
  });
});
