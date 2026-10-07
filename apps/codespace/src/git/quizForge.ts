/**
 * The `quiz` forge (ADR-078 §3, merge task M6-10): GitHub, reached with
 * installation tokens that Quiz grants per repository. The portal holds no
 * GitHub App credential; it asks Quiz over two HS256-signed service routes
 * (`CODESPACE_LAUNCH_SECRET`, the contracts of `@quiz/contracts`):
 *
 *   - `POST <PLATFORM_URL>/app/codespace/git-token` → a `GitTokenGrant` on
 *     ONE repository, `contents` only, with GitHub's `expiresAt` and Quiz's
 *     `useUntil` (the deadline plus the grace for a write grant);
 *   - `POST <PLATFORM_URL>/app/codespace/relay-heads` → 204, the heads of
 *     the next relay push declared, so that Quiz reads the App's push of
 *     them as the student's.
 *
 * The cache, in memory only, one entry per (project, user, repository):
 *
 *   - the cached token is returned while `now < expiresAt - 10 min` (a long
 *     push never runs out mid-pack) and `now < useUntil`; past the margin,
 *     one request to Quiz (single flight per entry) replaces it;
 *   - `useUntil` is a HARD STOP, not a refresh point: from then on the
 *     token is never used, the entry is dropped and revoked, and reaching it
 *     asks Quiz nothing (it would answer `409 closed`); the next attempt
 *     asks again, which an extended deadline answers;
 *   - an entry is dropped when GitHub refuses it (`invalidate`, 401/403),
 *     and when its workspace is gone with nothing pending (`forget`);
 *   - a token dropped before its `expiresAt` — at its `useUntil`, or when
 *     its workspace is forgotten — is revoked (`DELETE /installation/token`,
 *     authenticated by itself), best effort; one replaced by a refresh is
 *     not (it may still be in use, and expires within the margin).
 *
 * The token reaches git through the environment only (`gitAuthEnv`, the
 * header scoped to `https://github.com/`), as
 * `Authorization: basic base64(x-access-token:<token>)`; never a URL, argv,
 * file, log line, SQLite row or student container. Quiz's answers are read,
 * never logged; a failure names a status, never a body.
 */
import { randomUUID } from "node:crypto";

import {
  GIT_REQUEST_TTL_SECONDS,
  GIT_TOKEN_AUDIENCE,
  GIT_TOKEN_PATH,
  GitTokenError,
  GitTokenGrant,
  PORTAL_ISSUER,
  RELAY_HEADS_AUDIENCE,
  RELAY_HEADS_MAX,
  RELAY_HEADS_PATH,
} from "@quiz/contracts";
import { signHs256 } from "@quiz/domain";

import { ForgeRefusedError, type Forge, type ForgeOwner } from "./forge.js";
import type { RepoRef } from "./types.js";

/** A token is replaced this long before GitHub's expiry. */
export const REFRESH_MARGIN_MS = 10 * 60_000;
/** A call to Quiz never holds a relay pass for long. */
const QUIZ_TIMEOUT_MS = 10_000;
const GITHUB = "https://github.com";

