/**
 * The online workspace's git relay, Quiz's side (ADR-078, merge task
 * M6-10): the portal (`apps/codespace`, on the engine VM) holds no GitHub
 * App credential; it asks Quiz, over two HS256-signed service routes, for
 * an installation token scoped to ONE repository, and declares the heads it
 * is about to push.
 *
 *   - `POST /app/codespace/git-token` → {@link issueGitToken}: the token,
 *     minted by `mintRepositoryToken` (`github/app.ts`, the only place),
 *     `contents: write` on the user's own repository, `contents: read` on
 *     the distribution repository of an `online_seb` project, audited
 *     `codespace.git_token_issued` without the token;
 *   - `POST /app/codespace/relay-heads` → {@link declareRelayHeads}: one
 *     `codespace_relays` row per (repository, sha). A push of Quiz's App
 *     whose head is declared there is the student's (`pushAuthor`,
 *     `modules/github/deliveries.ts`).
 *
 * Both share one prologue ({@link authorizeCall}): the signed request, served
 * once (its `jti` consumed, `codespace_relay_jtis`), then ONE pure rule, `gitTokenRefusal` of `@quiz/domain`, over facts read in one
 * transaction. The token exists here only between GitHub's answer and the
 * reply: never stored, cached, logged nor audited (§4); a GitHub failure is
 * reported by its status alone.
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { z } from "zod";

import {
  GIT_TOKEN_AUDIENCE,
  GitTokenGrant,
  GitTokenRequestClaims,
  PORTAL_ISSUER,
  RELAY_HEADS_AUDIENCE,
  RelayHeadsClaims,
  type GitTokenError,
} from "@quiz/contracts";
import { HS256_SKEW_SECONDS, gitTokenRefusal, verifyHs256, type GitTokenGrantDecision, type GitTokenRefusalCode } from "@quiz/domain";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import { bearerOf } from "../../auth/plugin.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { classrooms, codespaceLaunches, codespaceRelayJtis, codespaceRelays, projectRepos, projects } from "../../db/schema.js";
import { githubStatus, mintRepositoryToken } from "../../github/app.js";
import { projectInstallation } from "../github/service.js";

/** A refusal of either route: its HTTP status and its code (`GitTokenError`). */
export interface GitRelayRefusal {
  status: 401 | 404 | 409 | 503;
  error: GitTokenError["error"];
}

const STATUS: Record<GitTokenRefusalCode, 404 | 409> = { not_found: 404, not_online: 409, closed: 409 };

type RelayApp = Pick<FastifyInstance, "db" | "clock">;

/**
 * How long a consumed `jti` outlives its request's `exp`: `verifyHs256`
 * accepts a request until `exp + HS256_SKEW_SECONDS`, and a minute more
 * covers a clock step between the check and the purge — the portal's
 * `JTI_RETENTION_AFTER_EXP_MS` (ADR-078, amendment of 2026-10-11).
 */
export const RELAY_JTI_RETENTION_AFTER_EXP_MS = (HS256_SKEW_SECONDS + 60) * 1000;

/**
 * Deletes the consumed `jti`s of requests `verifyHs256` refuses anyway.
 * Every call runs it before consuming its own, as the portal does: the
 * table holds a few minutes of requests, and no scheduled task is needed.
 */
export async function purgeRelayJtis(db: Db, now: Date): Promise<number> {
  const purged = await db
    .delete(codespaceRelayJtis)
    .where(lt(codespaceRelayJtis.exp, new Date(now.getTime() - RELAY_JTI_RETENTION_AFTER_EXP_MS)))
    .returning({ jti: codespaceRelayJtis.jti });
  return purged.length;
}

/** What a call that passed checks 1 to 5 carries on. */
interface AuthorizedCall<C> {
  claims: C;
  grant: GitTokenGrantDecision;
  /** The granted repository's name as Quiz stores it. */
  fullName: string;
  orgId: string;
  now: Date;
}

