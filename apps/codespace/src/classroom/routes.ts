/**
 * HTTP boundary with the platform (`@quiz/contracts`, `codespace.ts`; ADR-047).
 *
 * Three routes, and nothing else knows them:
 *
 *   PUT  /api/assignments/:id            the platform pushes an assignment (service token)
 *   GET  /api/assignments/:id/sessions   the platform's teacher view (service token)
 *   GET  /launch?token=…                 the student arrives, launch token
 *
 * The plugin is **not registered** when `CODESPACE_LAUNCH_SECRET` is empty: the
 * three routes then answer 404 and the portal opens no session at all (it has
 * no login of its own). Both issuers of the contract, `heig-classroom` and
 * `heig-quiz`, are accepted during the transition (`CODESPACE_ISSUERS`).
 *
 * Two invariants play out here and nowhere else:
 *
 *  - **Invariant 5.** In exam mode, `/launch` is a top-level navigation coming
 *    from Safe Exam Browser: it is here, once and only once, that the
 *    `SebVerifier` looks at the SEB headers. The proxy will never see one.
 *  - **Single use.** The token's `jti` is consumed by an `INSERT` whose primary
 *    key is the guarantee; a replay cannot run alongside a first call, SQLite
 *    refuses the second row.
 *
 * Nothing that is logged carries the token, its signature or a BEK.
 */
import { randomUUID } from "node:crypto";

import {
  CODESPACE_ISSUERS,
  CodespaceAssignmentSync,
  LAUNCH_AUDIENCE,
  LaunchTokenClaims,
  SERVICE_AUDIENCE,
  isSafeId,
  type CodespaceAssignmentSyncResult,
  type CodespaceSessionSummary,
} from "@quiz/contracts";
import { verifyHs256 } from "@quiz/domain";
import { eq, lt } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { AppConfig } from "../auth/config.js";
import type { Db } from "../db/client.js";
import {
  assignments,
  launchTokensUsed,
  users,
  type AssignmentRow,
  type AssignmentSebConfig,
  type UserRow,
} from "../db/schema.js";
import type { RepoRef } from "../git/index.js";
import { SESSION_COOKIE, cookieValue } from "../proxy/index.js";
import {
  EXAM_COOKIE,
  examCookieAttributes,
  issueExamCookie,
  newExamKeySalt,
  outsideSebPage,
  renderSebFile,
  sebLink,
  type SebVerifier,
} from "../seb/index.js";
import { WorkspaceBootstrapError, type SessionManager } from "../sessions/manager.js";
import {
  assignmentSessionRows,
  countLiveSessionsForTeacher,
  findAssignment,
  findLiveSession,
  isOpen,
  splitRepoRef,
} from "../sessions/store.js";
import { errorPage, workspaceErrorPage } from "../web/pages.js";
import { sessionCookieOptions } from "../web/routes.js";

/**
 * Prefix of the subject of an account born from a launch token (see
 * `upsertLaunchUser`). The value stays `classroom:` for both issuers, so a
 * portal database carried over keeps its accounts.
 */
export const CLASSROOM_SUB_PREFIX = "classroom:";

export interface ClassroomRoutesOptions {
  config: AppConfig;
  db: Db;
  manager: SessionManager;
  /** The same verifier as the `/exam/:id/start` route: real or simulated. */
  verifier: SebVerifier;
  /**
   * Clone URL of a repository on the forge. Absent when `FORGE_KIND=none`: an
   * assignment in exam mode then has no template to clone and its first start
   * fails, which is the intended behaviour (invariant 6).
   */
  repoUrl?: (repo: RepoRef) => string;
}

// --- helpers ----------------------------------------------------------------

function html(reply: FastifyReply, code: number, page: string): FastifyReply {
  return reply.code(code).type("text/html; charset=utf-8").send(page);
}

/**
 * `startURL` of the `.seb`: the platform's page, not the portal's. The path is
 * heig-classroom's; Quiz's own start route lands with M6-06/M6-07.
 */
