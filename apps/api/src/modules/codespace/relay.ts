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
 * Both decide through ONE pure rule, `gitTokenRefusal` of `@quiz/domain`,
 * over facts read in one transaction ({@link gitTokenFacts}). The token
 * exists here only between GitHub's answer and the reply: never stored,
 * cached, logged nor audited (§4); a GitHub failure is reported by its
 * status alone.
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  GIT_TOKEN_AUDIENCE,
  GitTokenGrant,
  GitTokenRequestClaims,
  PORTAL_ISSUER,
  RELAY_HEADS_AUDIENCE,
  RelayHeadsClaims,
  type GitTokenError,
} from "@quiz/contracts";
import { gitTokenRefusal, verifyHs256, type GitTokenRefusalCode } from "@quiz/domain";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { classrooms, codespaceLaunches, codespaceRelays, projectRepos, projects } from "../../db/schema.js";
import { githubStatus, mintRepositoryToken } from "../../github/app.js";
import { projectInstallation } from "../github/service.js";

/** A refusal of either route: its HTTP status and its code (`GitTokenError`). */
export interface GitRelayRefusal {
  status: 401 | 404 | 409 | 503;
  error: GitTokenError["error"];
}

const STATUS: Record<GitTokenRefusalCode, 404 | 409> = { not_found: 404, not_online: 409, closed: 409 };
const UNAUTHORIZED: GitRelayRefusal = { status: 401, error: "unauthorized" };

/** `Authorization: Bearer <JWT>`: the token, or null. */
export function bearerOf(header: string | undefined): string | null {
  return /^Bearer ([A-Za-z0-9._-]+)$/.exec(header ?? "")?.[1] ?? null;
}

/**
 * Check 1 of ADR-078 §2: the signature over `CODESPACE_LAUNCH_SECRET`, HS256
 * only, the route's OWN audience (a launch, a sync or the other route's
 * token is refused), the portal's issuer, a lifetime of a minute at most on
 * the server's clock, a `jti`. Null on any failure: a `401`.
 */
async function verifyRequest<S extends z.ZodType>(
  config: AppConfig,
  token: string | null,
  audience: string,
  schema: S,
  now: Date,
): Promise<z.infer<S> | null> {
  if (token === null) return null;
  const verified = await verifyHs256(token, config.CODESPACE_LAUNCH_SECRET, {
    audience,
    issuer: PORTAL_ISSUER,
    requireJti: true,
    now: () => Math.floor(now.getTime() / 1000),
  });
  if (!verified.ok) return null;
  const claims = schema.safeParse(verified.claims);
  return claims.success ? claims.data : null;
}

/**
 * Checks 2 to 5, in one read transaction: the project, the user's launch
 * (`codespace_launches`), the user's own repository, the classroom; the
 * decision is `gitTokenRefusal`'s. Returns the decision with the project's
 * organization (for check 6).
 */
async function decide(db: Db, claims: { projectId: string; userId: string; repository: string }, now: Date) {
  if (!z.uuid().safeParse(claims.projectId).success || !z.uuid().safeParse(claims.userId).success) {
    return { decision: "not_found" as const, orgId: null, fullName: null };
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ project: projects, archivedAt: classrooms.archivedAt })
      .from(projects)
      .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
      .where(eq(projects.id, claims.projectId));
    if (!row) return { decision: "not_found" as const, orgId: null, fullName: null };
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
      {
        project: row.project,
        launched: launch !== undefined,
        repo: repo ?? null,
        classroomArchived: row.archivedAt !== null,
        repository: claims.repository,
      },
      now,
    );
    // The name Quiz stores for the granted repository (the match is case-insensitive).
    const fullName = typeof decision === "string" ? null : decision.permission === "write" ? repo!.fullName : row.project.distributionFullName;
    return { decision, orgId: row.project.orgId, fullName };
  });
}

/**
 * `POST /app/codespace/git-token` (ADR-078 §2): checks 1 to 6, then the
 * token on ONE repository id, `useUntil` = `min(expiresAt, effective
 * deadline + grace)` for a write grant, GitHub's `expiresAt` for a read
 * one. A refusal is logged at `info` with its code and the request's
 * `jti`, never audited (a portal waiting for an extension retries for
 * hours); an issuance is audited, without the token.
 */