/**
 * The prologue both routes share (ADR-078 §2), checks 1 to 5:
 *
 *   1. the request is an HS256 token over `CODESPACE_LAUNCH_SECRET`, the
 *      route's OWN audience (a launch, a sync or the other route's token is
 *      refused), the portal's issuer, a minute at most on the server's
 *      clock, a `jti`, claims of the contract (uuid ids); otherwise `401`;
 *      the `jti` is then consumed, first thing in the transaction below:
 *      an `INSERT` whose primary key refuses a second presentation of the
 *      same request, concurrent ones included (`401`, like any other
 *      refusal of the token). Consumed before any work, a request refused
 *      further on stays spent: the portal signs a fresh one for every
 *      call, retries included;
 *   2–5. in the same transaction, the project, the user's launch
 *      (`codespace_launches`), the user's own repository and the classroom,
 *      judged by `gitTokenRefusal`.
 *
 * A refusal is logged at `info` with its code and the request's `jti`,
 * never audited (a portal waiting for an extension retries for hours).
 */
async function authorizeCall<S extends typeof GitTokenRequestClaims | typeof RelayHeadsClaims>(
  app: RelayApp,
  config: AppConfig,
  authorization: string | undefined,
  route: { audience: string; schema: S; name: string },
  log: FastifyBaseLogger,
): Promise<AuthorizedCall<z.infer<S>> | GitRelayRefusal> {
  const now = app.clock.now();
  const token = bearerOf(authorization);
  const verified =
    token === null
      ? null
      : await verifyHs256(token, config.CODESPACE_LAUNCH_SECRET, {
          audience: route.audience,
          issuer: PORTAL_ISSUER,
          requireJti: true,
          now: () => Math.floor(now.getTime() / 1000),
        });
  const parsed = verified?.ok ? route.schema.safeParse(verified.claims) : null;
  if (!parsed?.success) {
    log.info({ code: "unauthorized" }, `${route.name} refused`);
    return { status: 401, error: "unauthorized" };
  }
  const claims = parsed.data as z.infer<S>;
  await purgeRelayJtis(app.db, now);
  const decided = await app.db.transaction(async (tx) => {
    const [fresh] = await tx
      .insert(codespaceRelayJtis)
      .values({ jti: claims.jti, exp: new Date(claims.exp * 1000), createdAt: now })
      .onConflictDoNothing()
      .returning({ jti: codespaceRelayJtis.jti });
    if (!fresh) return "replayed" as const;
    const [row] = await tx
      .select({ project: projects, archivedAt: classrooms.archivedAt })
      .from(projects)
      .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
      .where(eq(projects.id, claims.projectId));
    if (!row) return null;
    const [[launch], [repo]] = await Promise.all([
      tx
        .select({ at: codespaceLaunches.firstLaunchAt })
        .from(codespaceLaunches)
        .where(and(eq(codespaceLaunches.projectId, claims.projectId), eq(codespaceLaunches.userId, claims.userId))),
      tx
        .select()
        .from(projectRepos)
        .where(and(eq(projectRepos.projectId, claims.projectId), eq(projectRepos.userId, claims.userId), isNull(projectRepos.groupId))),
    ]);
    const decision = gitTokenRefusal(
      { project: row.project, launched: launch !== undefined, repo: repo ?? null, classroomArchived: row.archivedAt !== null, repository: claims.repository },
      now,
    );
    if (typeof decision === "string") return decision;
    // A grant names a stored repository: the user's own (write), or the project's distribution (read).
    const fullName = decision.permission === "write" ? repo!.fullName! : row.project.distributionFullName!;
    return { grant: decision, fullName, orgId: row.project.orgId };
  });
  if (decided === "replayed") {
    log.info({ code: "unauthorized", replayed: true, jti: claims.jti, projectId: claims.projectId }, `${route.name} refused`);
    return { status: 401, error: "unauthorized" };
  }
  if (decided === null || typeof decided === "string") {
    const refused = decided ?? "not_found";
    log.info({ code: refused, jti: claims.jti, projectId: claims.projectId }, `${route.name} refused`);
    return { status: STATUS[refused], error: refused };
  }
  return { claims, now, ...decided };
}

