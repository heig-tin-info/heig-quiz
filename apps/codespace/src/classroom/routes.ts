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
 * no login of its own). A launch token from either issuer of the transition,
 * `heig-classroom` or `heig-quiz` (`CODESPACE_ISSUERS`), is accepted; a
 * service token from Quiz only.
 *
 * Two invariants play out here and nowhere else:
 *
 *  - **Invariant 6.** In exam mode, `/launch` is a top-level navigation coming
 *    from Safe Exam Browser: it is here, once and only once, that the
 *    `SebVerifier` looks at the SEB headers, against the Config Key the
 *    platform signed into the token (D21) and the assignment's optional
 *    Browser Exam Keys. The proxy will never see one.
 *  - **Single use.** The token's `jti` is consumed by an `INSERT` whose primary
 *    key is the guarantee; a replay cannot run alongside a first call, SQLite
 *    refuses the second row. A service token is single use too, and bound to
 *    its request: method, path and the SHA-256 of its body (audit L25,
 *    ADR-078 amendment of 2026-10-11).
 *
 * Nothing that is logged carries the token, its signature or a BEK.
 */
import { randomUUID } from "node:crypto";

import {
  CODESPACE_ISSUERS,
  CodespaceAssignmentSync,
  LAUNCH_AUDIENCE,
  LaunchTokenClaims,
  QUIZ_CODESPACE_ISSUER,
  SERVICE_AUDIENCE,
  ServiceTokenClaims,
  isSafeId,
  type CodespaceAssignmentSyncResult,
  type CodespaceSessionSummary,
} from "@quiz/contracts";
import { HS256_SKEW_SECONDS, bindingMismatch, requestBinding, verifyHs256 } from "@quiz/domain";
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
  type UserRow,
} from "../db/schema.js";
import type { RepoRef } from "../git/index.js";
import { SESSION_COOKIE, cookieValue } from "../proxy/index.js";
import {
  EXAM_COOKIE,
  examCookieAttributes,
  issueExamCookie,
  outsideSebPage,
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
import { requestLang, t, type MessageKey } from "../web/i18n.js";
import { errorPage, workspaceErrorPage } from "../web/pages.js";
import { sessionCookieOptions } from "../web/routes.js";

/**
 * Prefix of the subject of an account born from a launch token (see
 * `upsertLaunchUser`). The value stays `classroom:` for both issuers, so a
 * portal database carried over keeps its accounts.
 *
 * Both issuers share this one namespace, and the volume directory named by
 * the bare subject. That is safe only because heig-classroom and Quiz both
 * use random UUID user ids, and only as long
 * as a production portal does not share its `CODESPACE_LAUNCH_SECRET` with
 * both platforms at once. Open for M6-04/M6-06: one issuer per portal in
 * production, or a prefix per issuer.
 */
export const CLASSROOM_SUB_PREFIX = "classroom:";

export interface ClassroomRoutesOptions {
  config: AppConfig;
  db: Db;
  manager: SessionManager;
  /** The SEB verifier of `/launch` in exam mode: real or simulated. */
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
 * How long a consumed `jti` outlives its token's `exp`: `verifyHs256`
 * accepts a token until `exp + HS256_SKEW_SECONDS`, so a row purged at `exp`
 * made a used link valid again for those seconds (audit M11). A minute more
 * covers a clock step between the check and the purge.
 */
export const JTI_RETENTION_AFTER_EXP_MS = (HS256_SKEW_SECONDS + 60) * 1000;

/**
 * Consumes a `jti`, of a launch or a service token. Returns false if it had
 * already been consumed: the primary key of `launch_tokens_used` is the
 * guarantee, not a read followed by a write. Rows are purged along the way
 * once `verifyHs256` refuses their token anyway, {@link JTI_RETENTION_AFTER_EXP_MS}
 * after its `exp`.
 */
export function consumeJti(db: Db, jti: string, expSeconds: number, now = new Date()): boolean {
  db.delete(launchTokensUsed)
    .where(lt(launchTokensUsed.exp, new Date(now.getTime() - JTI_RETENTION_AFTER_EXP_MS)))
    .run();
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

  /** The exact bytes of a service call's JSON body, which its token's `bodyHash` signs. */
  const rawBodies = new WeakMap<FastifyRequest, Buffer>();

  /**
   * Service token: `Authorization: Bearer <jwt>`, aud `heig-codespace-api`,
   * at most two minutes long (`ServiceTokenClaims`), bound to this very
   * request — method, path and query, body — and single use: its `jti` is
   * consumed once the binding holds, so a captured token serves neither a
   * second time nor on another route (audit L25). Every refusal is the same
   * 401; the log names the reason, never the token.
   */
  async function serviceToken(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const refusal = token === "" ? "missing-token" : await serviceTokenRefusal(request, token);
    if (refusal === null) return true;
    if (refusal !== "missing-token") request.log.warn({ reason: refusal }, "service token refused");
    await reply.code(401).send({ error: "unauthenticated" });
    return false;
  }

  async function serviceTokenRefusal(request: FastifyRequest, token: string): Promise<string | null> {
    const verdict = await verifyHs256(token, secret, {
      audience: SERVICE_AUDIENCE,
      issuer: QUIZ_CODESPACE_ISSUER,
      requireJti: true,
    });
    if (!verdict.ok) return verdict.reason;
    const claims = ServiceTokenClaims.safeParse(verdict.claims);
    if (!claims.success) return "bad-claims";
    const actual = await requestBinding(request.method, request.url, rawBodies.get(request));
    const mismatch = bindingMismatch(claims.data, actual);
    if (mismatch !== null) return `unbound-${mismatch}`;
    return consumeJti(db, claims.data.jti, claims.data.exp) ? null : "jti-replayed";
  }

  // The service routes in a context of their own, whose only body parser is
  // JSON kept as bytes: the body hash is computed over what was received,
  // and any other content type is a 415.
  await app.register(async (api) => {
    const parseJson = api.getDefaultJsonParser("error", "error");
    api.removeAllContentTypeParsers();
    api.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
      rawBodies.set(request, body as Buffer);
      parseJson(request, (body as Buffer).toString("utf8"), done);
    });

    // --- PUT /api/assignments/:id --------------------------------------------
    api.put<{ Params: { assignmentId: string } }>(
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

        // An exam's Browser Exam Keys are optional (D21 point 5): none means
        // the Config Key alone, which `/launch` checks against the student's
        // own `.seb`, built by the platform (D21 point 2).
        const mode = body.mode === "online_seb" ? ("exam" as const) : ("lab" as const);

        const previous = findAssignment(db, body.id);
        const sourceRef = splitRepoRef(body.sourceRepo.fullName);
        if (!sourceRef) return reply.code(400).send({ error: "invalid_source_repo" });

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
          // Teacher-side secrets (ADR-047 §7): stored, never logged.
          beks: mode === "exam" ? body.browserExamKeys : [],
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
        // `CodespaceAssignmentSyncResult`, wire-compatible with heig-classroom:
        // the portal serves no `.seb` any more (D21), so it has no Config Key
        // nor link to announce.
        const result: CodespaceAssignmentSyncResult = { id: body.id, configKey: null, sebLink: null };
        return reply.code(200).send(result);
      },
    );

    // --- GET /api/assignments/:id/sessions -----------------------------------
    api.get<{ Params: { assignmentId: string } }>(
      "/api/assignments/:assignmentId/sessions",
      async (request, reply) => {
        if (!(await serviceToken(request, reply))) return reply;
        const assignment = findAssignment(db, request.params.assignmentId);
        if (!assignment) return reply.code(404).send({ error: "unknown_assignment" });
        const summaries: CodespaceSessionSummary[] = assignmentSessionRows(
          db,
          assignment.id,
        ).map(({ session, user, lastPushAt, rejectedPush }) => ({
          sessionId: session.id,
          // The platform's id, the one the caller matches with its own users.
          // Every account is born from a launch token (`upsertLaunchUser`), so
          // every subject carries the prefix.
          userId: user.oidcSub.slice(CLASSROOM_SUB_PREFIX.length),
          email: user.email,
          state: session.state,
          createdAt: session.createdAt.toISOString(),
          lastSeenAt: session.lastSeen.toISOString(),
          lastPushAt: lastPushAt ? lastPushAt.toISOString() : null,
          // GitHub's refusal of the relay (ADR-078 §6), for the staff's workspace list.
          rejectedPush: rejectedPush
            ? { ref: rejectedPush.ref, at: rejectedPush.at.toISOString(), reason: rejectedPush.reason }
            : null,
        }));
        return reply.code(200).send(summaries);
      },
    );
  });

  // --- GET /launch?token=… -------------------------------------------------
  app.get<{ Querystring: { token?: string } }>("/launch", async (request, reply) => {
    const lang = requestLang(request);
    const refuse = (detail: MessageKey, reason: string, code = 403): FastifyReply => {
      request.log.warn({ launch: { reason, clientAddress: request.ip } }, "launch refused");
      return html(reply, code, errorPage(lang, t(lang, "launchRefused"), t(lang, detail)));
    };

    const token = request.query.token ?? "";
    if (token === "") return refuse("launchMissingToken", "missing-token");

    const verdict = await verifyHs256<Record<string, unknown>>(token, secret, {
      audience: LAUNCH_AUDIENCE,
      issuer: CODESPACE_ISSUERS,
    });
    if (!verdict.ok) {
      return refuse(
        verdict.reason === "expired" ? "launchExpired" : "launchInvalid",
        verdict.reason,
      );
    }
    // Five minutes at most (`exp - iat`, audit M11), besides the fields.
    const claimed = LaunchTokenClaims.safeParse(verdict.claims);
    if (!claimed.success) return refuse("launchIncomplete", "bad-claims");
    const claims: LaunchTokenClaims = claimed.data;

    // Single use, before any side effect: a replay stops here.
    if (!consumeJti(db, claims.jti, claims.exp)) {
      return refuse(
        "launchReplayed",
        "jti-replayed",
      );
    }

    const assignment: AssignmentRow | undefined = findAssignment(db, claims.assignmentId);
    if (!assignment) {
      return refuse(
        "launchUnknownAssignment",
        "unknown-assignment",
      );
    }
    if (!isOpen(assignment)) {
      return refuse("launchClosed", "assignment-closed");
    }
    if (!claims.repo) {
      return refuse(
        "launchRepoMissing",
        "repo-missing",
      );
    }

    if (!isSafeId(assignment.id)) {
      return refuse(
        "launchBadAssignmentId",
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
          errorPage(lang, t(lang, "quotaTitle"), t(lang, "quotaDetail")),
        );
      }
    }

    // --- exam mode: the SEB verification, here and only once ---------------
    // D21 point 4: the platform's `seb` session of this project minted the
    // token, and signed into its `seb` claim the Config Key of the student's
    // own `.seb`; SEB's header must match it on this very request (and one of
    // the Browser Exam Keys, when the project has any). A token without the
    // claim did not come from Safe Exam Browser: refused, whatever the
    // verifier.
    // TODO(verify) SEB 3.x / 2.2.3: the `startURL` is the platform's and SEB
    // arrives here after a 303 **to another host**. That its headers are
    // added to that very request, hashed over the portal's URL with its query
    // string, has not been observed on a real SEB binary: the `simulated`
    // mode does not prove it. Proof B (docs/merge/06-codespace-seb-infra.md
    // §6.3, "Proof B, by hand") settles it; plan B is an auto-submitted POST
    // form from the platform.
    if (assignment.mode === "exam") {
      const seb = claims.seb
        ? opts.verifier.verifyStart(
            { url: request.url, headers: request.headers },
            { configKey: claims.seb.configKey, beks: assignment.beks },
          )
        : ({ ok: false, reason: "missing-config-key-header", url: null } as const);
      if (!seb.ok) {
        // Neither BEK nor header in the log: these are hashes of the shared
        // secret.
        request.log.warn(
          {
            seb: {
              assignmentId: assignment.id,
              reason: claims.seb ? seb.reason : "no-seb-claim",
              mode: opts.verifier.mode,
              clientAddress: request.ip,
            },
          },
          "exam launch refused",
        );
        return html(
          reply,
          403,
          outsideSebPage(lang, t(lang, "examOnlyInSeb")),
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
      return html(reply, 503, workspaceErrorPage(lang, err.shortCause));
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