export async function issueGitToken(
  app: Pick<FastifyInstance, "db" | "clock">,
  config: AppConfig,
  authorization: string | undefined,
  log: FastifyBaseLogger,
): Promise<GitTokenGrant | GitRelayRefusal> {
  const now = app.clock.now();
  const claims = await verifyRequest(config, bearerOf(authorization), GIT_TOKEN_AUDIENCE, GitTokenRequestClaims, now);
  if (!claims) {
    log.info({ code: "unauthorized" }, "codespace.git-token refused");
    return UNAUTHORIZED;
  }
  const { decision, orgId, fullName: stored } = await decide(app.db, claims, now);
  if (typeof decision === "string") {
    log.info({ code: decision, jti: claims.jti, projectId: claims.projectId }, "codespace.git-token refused");
    return { status: STATUS[decision], error: decision };
  }
  const org = orgId === null ? null : await projectInstallation(app.db, orgId);
  let minted;
  try {
    if (!org) throw new Error("installation not acting");
    minted = await mintRepositoryToken(config, org.installationId, decision.githubRepoId, decision.permission);
  } catch (err) {
    // GitHub's status only: its error may quote the request, never the token's (§4).
    log.warn({ status: githubStatus(err) ?? null, jti: claims.jti, projectId: claims.projectId }, "codespace.git-token: GitHub unavailable");
    return { status: 503, error: "github_unavailable" };
  }
  const useUntil =
    decision.useUntil !== null && decision.useUntil.getTime() < minted.expiresAt.getTime() ? decision.useUntil : minted.expiresAt;
  const fullName = stored ?? claims.repository;
  const grant = GitTokenGrant.parse({
    token: minted.token,
    expiresAt: minted.expiresAt.toISOString(),
    useUntil: useUntil.toISOString(),
    repository: { fullName, githubRepoId: decision.githubRepoId },
    permission: decision.permission,
  });
  await audit(app.db, {
    ...SYSTEM_ACTOR,
    action: "codespace.git_token_issued",
    subjectType: "project",
    subjectId: claims.projectId,
    payload: {
      userId: claims.userId,
      repository: fullName,
      githubRepoId: decision.githubRepoId,
      permission: decision.permission,
      expiresAt: grant.expiresAt,
      jti: claims.jti,
    },
  });
  log.info({ jti: claims.jti, projectId: claims.projectId, permission: decision.permission }, "codespace.git-token issued");
  return grant;
}

/**
 * `POST /app/codespace/relay-heads` (ADR-078 §2, §6): the same checks, the
 * write case only (a read grant's repository is no relay target: 404), then
 * one `codespace_relays` row per (repository, sha), idempotent — the first
 * declaration of a sha stands. Null: recorded, the route's `204`.
 */
export async function declareRelayHeads(
  app: Pick<FastifyInstance, "db" | "clock">,
  config: AppConfig,
  authorization: string | undefined,
  log: FastifyBaseLogger,
): Promise<GitRelayRefusal | null> {
  const now = app.clock.now();
  const claims = await verifyRequest(config, bearerOf(authorization), RELAY_HEADS_AUDIENCE, RelayHeadsClaims, now);
  if (!claims) {
    log.info({ code: "unauthorized" }, "codespace.relay-heads refused");
    return UNAUTHORIZED;
  }
  const { decision } = await decide(app.db, claims, now);
  if (typeof decision === "string" || decision.permission !== "write") {
    const code = typeof decision === "string" ? decision : "not_found";
    log.info({ code, jti: claims.jti, projectId: claims.projectId }, "codespace.relay-heads refused");
    return { status: STATUS[code], error: code };
  }
  await app.db
    .insert(codespaceRelays)
    .values(claims.heads.map((h) => ({ githubRepoId: decision.githubRepoId, sha: h.sha, ref: h.ref, userId: claims.userId, declaredAt: now })))
    .onConflictDoNothing();
  log.info({ jti: claims.jti, projectId: claims.projectId, heads: claims.heads.length }, "codespace.relay-heads recorded");
  return null;
}