/**
 * `POST /app/codespace/git-token` (ADR-078 §2): the prologue, then check 6
 * (the organization's installation acting, GitHub answering; otherwise
 * `503`) and the token on ONE repository id; `useUntil` is `min(expiresAt,
 * effective deadline + grace)` for a write grant — `expiresAt` alone for a
 * repository writable under the `commit` strategy (`writableUnderCommit`,
 * #958) —, GitHub's `expiresAt` for a read one. An issuance is audited,
 * without the token.
 */
export async function issueGitToken(
  app: RelayApp,
  config: AppConfig,
  authorization: string | undefined,
  log: FastifyBaseLogger,
): Promise<GitTokenGrant | GitRelayRefusal> {
  const call = await authorizeCall(app, config, authorization, { audience: GIT_TOKEN_AUDIENCE, schema: GitTokenRequestClaims, name: "codespace.git-token" }, log);
  if ("status" in call) return call;
  const { claims, grant } = call;
  let minted;
  try {
    const org = await projectInstallation(app.db, call.orgId);
    if (!org) throw new Error("installation not acting");
    minted = await mintRepositoryToken(config, org.installationId, grant.githubRepoId, grant.permission);
  } catch (err) {
    // GitHub's status only: its error may quote the request, never the token's (§4).
    log.warn({ status: githubStatus(err) ?? null, jti: claims.jti, projectId: claims.projectId }, "codespace.git-token: GitHub unavailable");
    return { status: 503, error: "github_unavailable" };
  }
  const useUntil = grant.useUntil !== null && grant.useUntil.getTime() < minted.expiresAt.getTime() ? grant.useUntil : minted.expiresAt;
  const answer = GitTokenGrant.parse({
    token: minted.token,
    expiresAt: minted.expiresAt.toISOString(),
    useUntil: useUntil.toISOString(),
    repository: { fullName: call.fullName, githubRepoId: grant.githubRepoId },
    permission: grant.permission,
  });
  await audit(app.db, {
    ...SYSTEM_ACTOR,
    action: "codespace.git_token_issued",
    subjectType: "project",
    subjectId: claims.projectId,
    payload: {
      userId: claims.userId,
      repository: call.fullName,
      githubRepoId: grant.githubRepoId,
      permission: grant.permission,
      expiresAt: answer.expiresAt,
      jti: claims.jti,
    },
  });
  log.info({ jti: claims.jti, projectId: claims.projectId, permission: grant.permission }, "codespace.git-token issued");
  return answer;
}

/**
 * `POST /app/codespace/relay-heads` (ADR-078 §2, §6): the prologue, the
 * write case only (a read grant's repository is no relay target: 404), then
 * one `codespace_relays` row per (repository, sha), idempotent — the first
 * declaration of a sha stands. Null: recorded, the route's `204`.
 */
export async function declareRelayHeads(
  app: RelayApp,
  config: AppConfig,
  authorization: string | undefined,
  log: FastifyBaseLogger,
): Promise<GitRelayRefusal | null> {
  const call = await authorizeCall(app, config, authorization, { audience: RELAY_HEADS_AUDIENCE, schema: RelayHeadsClaims, name: "codespace.relay-heads" }, log);
  if ("status" in call) return call;
  const { claims, grant, now } = call;
  if (grant.permission !== "write") {
    log.info({ code: "not_found", jti: claims.jti, projectId: claims.projectId }, "codespace.relay-heads refused");
    return { status: 404, error: "not_found" };
  }
  await app.db
    .insert(codespaceRelays)
    .values(claims.heads.map((h) => ({ githubRepoId: grant.githubRepoId, sha: h.sha, ref: h.ref, userId: claims.userId, declaredAt: now })))
    .onConflictDoNothing();
  log.info({ jti: claims.jti, projectId: claims.projectId, heads: claims.heads.length }, "codespace.relay-heads recorded");
  return null;
}
