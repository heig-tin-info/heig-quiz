/**
 * HTTP boundary with the platform (`@quiz/contracts`, `codespace.ts`; ADR-047).
 *
 * Six routes, and nothing else knows them:
 *
 *   PUT  /api/assignments/:id            the platform pushes an assignment (service token)
 *   GET  /api/assignments/:id/sessions   the platform's teacher view (service token)
 *   POST /api/assignments/:id/collections  the platform collects a workspace at its deadline (service token, ADR-130)
 *   POST /api/sittings/close             the platform closes a kiosk sitting (its own token, ADR-089)
 *   GET  /launch?token=…                 the student arrives, launch token
 *   GET  /review?token=…                 a staff member opens a repository, review launch token (ADR-129)
 *
 * `/launch` and `/review` differ in what they verify and which assignment
 * they resolve; from upserting the user to the redirect they run one tail,
 * `openSession`.
 *
 * The plugin is **not registered** when `CODESPACE_LAUNCH_SECRET` is empty: the
 * four routes then answer 404 and the portal opens no session at all (it has
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
 *    Browser Exam Keys. The proxy will never see one. A token carrying a
 *    `kiosk` claim instead comes from an attested station's session in Quiz
 *    (ADR-089 §4): no SEB header to check, the station framing the portal.
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
  CodespaceCollectionRequest,
  LAUNCH_AUDIENCE,
  LaunchTokenClaims,
  type LaunchIdentityClaims,
  QUIZ_CODESPACE_ISSUER,
  REVIEW_AUDIENCE,
  ReviewLaunchTokenClaims,
  SERVICE_AUDIENCE,
  SITTING_CLOSE_AUDIENCE,
  SITTING_CLOSE_PATH,
  ServiceTokenClaims,
  SittingCloseClaims,
  isSafeId,
  type CodespaceAssignmentSyncResult,
  type CodespaceCollectionResult,
  type CodespaceSessionSummary,
} from "@quiz/contracts";
import {
  bindingMismatch,
  requestBinding,
  verifyHs256,
  type VerifyHs256Options,
} from "@quiz/domain";
import { eq, lt } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { z } from "zod";

import type { AppConfig } from "../auth/config.js";
import type { Db } from "../db/client.js";
import {
  launchTokensUsed,
  users,
  type AssignmentRepoRef,
  type AssignmentRow,
  type UserRow,
} from "../db/schema.js";
import type { CollectionOrder } from "../git/collect.js";
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
import { closeSitting, isSittingClosed, type SittingSockets } from "../sessions/sittings.js";
import {
  JTI_RETENTION_AFTER_EXP_MS,
  REVIEW_ASSIGNMENT_PREFIX,
  REVIEW_SESSIONS_PER_HOLDER,
  assignmentSessionRows,
  countLiveReviewSessions,
  countLiveSessionsForTeacher,
  findAssignment,
  findLiveSession,
  isOpen,
  isReview,
  liveReviewSessionIds,
  splitRepoRef,
  upsertAssignment,
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
  /** The sockets the proxy upgraded under a kiosk sitting, which its close drops (ADR-089). */
  sittingSockets: SittingSockets;
  /**
   * The collection at the deadline (ADR-130 §4), `collectWorkspace` bound to
   * the forge and the volumes. Absent without a forge: the route answers 503.
   */
  collect?: (order: CollectionOrder) => Promise<CodespaceCollectionResult>;
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
export function upsertLaunchUser(db: Db, claims: LaunchIdentityClaims): UserRow {
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
    // The role is **not** touched: a launch token never grants one (docs/history/v1.md
    // D-V1-3). Every account is created through this path, as a student —
    // a staff member's from a review token too (ADR-129 §10); the OIDC
    // login that once wrote `users.role` is gone (M6-03).
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

export { JTI_RETENTION_AFTER_EXP_MS } from "../sessions/store.js";

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

/**
 * A token's signature, frame and claims, read once for the three kinds the
 * portal receives (launch, review, service): the claims, or why not.
 * `bad-claims` is the schema's refusal; the others are `verifyHs256`'s.
 */
export async function tokenRefusal<S extends z.ZodType>(
  token: string,
  secret: string,
  schema: S,
  opts: Pick<VerifyHs256Options, "audience" | "issuer" | "requireJti">,
): Promise<{ claims: z.infer<S> } | { reason: string }> {
  const verdict = await verifyHs256<Record<string, unknown>>(token, secret, opts);
  if (!verdict.ok) return { reason: verdict.reason };
  const parsed = schema.safeParse(verdict.claims);
  return parsed.success ? { claims: parsed.data } : { reason: "bad-claims" };
}

/**
 * Runs `fn` after every earlier call of the same key has settled: one review
 * opening at a time per staff member, so that two simultaneous `/review`
 * calls cannot both pass the check before either closes or starts
 * (ADR-129 §1). In memory: the portal is one process.
 */
export function serializer(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return (key, fn) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

/** The token of `Authorization: Bearer <token>`, or "" when there is none. */
export function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
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
    const token = bearerToken(request);
    const refusal = token === "" ? "missing-token" : await serviceTokenRefusal(request, token);
    if (refusal === null) return true;
    if (refusal !== "missing-token") request.log.warn({ reason: refusal }, "service token refused");
    await reply.code(401).send({ error: "unauthenticated" });
    return false;
  }

  async function serviceTokenRefusal(request: FastifyRequest, token: string): Promise<string | null> {
    const read = await tokenRefusal(token, secret, ServiceTokenClaims, {
      audience: SERVICE_AUDIENCE,
      issuer: QUIZ_CODESPACE_ISSUER,
      requireJti: true,
    });
    if ("reason" in read) return read.reason;
    const actual = await requestBinding(request.method, request.url, rawBodies.get(request));
    const mismatch = bindingMismatch(read.claims, actual);
    if (mismatch !== null) return `unbound-${mismatch}`;
    return consumeJti(db, read.claims.jti, read.claims.exp) ? null : "jti-replayed";
  }

  const oneReviewAtATime = serializer();
  const oneCollectionAtATime = serializer();

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
        // The review prefix is the portal's own (ADR-129 §10): a project
        // never takes it, so the startup sweep never meets a student's
        // volume under it, and a sync never overwrites a review.
        if (body.id.startsWith(REVIEW_ASSIGNMENT_PREFIX)) {
          return reply.code(400).send({ error: "reserved_id" });
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
          // The teacher's update (ADR-132 §11), `lab` only: an exam's staging is the template's.
          projectUpdate: mode === "lab" ? body.projectUpdate : null,
          createdAt: new Date(),
        };
        upsertAssignment(db, row);
        // Into the running workspaces' staging repositories, in the background:
        // the platform's sync never waits on GitHub. A closed one takes it at its next opening.
        if (row.projectUpdate) {
          void manager.refreshUpdates(body.id).catch((err: unknown) => {
            request.log.warn({ assignmentId: body.id, err: String((err as Error).message ?? err) }, "teacher's update not dispatched to the running workspaces");
          });
        }

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

    // --- POST /api/assignments/:id/collections --------------------------------
    // Quiz collects one student's workspace at a deadline (ADR-130 §4): the
    // order parsed by its contract before anything runs, one collection at a
    // time per (student, assignment), and this log line as the portal's
    // record — only Quiz knows whether a `pushed` became a collection.
    api.post<{ Params: { assignmentId: string } }>(
      "/api/assignments/:assignmentId/collections",
      async (request, reply) => {
        if (!(await serviceToken(request, reply))) return reply;
        const parsed = CodespaceCollectionRequest.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: "invalid_body",
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          });
        }
        const body = parsed.data;
        const assignment = findAssignment(db, request.params.assignmentId);
        if (!assignment) return reply.code(404).send({ error: "unknown_assignment" });
        // A review session keeps nothing and never pushes (ADR-129 §10).
        if (isReview(assignment)) return reply.code(400).send({ error: "reserved_id" });
        const collect = opts.collect;
        if (!collect) return reply.code(503).send({ error: "collection_unavailable" });
        const result = await oneCollectionAtATime(`${body.userId}\u0000${assignment.id}`, () =>
          collect({ ...body, assignment: assignment.id }),
        );
        request.log.info(
          { assignmentId: assignment.id, student: body.userId, ref: body.ref, outcome: result.outcome, ...("reason" in result ? { reason: result.reason } : {}) },
          "workspace collection",
        );
        return reply.code(200).send(result);
      },
    );

    // --- POST /api/sittings/close ----------------------------------------------
    // A kiosk station's sitting ended in Quiz (ADR-089, amendment of
    // 2026-11-15, point 4). The token is the message: its own audience,
    // from Quiz only, single use. Idempotent: a replay, or a sitting the
    // portal never saw, answers 204 too and changes nothing a close has not
    // already changed. Every other refusal is the service routes' 401.
    api.post(SITTING_CLOSE_PATH, async (request, reply) => {
      const token = bearerToken(request);
      const read =
        token === ""
          ? { reason: "missing-token" }
          : await tokenRefusal(token, secret, SittingCloseClaims, {
              audience: SITTING_CLOSE_AUDIENCE,
              issuer: QUIZ_CODESPACE_ISSUER,
              requireJti: true,
            });
      if ("reason" in read) {
        if (read.reason !== "missing-token") request.log.warn({ reason: read.reason }, "sitting close refused");
        return reply.code(401).send({ error: "unauthenticated" });
      }
      const { sitting, projectId, jti, exp } = read.claims;
      if (!consumeJti(db, jti, exp)) {
        request.log.info({ sittingClose: { sitting, jti, replayed: true } }, "sitting close replayed: nothing done");
        return reply.code(204).send();
      }
      const result = closeSitting(db, opts.sittingSockets, sitting, {
        examCookieMaxAgeMs: config.EXAM_COOKIE_MAX_AGE_MS,
      });
      request.log.info({ sittingClose: { sitting, projectId, jti, ...result } }, "kiosk sitting closed");
      return reply.code(204).send();
    });
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

    // Five minutes at most (`exp - iat`, audit M11), besides the fields. No
    // `requireJti`, as before: the schema requires the `jti` itself.
    const read = await tokenRefusal(token, secret, LaunchTokenClaims, {
      audience: LAUNCH_AUDIENCE,
      issuer: CODESPACE_ISSUERS,
    });
    if ("reason" in read) {
      const detail = read.reason === "bad-claims" ? "launchIncomplete" : read.reason === "expired" ? "launchExpired" : "launchInvalid";
      return refuse(detail, read.reason);
    }
    const claims: LaunchTokenClaims = read.claims;

    // Single use, before any side effect: a replay stops here.
    if (!consumeJti(db, claims.jti, claims.exp)) {
      return refuse(
        "launchReplayed",
        "jti-replayed",
      );
    }

    const assignment: AssignmentRow | undefined = findAssignment(db, claims.assignmentId);
    // A review assignment opens through `/review` only (ADR-129 §7).
    if (!assignment || isReview(assignment)) {
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
    if (claims.kiosk) {
      // A station serves an `online_seb` project only (ADR-089 §1, §4): its
      // claim on any other assignment is refused, so a station's session is
      // always an exam one, whose cookie and sockets carry the sitting.
      if (assignment.mode !== "exam") return refuse("launchInvalid", "kiosk-outside-exam");
      // A station's launch token minted just before its sitting closed: the
      // close already revoked that sitting, nothing opens under it (ADR-089).
      if (isSittingClosed(db, claims.kiosk.sitting)) return refuse("launchSittingClosed", "sitting-closed");
    }
    return openSession(request, reply, { claims, assignment, targetRepo: claims.repo, replaces: [], quotaDetail: "quotaDetail" });
  });

  // --- GET /review?token=… -------------------------------------------------
  // A staff member opens one repository of a project, read-only (ADR-129
  // §10). Its own audience, from Quiz only: a review token is never read as
  // a student's launch, nor the reverse. No `isOpen` gate, no SEB.
  app.get<{ Querystring: { token?: string } }>("/review", async (request, reply) => {
    const lang = requestLang(request);
    const refuse = (detail: MessageKey, reason: string, code = 403): FastifyReply => {
      request.log.warn({ review: { reason, clientAddress: request.ip } }, "review refused");
      return html(reply, code, errorPage(lang, t(lang, "launchRefused"), t(lang, detail)));
    };

    const token = request.query.token ?? "";
    if (token === "") return refuse("launchMissingToken", "missing-token");

    const read = await tokenRefusal(token, secret, ReviewLaunchTokenClaims, {
      audience: REVIEW_AUDIENCE,
      issuer: QUIZ_CODESPACE_ISSUER,
      requireJti: true,
    });
    if ("reason" in read) {
      const detail = read.reason === "bad-claims" ? "launchIncomplete" : read.reason === "expired" ? "reviewExpired" : "reviewInvalid";
      return refuse(detail, read.reason);
    }
    const claims: ReviewLaunchTokenClaims = read.claims;

    // Single use, before any side effect: a replay stops here (invariant 7).
    if (!consumeJti(db, claims.jti, claims.exp)) return refuse("reviewReplayed", "jti-replayed");
    const repo = claims.repo;
    if (!repo) return refuse("reviewRepoMissing", "repo-missing");

    // One assignment per reviewed repository, never the project's own: its
    // sessions are never listed among the project's (ADR-129 §10).
    const id = `${REVIEW_ASSIGNMENT_PREFIX}${claims.projectRepoId}`;
    return oneReviewAtATime(claims.sub, async () => {
      // A staff member keeps one live review session (ADR-129 §1): a new one
      // replaces the previous, which therefore counts against neither cap.
      // Resuming this repository's live review replaces nothing.
      const resuming = findLiveSession(db, claims.sub, id) !== undefined;
      const replaces = resuming ? [] : liveReviewSessionIds(db, claims.sub);
      const reviews = resuming ? 0 : countLiveReviewSessions(db, claims.holder.id, replaces);
      if (reviews >= REVIEW_SESSIONS_PER_HOLDER) {
        request.log.warn({ review: { reason: "review-cap-reached", teacherId: claims.holder.id, reviews } }, "review refused");
        // Nothing is closed: the previous review stays open.
        return html(reply, 429, errorPage(lang, t(lang, "quotaTitle"), t(lang, "reviewQuotaDetail")));
      }
      const assignment = upsertAssignment(db, {
        id,
        title: repo.fullName,
        mode: "lab",
        image: config.CODESPACE_DEFAULT_IMAGE,
        uploadPack: true,
        templateRepo: null,
        targetRepo: null,
        targetRepoPattern: null,
        // The project's quota holder carries the session (ADR-129 §3).
        teacherId: claims.holder.id,
        teacherEmail: claims.holder.email,
        maxActiveSessions: claims.maxActiveSessions,
        classroomId: null,
        classroomName: null,
        sourceRepo: null,
        opensAt: null,
        closesAt: null,
        beks: [],
        reviewOf: { projectId: claims.projectId, projectRepoId: claims.projectRepoId },
        createdAt: new Date(),
      });
      return openSession(request, reply, { claims, assignment, targetRepo: repo, replaces, quotaDetail: "reviewQuotaDetail" });
    });
  });

  /**
   * The tail `/launch` and `/review` share (ADR-129 §10): the user, the
   * quota (the sessions in `replaces` excluded, then closed), the SEB check
   * of an exam, the start, the cookies, the log and the redirect.
   */
  async function openSession(
    request: FastifyRequest,
    reply: FastifyReply,
    opening: {
      claims: LaunchIdentityClaims & Pick<LaunchTokenClaims, "jti" | "seb" | "kiosk">;
      assignment: AssignmentRow;
      targetRepo: AssignmentRepoRef;
      /** Live sessions this opening replaces: excluded from the quota, closed once it allows. */
      replaces: readonly string[];
      quotaDetail: MessageKey;
    },
  ): Promise<FastifyReply> {
    const { claims, assignment, replaces } = opening;
    const lang = requestLang(request);
    const user = upsertLaunchUser(db, claims);

    // --- per-teacher quota -------------------------------------------------
    // Resuming a session already alive on this assignment consumes nothing: it
    // does not open one more container (analyse.md D5).
    const resuming = findLiveSession(db, user.login, assignment.id) !== undefined;
    if (!resuming && assignment.teacherId && assignment.maxActiveSessions !== null) {
      const active = countLiveSessionsForTeacher(db, assignment.teacherId, replaces);
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
        return html(reply, 429, errorPage(lang, t(lang, "quotaTitle"), t(lang, opening.quotaDetail)));
      }
    }
    for (const id of replaces) await manager.close(id, "replaced by another review session");

    // --- exam mode: the SEB verification, here and only once ---------------
    // D21 point 4: the platform's `seb` session of this project minted the
    // token, and signed into its `seb` claim the Config Key of the student's
    // own `.seb`; SEB's header must match it on this very request (and one of
    // the Browser Exam Keys, when the project has any). A token without the
    // claim did not come from Safe Exam Browser: refused, whatever the
    // verifier.
    //
    // A `kiosk` claim instead (ADR-089 §4): the token was minted by an
    // attested station's session, which Quiz checked (a fresh attestation);
    // there is no SEB header to verify, and the portal never calls Google.
    // Its cookie carries the sitting, whose close revokes it. The schema
    // refuses a token with both claims.
    // TODO(verify) SEB 3.x / 2.2.3: the `startURL` is the platform's and SEB
    // arrives here after a 303 **to another host**. That its headers are
    // added to that very request, hashed over the portal's URL with its query
    // string, has not been observed on a real SEB binary: the `simulated`
    // mode does not prove it. Proof B (docs/merge/06-codespace-seb-infra.md
    // §6.3, "Proof B, by hand") settles it; plan B is an auto-submitted POST
    // form from the platform.
    if (assignment.mode === "exam" && !claims.kiosk) {
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
        sebVerified: assignment.mode === "exam" && !claims.kiosk,
        teacherId: assignment.teacherId,
        launchJti: claims.jti,
        targetRepo: opening.targetRepo,
        // Every launch says who opened the session last: a station's sitting, or nobody.
        openedBySitting: claims.kiosk?.sitting ?? null,
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
            repo: opening.targetRepo.fullName,
            cause: err.shortCause,
          },
          err: err.message,
        },
        "launch refused: the workspace could not be prepared",
      );
      return html(reply, 503, workspaceErrorPage(lang, err.shortCause));
    }

    // The close may have landed while `manager.start` awaited: it then
    // found nothing to rotate, or rotated a token this opening has since
    // replaced. Refused here, before any `Set-Cookie`, the token
    // `manager.start` just wrote reaches no browser, and no exam cookie of
    // the sitting is issued after its close: nobody holds a way in. The
    // container is left running, as a close leaves it (ADR-089 point 4).
    if (claims.kiosk && isSittingClosed(db, claims.kiosk.sitting)) {
      request.log.warn({ launch: { reason: "sitting-closed", jti: claims.jti, clientAddress: request.ip } }, "launch refused");
      return html(reply, 403, errorPage(lang, t(lang, "launchRefused"), t(lang, "launchSittingClosed")));
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
            ...(claims.kiosk ? { sitting: claims.kiosk.sitting } : {}),
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
          // Neither id is a secret: the station and its sitting, for the trail.
          ...(claims.kiosk ? { kiosk: { deviceId: claims.kiosk.deviceId, sitting: claims.kiosk.sitting } } : {}),
          launched: result.launched,
          resumed: resuming,
          review: isReview(assignment),
        },
      },
      "session opened from a platform launch token",
    );
    return reply.redirect(`/s/${result.session.id}/`, 303);
  }
}

export const classroomRoutes = fp(classroomRoutesImpl, {
  fastify: "5.x",
  name: "classroom-routes",
});