export function classroomStartUrl(platformUrl: string, assignmentId: string): string {
  return new URL(`/app/codespace/start/${encodeURIComponent(assignmentId)}`, platformUrl).href;
}

/**
 * Hosts that SEB's URL filter must let through **in addition to** the one of
 * the `startURL` (the platform, added by `buildSebConfig`): the portal, which
 * serves the editor, and those of `SEB_EXTRA_ALLOWED_HOSTS` — the identity
 * provider first of all, without which the login page is blocked
 * (docs/leads.md, "Correction to the framing document raised by the SEB test").
 */
export function sebAllowedHosts(config: AppConfig): string[] {
  const portalOrigin = config.SEB_PUBLIC_ORIGIN || config.PUBLIC_URL;
  const hosts = [new URL(portalOrigin).host, ...config.SEB_EXTRA_ALLOWED_HOSTS];
  return [...new Set(hosts.filter((h) => h !== ""))];
}

/**
 * User coming from the platform.
 *
 * `oidcSub` is the **prefixed** subject of the token (the column keeps the name
 * it had when the portal also had an OIDC login of its own, removed at M6-03).
 * `login`, on the other hand, is the bare subject — the one that names the
 * volume directory, hence the `isSafeId` checked upstream by the contract.
 */
export function upsertLaunchUser(db: Db, claims: LaunchTokenClaims): UserRow {
  const now = new Date();
  const oidcSub = `${CLASSROOM_SUB_PREFIX}${claims.sub}`;
  const existing =
    db.select().from(users).where(eq(users.oidcSub, oidcSub)).get() ??
    db.select().from(users).where(eq(users.login, claims.sub)).get();
  const fields = {
    oidcSub,
    login: claims.sub,
    email: claims.email,
    displayName: claims.displayName,
    githubLogin: claims.githubLogin,
    lastLoginAt: now,
  };
  if (existing) {
    // The role is **not** touched: a launch token never grants one (docs/v1.md
    // D-V1-3). Every account is created through this path, as a student; the
    // OIDC login that once wrote `users.role` is gone (M6-03).
    const [row] = db.update(users).set(fields).where(eq(users.id, existing.id)).returning().all();
    if (!row) throw new Error("user update returned no row");
    return row;
  }
  const [row] = db
    .insert(users)
    .values({ id: randomUUID(), role: "student", createdAt: now, ...fields })
    .returning()
    .all();
  if (!row) throw new Error("user creation returned no row");
  return row;
}

/**
 * Consumes a `jti`. Returns false if it had already been consumed: the primary
 * key of `launch_tokens_used` is the guarantee, not a read followed by a write.
 * Expired rows are purged along the way — beyond `exp`, `verifyHs256` already
 * refuses the token, and the row no longer prevents anything.
 */
export function consumeJti(db: Db, jti: string, expSeconds: number, now = new Date()): boolean {
  db.delete(launchTokensUsed).where(lt(launchTokensUsed.exp, now)).run();
  try {
    db.insert(launchTokensUsed)
      .values({ jti, exp: new Date(expSeconds * 1000), usedAt: now })
      .run();
    return true;
  } catch {
    return false;
  }
}

// --- the plugin -------------------------------------------------------------