export interface QuizForgeOptions {
  /** Quiz's origin (`PLATFORM_URL`). */
  platformUrl: string;
  /** `CODESPACE_LAUNCH_SECRET`: signs the two requests. */
  secret: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** GitHub's REST origin, for the revocation. */
  githubApi?: string;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

interface Entry {
  token: string;
  expiresAt: number;
  useUntil: number;
  timer: NodeJS.Timeout | null;
}

/** `basic base64(x-access-token:<token>)`: how git presents an installation token over HTTPS. */
export function basicAuthorization(token: string): string {
  return `basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

export interface QuizForge extends Forge {
  readonly kind: "quiz";
  /** The entries held, for the tests: their keys. */
  readonly cached: () => string[];
}

export function createQuizForge(opts: QuizForgeOptions): QuizForge {
  const base = opts.platformUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const githubApi = (opts.githubApi ?? "https://api.github.com").replace(/\/+$/, "");
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<Entry>>();

  const fullName = (repo: RepoRef) => `${repo.owner}/${repo.name}`;
  const keyOf = (repo: RepoRef, owner: ForgeOwner) =>
    `${owner.assignment}\u0000${owner.student}\u0000${fullName(repo).toLowerCase()}`;

  /** The request IS the signed token (ADR-078 §2): bound to its audience, repository and a minute. */
  async function signedRequest(
    path: string,
    aud: string,
    repo: RepoRef,
    owner: ForgeOwner,
    extra: Record<string, unknown> = {},
  ): Promise<Response> {
    const iat = Math.floor(now().getTime() / 1000);
    const token = await signHs256(
      {
        iss: PORTAL_ISSUER,
        aud,
        iat,
        exp: iat + GIT_REQUEST_TTL_SECONDS,
        jti: randomUUID(),
        projectId: owner.assignment,
        userId: owner.student,
        repository: fullName(repo),
        ...extra,
      },
      opts.secret,
    );
    return doFetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(QUIZ_TIMEOUT_MS),
    });
  }

  /** 401, 404, 409: Quiz's refusal, not an outage. Anything else: an outage, named by its status only. */
  async function refusalOf(res: Response): Promise<Error> {
    if (res.status === 401 || res.status === 404 || res.status === 409) {
      const parsed = GitTokenError.safeParse(await res.json().catch(() => null));
      return new ForgeRefusedError(parsed.success ? parsed.data.error : String(res.status));
    }
    return new Error(`Quiz answered ${res.status}`);
  }

  /** Revokes a token GitHub would still honour (best effort); a failure is logged without it. */
  function revoke(token: string): void {
    void doFetch(`${githubApi}/installation/token`, {
      method: "DELETE",
      headers: { authorization: `token ${token}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(QUIZ_TIMEOUT_MS),
    })
      .then((res) => {
        if (res.status !== 204) opts.log?.warn({ status: res.status }, "revoking a relay token failed");
      })
      .catch((err: unknown) => opts.log?.warn({ err: (err as Error).name ?? "error" }, "revoking a relay token failed"));
  }

  /** Drops an entry; revokes its token when GitHub would honour it longer. */
  function drop(key: string, withRevoke: boolean): void {
    const entry = cache.get(key);
    if (!entry) return;
    cache.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if (withRevoke && now().getTime() < entry.expiresAt) revoke(entry.token);
  }

  async function request(key: string, repo: RepoRef, owner: ForgeOwner): Promise<Entry> {
    const res = await signedRequest(GIT_TOKEN_PATH, GIT_TOKEN_AUDIENCE, repo, owner);
    if (!res.ok) throw await refusalOf(res);
    const grant = GitTokenGrant.parse(await res.json());
    const entry: Entry = {
      token: grant.token,
      expiresAt: Date.parse(grant.expiresAt),
      useUntil: Math.min(Date.parse(grant.useUntil), Date.parse(grant.expiresAt)),
      timer: null,
    };
    // A refreshed token replaces the old one, not revoked: a push or a fetch
    // may still be using it, and it expires within the refresh margin.
    const old = cache.get(key);
    if (old?.timer) clearTimeout(old.timer);
    cache.set(key, entry);
    // Dropped and revoked at its hard stop, whether or not anyone asks for it again.
    const wait = entry.useUntil - now().getTime();
    entry.timer = setTimeout(() => {
      if (cache.get(key) === entry) drop(key, true);
    }, Math.max(0, wait));
    entry.timer.unref();
    opts.log?.info({ assignment: owner.assignment, student: owner.student, repo: fullName(repo), permission: grant.permission }, "relay token granted by Quiz");
    return entry;
  }

  return {
    kind: "quiz",
    headerScope: `${GITHUB}/`,
    pushUrl: (repo) => `${GITHUB}/${repo.owner}/${repo.name}.git`,
    async ensureRepo() {
      // Quiz provisions the repositories (analyse.md D3).
    },
    async authorization(repo, owner) {
      const key = keyOf(repo, owner);
      const t = now().getTime();
      const entry = cache.get(key);
      if (entry && t >= entry.useUntil) {
        // The hard stop: never used past it, and no new request now.
        drop(key, true);
        throw new ForgeRefusedError("closed");
      }
      if (entry && t < entry.expiresAt - REFRESH_MARGIN_MS) return basicAuthorization(entry.token);
      let pending = inflight.get(key);
      if (!pending) {
        pending = request(key, repo, owner).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      return basicAuthorization((await pending).token);
    },
    async declareHeads(repo, owner, heads) {
      for (let i = 0; i < heads.length; i += RELAY_HEADS_MAX) {
        const res = await signedRequest(RELAY_HEADS_PATH, RELAY_HEADS_AUDIENCE, repo, owner, {
          heads: heads.slice(i, i + RELAY_HEADS_MAX),
        });
        if (res.status !== 204) throw await refusalOf(res);
      }
    },
    invalidate(repo, owner) {
      // GitHub refused it already: nothing to revoke.
      drop(keyOf(repo, owner), false);
    },
    forget(owner) {
      const prefix = `${owner.assignment}\u0000${owner.student}\u0000`;
      for (const key of [...cache.keys()]) if (key.startsWith(prefix)) drop(key, true);
    },
    cached: () => [...cache.keys()],
  };
}