async function classroomRoutesImpl(
  app: FastifyInstance,
  opts: ClassroomRoutesOptions,
): Promise<void> {
  const { config, db, manager } = opts;
  const secret = config.CODESPACE_LAUNCH_SECRET;
  const secure = config.NODE_ENV === "production";
  const portalOrigin = config.SEB_PUBLIC_ORIGIN || config.PUBLIC_URL;

  /** Service token: `Authorization: Bearer <jwt>`, aud `heig-codespace-api`. */
  async function serviceToken(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token === "") {
      await reply.code(401).send({ error: "unauthenticated" });
      return false;
    }
    const verdict = await verifyHs256(token, secret, {
      audience: SERVICE_AUDIENCE,
      issuer: CODESPACE_ISSUERS,
    });
    if (!verdict.ok) {
      request.log.warn({ reason: verdict.reason }, "service token refused");
      await reply.code(401).send({ error: "unauthenticated" });
      return false;
    }
    return true;
  }

  // --- PUT /api/assignments/:id --------------------------------------------
  app.put<{ Params: { assignmentId: string } }>(
    "/api/assignments/:assignmentId",
    async (request, reply) => {
      if (!(await serviceToken(request, reply))) return reply;

      const parsed = CodespaceAssignmentSync.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
      }
      const body: CodespaceAssignmentSync = parsed.data;
      if (body.id !== request.params.assignmentId) {
        return reply.code(400).send({ error: "id_mismatch" });
      }

      const mode = body.mode === "online_seb" ? ("exam" as const) : ("lab" as const);
      if (mode === "exam" && body.browserExamKeys.length === 0) {
        // Same refusal as the seed: an exam assignment without a BEK would
        // accept any browser as soon as the verifier switches to `real`.
        return reply.code(400).send({ error: "missing_browser_exam_keys" });
      }

      const previous = findAssignment(db, body.id);
      const sourceRef = splitRepoRef(body.sourceRepo.fullName);
      if (!sourceRef) return reply.code(400).send({ error: "invalid_source_repo" });

      let configKey: string | null = null;
      let sebConfig: AssignmentSebConfig | null = null;
      if (mode === "exam") {
        // The salt is **never** regenerated: it enters the Browser Exam Key
        // that SEB computes, so changing it would invalidate the `.seb` files
        // already distributed. It is also what makes this PUT idempotent.
        const examKeySalt = previous?.sebConfig?.examKeySalt ?? newExamKeySalt();
        const startUrl = classroomStartUrl(config.PLATFORM_URL, body.id);
        const quitUrl = new URL("/", config.PLATFORM_URL).href;
        const extraAllowedHosts = sebAllowedHosts(config);
        const file = renderSebFile({ startUrl, quitUrl, examKeySalt, extraAllowedHosts });
        configKey = file.configKey;
        sebConfig = { examKeySalt, startUrl, quitUrl, extraAllowedHosts };
      }

      const row = {
        id: body.id,
        title: body.name,
        mode,
        image: body.image ?? config.CODESPACE_DEFAULT_IMAGE,
        uploadPack: true,
        // Invariant 6: the clone URL of the teacher's template, and nothing
        // else, bootstraps an exam staging repository.
        templateRepo: opts.repoUrl ? opts.repoUrl(sourceRef) : null,
        // The target repository is no longer an attribute of the assignment:
        // it arrives through the launch token, student by student
        // (`sessions.targetRepo`).
        targetRepo: null,
        targetRepoPattern: null,
        teacherId: body.teacher.id,
        teacherEmail: body.teacher.email,
        maxActiveSessions: body.quota.maxActiveSessions,
        classroomId: body.classroomId,
        classroomName: body.classroomName,
        sourceRepo: body.sourceRepo,
        opensAt: new Date(body.startAt),
        closesAt: body.deadlineAt ? new Date(body.deadlineAt) : null,
        configKey,
        beks: body.browserExamKeys,
        sebConfig,
        createdAt: previous?.createdAt ?? new Date(),
      };
      const { createdAt: _keep, ...updatable } = row;
      db.insert(assignments)
        .values(row)
        .onConflictDoUpdate({ target: assignments.id, set: updatable })
        .run();

      request.log.info(
        { assignmentId: body.id, mode, classroomId: body.classroomId },
        previous ? "assignment updated from the platform" : "assignment synchronized from the platform",
      );
      // `CodespaceAssignmentSyncResult`: the two values the platform cannot
      // compute on its own. It stores the Config Key so the teacher can
      // compare it with what the SEB configuration tool reads from the
      // downloaded file (docs/proof-b-manual.md § 2).
      const result: CodespaceAssignmentSyncResult = {
        id: body.id,
        configKey,
        sebLink: mode === "exam" ? sebLink(portalOrigin, body.id) : null,
      };
      return reply.code(200).send(result);
    },
  );

  // --- GET /api/assignments/:id/sessions -----------------------------------
  app.get<{ Params: { assignmentId: string } }>(
    "/api/assignments/:assignmentId/sessions",
    async (request, reply) => {
      if (!(await serviceToken(request, reply))) return reply;
      const assignment = findAssignment(db, request.params.assignmentId);
      if (!assignment) return reply.code(404).send({ error: "unknown_assignment" });
      const summaries: CodespaceSessionSummary[] = assignmentSessionRows(
        db,
        assignment.id,
      ).map(({ session, user, lastPushAt }) => ({
        sessionId: session.id,
        // **Platform** id when the account comes from there: that is the one
        // the caller knows how to match with its own users.
        userId: user.oidcSub.startsWith(CLASSROOM_SUB_PREFIX)
          ? user.oidcSub.slice(CLASSROOM_SUB_PREFIX.length)
          : user.id,
        email: user.email,
        state: session.state,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeen.toISOString(),
        lastPushAt: lastPushAt ? lastPushAt.toISOString() : null,
      }));
      return reply.code(200).send(summaries);
    },
  );

  // --- GET /launch?token=… -------------------------------------------------
  app.get<{ Querystring: { token?: string } }>("/launch", async (request, reply) => {
    const refuse = (detail: string, reason: string, code = 403): FastifyReply => {
      request.log.warn({ launch: { reason, clientAddress: request.ip } }, "launch refused");
      return html(reply, code, errorPage("Lancement refusé", detail));
    };

    const token = request.query.token ?? "";
    if (token === "") return refuse("Aucun jeton de lancement.", "missing-token");

    const verdict = await verifyHs256<Record<string, unknown>>(token, secret, {
      audience: LAUNCH_AUDIENCE,
      issuer: CODESPACE_ISSUERS,
    });
    if (!verdict.ok) {
      return refuse(
        verdict.reason === "expired"
          ? "Ce lien de lancement a expiré. Retournez sur la plateforme et cliquez de nouveau sur Démarrer."
          : "Ce lien de lancement n'est pas valide. Retournez sur la plateforme et cliquez de nouveau sur Démarrer.",
        verdict.reason,
      );
    }
    const claimed = LaunchTokenClaims.safeParse(verdict.claims);
    if (!claimed.success) return refuse("Ce lien de lancement est incomplet.", "bad-claims");
    const claims: LaunchTokenClaims = claimed.data;

    // Single use, before any side effect: a replay stops here.
    if (!consumeJti(db, claims.jti, claims.exp)) {
      return refuse(
        "Ce lien de lancement a déjà servi. Retournez sur la plateforme et cliquez de nouveau sur Démarrer.",
        "jti-replayed",
      );
    }

    const assignment: AssignmentRow | undefined = findAssignment(db, claims.assignmentId);
    if (!assignment) {
      return refuse(
        "Activité non synchronisée depuis la plateforme. Prévenez votre enseignant : l'activité doit être enregistrée sur la plateforme avant d'être lancée.",
        "unknown-assignment",
      );
    }
    if (!isOpen(assignment)) {
      return refuse("La fenêtre d'ouverture de ce devoir est close.", "assignment-closed");
    }
    if (!claims.repo) {
      return refuse(
        "Votre dépôt n'est pas encore prêt pour ce devoir. Réessayez dans quelques instants.",
        "repo-missing",
      );
    }

    if (!isSafeId(assignment.id)) {
      return refuse(
        "Ce devoir porte un identifiant inutilisable par le portail.",
        "bad-assignment-id",
      );
    }
    const user = upsertLaunchUser(db, claims);

    // --- per-teacher quota -------------------------------------------------
    // Resuming a session already alive on this assignment consumes nothing: it
    // does not open one more container (analyse.md D5).
    const resuming = findLiveSession(db, user.login, assignment.id) !== undefined;
    if (!resuming && assignment.teacherId && assignment.maxActiveSessions !== null) {
      const active = countLiveSessionsForTeacher(db, assignment.teacherId);
      if (active >= assignment.maxActiveSessions) {
        request.log.warn(
          {
            launch: {
              reason: "quota-reached",
              teacherId: assignment.teacherId,
              active,
              max: assignment.maxActiveSessions,
              assignmentId: assignment.id,
            },
          },
          "launch refused: the teacher's session quota is reached",
        );
        return html(
          reply,
          429,
          errorPage(
            "Quota atteint",
            "Toutes les places d'environnement de votre enseignant sont occupées. Réessayez plus tard.",
          ),
        );
      }
    }

    // --- exam mode: the SEB verification, here and only once ---------------
    // TODO(verify) SEB 3.x / 2.2.3: the `startURL` is on classroom and SEB
    // arrives here after a redirect **to another host**. That both headers
    // (`X-SafeExamBrowser-ConfigKeyHash`, `-RequestHash`) are indeed added to
    // that very request, and hashed over the portal's URL with its query
    // string, has not been observed on a real SEB binary: the `simulated` mode
    // does not prove it. To be confronted during proof B
    // (docs/proof-b-manual.md). If SEB did not add them after a redirect,
    // the `startURL` would have to come back to the portal and it would be
    // classroom that posts the token through a form.
    if (assignment.mode === "exam") {
      const seb = opts.verifier.verifyStart(
        { url: request.url, headers: request.headers },
        { configKey: assignment.configKey ?? "", beks: assignment.beks },
      );
      if (!seb.ok) {
        // Neither BEK nor header in the log: these are hashes of the shared
        // secret (seb/routes.ts).
        request.log.warn(
          {
            seb: {
              assignmentId: assignment.id,
              reason: seb.reason,
              mode: opts.verifier.mode,
              clientAddress: request.ip,
            },
          },
          "exam launch refused",
        );
        return html(
          reply,
          403,
          outsideSebPage("Cette épreuve ne s'ouvre que depuis Safe Exam Browser."),
        );
      }
    }

    let result: Awaited<ReturnType<SessionManager["start"]>>;
    try {
      result = await manager.start(user, assignment, {
        sebVerified: assignment.mode === "exam",
        teacherId: assignment.teacherId,
        launchJti: claims.jti,
        targetRepo: claims.repo,
      });
    } catch (err) {
      // The student's repository could not be fetched: **no container was
      // started** and the session does not open. Opening the editor on an empty
      // directory, as on 2026-09-17, lets the student work beside their
      // submission without knowing it.
      if (!(err instanceof WorkspaceBootstrapError)) throw err;
      request.log.warn(
        {
          launch: {
            jti: claims.jti,
            assignmentId: assignment.id,
            login: user.login,
            repo: claims.repo?.fullName ?? null,
            cause: err.shortCause,
          },
          err: err.message,
        },
        "launch refused: the workspace could not be prepared",
      );
      return html(reply, 503, workspaceErrorPage(err.shortCause));
    }

    if (assignment.mode === "exam") {
      reply.setCookie(
        EXAM_COOKIE,
        issueExamCookie(
          {
            assignmentId: assignment.id,
            sessionId: result.session.id,
            clientAddress: request.ip,
            issuedAt: Date.now(),
          },
          { secret: config.EXAM_COOKIE_SECRET, maxAgeMs: config.EXAM_COOKIE_MAX_AGE_MS },
        ),
        examCookieAttributes({ secure, maxAgeMs: config.EXAM_COOKIE_MAX_AGE_MS }),
      );
    }

    reply.setCookie(
      SESSION_COOKIE,
      cookieValue(result.session.id, result.cookieToken),
      sessionCookieOptions(result.session.id, secure),
    );
    request.log.info(
      {
        launch: {
          // The token never appears; its `jti` is enough to link the two logs,
          // and it is not a secret.
          jti: claims.jti,
          assignmentId: assignment.id,
          sessionId: result.session.id,
          login: user.login,
          mode: assignment.mode,
          launched: result.launched,
          resumed: resuming,
        },
      },
      "session opened from a platform launch token",
    );
    return reply.redirect(`/s/${result.session.id}/`, 303);
  });
}

export const classroomRoutes = fp(classroomRoutesImpl, {
  fastify: "5.x",
  name: "classroom-routes",
});
