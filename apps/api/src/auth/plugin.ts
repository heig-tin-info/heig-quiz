import { randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { eq, sql } from "drizzle-orm";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { avatars, users } from "../db/schema.js";
import { publish } from "../events.js";
import { errorClass, tracked } from "../serviceHealth.js";
import { CoachSeenPatch, MePatch, type PublicConfig, type SessionKind } from "@quiz/contracts";

import { shownAvatar } from "../modules/avatar.js";
import { invalid } from "../modules/http.js";
import { devLoginRoutes } from "./dev.js";
import { impersonationRoutes } from "./impersonation.js";
import { loginAdmits, signIn } from "./login.js";
import { OidcProvider, type OidcClaims } from "./oidc.js";
import { returnToOf, safeReturnTo } from "./returnTo.js";
import { MCP_PATH } from "./oauth/service.js";
import { oauthRoutes } from "./oauth/routes.js";
import { sebRoutes } from "./seb.js";
import { trustRefused } from "./trust.js";
import { apiTokenRoutes } from "./tokenRoutes.js";
import { ASSIST_AUDIENCE, findTokenUser, isApiToken } from "./tokens.js";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  PORTAL,
  SESSION_COOKIE,
  SITTING,
  confined,
  type Activity,
  createSession,
  delegated,
  serves,
  deleteSession,
  findSessionUser,
  type NewSession,
  type SessionAuth,
  type SessionState,
} from "./session.js";
import { superPowersRoutes } from "./superPowers.js";
import { isoOrNull } from "../clock.js";
import { callerFor, callerOf, mayHoldSuperPowers, ownSessionGuard, type Caller } from "../modules/guards.js";

const LOGIN_STASH_COOKIE = "quiz_login";
const LOGOUT_PATH = "/app/auth/logout";

export type SessionUser = typeof users.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
    /**
     * How `user` was resolved: a browser session cookie, a personal API
     * token in `Authorization: Bearer` (ADR-022), or the teacher
     * assistant's own token on its in-process calls (ADR-080 §8; its writes,
     * which the teacher confirmed, are audited as `assistant`, P3). Null when
     * anonymous.
     */
    authVia: "session" | "token" | "assistant" | null;
    /**
     * The assistant's tool a write of `authVia: "assistant"` runs
     * (`ASSIST_TOOL_HEADER`), for its audit entry; null otherwise.
     */
    assistTool: string | null;
    /**
     * What the browser session is (ADR-027) and its Super Powers (ADR-054);
     * null for a token or when anonymous.
     */
    auth: SessionState | null;
    /** `user` and its reach (ADR-054), set with it; null when anonymous. Read through `callerOf`. */
    caller: Caller | null;
    /**
     * The browser session's id as the server stores it (`sid_hash`, never the
     * token): what ends its event streams (`bus.sessionsEnded`). Null
     * whenever `auth` is.
     */
    sid: string | null;
  }
  interface FastifyContextConfig {
    /**
     * The session kinds this route serves (ADR-027). Absent means `portal`
     * only: a new route is closed to a `seb` session until it says otherwise.
     * An `impersonation` session is served wherever `portal` is (ADR-034).
     */
    sessions?: readonly SessionKind[];
    /**
     * The activities a confined session this route serves may be confined
     * to (D21). Absent means an evaluation only: a `seb` session of a
     * project reaches only the routes that say `project` (`PROJECT_SEB`).
     */
    activities?: readonly Activity[];
    /**
     * A `kiosk` session reaches this route only with an attestation checked
     * less than two minutes ago (ADR-051 §6): the submit. Otherwise `423
     * kiosk_attestation_stale`, and the page re-attests and retries once.
     */
    freshAttestation?: boolean;
  }
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** The credential of an `Authorization: Bearer …` header, or null: the one parser (the JSON API, the portal's service routes). */
export function bearerOf(header: string | undefined): string | null {
  return BEARER.exec(header ?? "")?.[1] ?? null;
}

/** The methods that change nothing: CSRF lets them through, and so does a read-only session. */
const SAFE_METHODS: readonly string[] = ["GET", "HEAD", "OPTIONS"];

/**
 * Carried by the in-process calls of the MCP tools (`app.inject`), with a
 * secret drawn at boot. An OAuth access token is bound to the MCP endpoint
 * (RFC 8707, ADR-023); this header is how the routes a tool forwards to
 * accept it, and nothing outside the process can produce it.
 */
export const INTERNAL_CALL_HEADER = "x-quiz-internal-call";

/**
 * The tool a confirmed write of the teacher assistant runs (ADR-080 P3,
 * decision 8): read only beside the assistant's own token on an internal
 * call, and only into its audit entries.
 */
export const ASSIST_TOOL_HEADER = "x-quiz-assist-tool";
const TOOL_NAME = /^[a-z_]{1,64}$/;

async function authPluginImpl(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const provider = new OidcProvider(config, app.log);
  const secure = config.NODE_ENV === "production";
  // Development, and never production (invariant 3): the persona picker, and
  // an impersonation session that may write (ADR-034). One test, one place.
  const development = config.AUTH_DEV_LOGIN && config.NODE_ENV !== "production";
  /**
   * A session's cookie pair, the one place both are set (opened, renewed):
   * the session itself (`httpOnly`), and the CSRF token the frontend reads
   * for the X-CSRF-Token header (double-submit) — when there is one to set.
   * One scope and one expiry. A confined session's are `Strict` (ADR-051
   * §4): nothing cross-site ever carries one. The portal's stay `Lax`: the
   * OIDC callback is a cross-site navigation (N-SEC-01).
   */
  const setSessionCookies = (
    reply: FastifyReply,
    auth: Pick<SessionAuth, "kind">,
    pair: { token: string; csrf: string | undefined; expires: Date },
  ) => {
    const base = { path: "/", sameSite: confined(auth) ? "strict" : "lax", secure } as const;
    reply.setCookie(SESSION_COOKIE, pair.token, { ...base, httpOnly: true, expires: pair.expires });
    if (pair.csrf) reply.setCookie(CSRF_COOKIE, pair.csrf, { ...base, httpOnly: false, expires: pair.expires });
  };

  // --- Session resolution on every request ---
  app.decorateRequest("user", null);
  app.decorateRequest("authVia", null);
  app.decorateRequest("assistTool", null);
  app.decorateRequest("auth", null);
  app.decorateRequest("caller", null);
  app.decorateRequest("sid", null);
  const internalSecret = randomBytes(32).toString("base64url");
  app.decorate("internalCallSecret", internalSecret);
  const isInternalCall = (req: FastifyRequest) => {
    const raw = req.headers[INTERNAL_CALL_HEADER];
    if (typeof raw !== "string" || raw.length !== internalSecret.length) return false;
    return timingSafeEqual(Buffer.from(raw), Buffer.from(internalSecret));
  };
  app.addHook("preHandler", async (req, reply) => {
    // A bearer token is only ever read on the JSON API (ADR-022). When the
    // header is there it is the WHOLE credential: a bad token is anonymous,
    // it never falls back to a cookie that happens to ride along.
    const bearer = req.url.startsWith("/app/api/")
      ? (bearerOf(req.headers.authorization) ?? undefined)
      : undefined;
    if (bearer !== undefined) {
      if (!isApiToken(bearer)) return;
      const found = await findTokenUser(app.db, bearer, app.clock.now());
      if (!found) return;
      // An OAuth token is good for the resource it was issued for, and for
      // the tool calls made on its behalf — nowhere else. The help
      // assistant's token (ADR-080 §8) has no public resource at all: only
      // its own tools' in-process calls, never the MCP endpoint.
      if (found.audience !== null) {
        const path = req.url.split("?")[0];
        const assistant = found.audience === ASSIST_AUDIENCE;
        if (path === MCP_PATH ? assistant : !isInternalCall(req)) return;
      }
      req.user = found.user;
      if (found.audience === ASSIST_AUDIENCE) {
        req.authVia = "assistant";
        const tool = req.headers[ASSIST_TOOL_HEADER];
        req.assistTool = typeof tool === "string" && TOOL_NAME.test(tool) ? tool : null;
      } else req.authVia = "token";
      req.caller = callerFor(found.user, null, app.clock.now());
      return;
    }
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    // A database failure here propagates on purpose: a lookup that cannot run
    // is an outage, not an anonymous visitor. Falling back to "anonymous"
    // would sign every teacher out mid-flow and turn our 5xx into 401.
    const found = await findSessionUser(app.db, token, {
      renewTtlHours: config.SESSION_TTL_HOURS,
      now: app.clock.now(),
    });
    if (!found) return;
    // Default deny (ADR-027): on a route that does not serve its kind, the
    // session is not there at all — anonymous, so a 401 wherever a session
    // is required, and public routes and static files unaffected.
    if (!serves(req.routeOptions.config, found.auth)) return;
    // ADR-051 §1: a confined session is worth something only from the client
    // it was opened in, checked on every request; refused, it is not there —
    // except a suspended station's write and a stale submit, a `423` (§6).
    const { auth, sidHash, sebConfigKey, deviceId } = found;
    if (confined(auth)) {
      const session = { auth, sidHash, sebConfigKey, deviceId, userId: found.user.id };
      const refused = await trustRefused(app.db, config, session, req, app.clock.now());
      if (refused === "anonymous") return;
      if (refused !== null) return reply.code(423).send({ error: refused });
    }
    // ADR-034: outside development, a session acting as a student reads and
    // never writes — every route, by construction, whether or not it calls
    // `requireSession`. Signing out is the one write it keeps.
    if (
      delegated(found.auth) &&
      !development &&
      !SAFE_METHODS.includes(req.method) &&
      req.routeOptions.url !== LOGOUT_PATH
    ) {
      return reply.code(403).send({
        error: "impersonation_read_only",
        message: "This session acts as a student and is read-only",
      });
    }
    req.user = found.user;
    req.authVia = "session";
    req.auth = found.auth;
    req.caller = callerFor(found.user, found.auth, app.clock.now());
    req.sid = found.sidHash;
    // Mirror the sliding renewal on the cookies, else the browser drops them
    // while the server-side session is still alive.
    if (found.renewedTo) {
      setSessionCookies(reply, found.auth, { token, csrf: req.cookies[CSRF_COOKIE], expires: found.renewedTo });
    }
  });

  // --- Reusable guards ---
  app.decorate("requireSession", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    // Double-submit anti-CSRF on every mutation. A bearer token is exempt:
    // a browser never attaches one on its own, which is the whole attack.
    if (req.authVia === "session" && !SAFE_METHODS.includes(req.method)) {
      const cookie = req.cookies[CSRF_COOKIE];
      const header = req.headers[CSRF_HEADER];
      if (!cookie || cookie !== header) {
        return reply.code(403).send({ error: "csrf" });
      }
    }
    return undefined;
  });

  /**
   * Opens a browser session for an account: the ONE place session cookies
   * are minted. The OIDC callback and the development persona picker both
   * go through it, so "signed in" means exactly one thing.
   */
  app.decorate(
    "openSession",
    async (reply: FastifyReply, user: SessionUser, auth: NewSession = PORTAL) => {
      const session = await createSession(app.db, user.id, config.SESSION_TTL_HOURS, auth);
      setSessionCookies(reply, auth, { token: session.token, csrf: session.csrf, expires: session.expiresAt });
    },
  );

  // --- Public configuration ---
  /**
   * The only unauthenticated endpoint: what the sign-in screen must know
   * before anyone has a session. No personal data, no secret.
   */
  app.get(
    "/app/api/config",
    async (): Promise<PublicConfig> => ({
      devLogin: development,
      kiosk:
        config.KIOSK_ATTESTATION === "off"
          ? null
          : {
              extensionId: config.KIOSK_EXTENSION_ID || null,
              mock: config.KIOSK_ATTESTATION === "mock",
            },
    }),
  );

  // --- Routes ---

  app.get("/app/auth/login", async (req, reply) => {
    const { url, codeVerifier, state, nonce } = await provider.beginLogin();
    // `?next=/p/ABC123` (a poll) or `?returnTo=` (the SPA): the same
    // validator, and the path travels in the SIGNED stash cookie beside the
    // PKCE verifier — never in the OIDC `state`, which the IdP echoes back.
    const returnTo = returnToOf(req.query);
    reply.setCookie(LOGIN_STASH_COOKIE, JSON.stringify({ codeVerifier, state, nonce, returnTo }), {
      path: "/app/auth",
      httpOnly: true,
      sameSite: "lax",
      secure,
      signed: true,
      maxAge: 600,
    });
    return reply.redirect(url, 303);
  });

  app.get("/app/auth/callback", async (req, reply) => {
    const raw = req.cookies[LOGIN_STASH_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : { valid: false as const, value: null };
    if (!unsigned.valid || !unsigned.value) {
      return reply
        .code(400)
        .send({ error: "login_state", message: "Missing or invalid login state" });
    }
    const stash = JSON.parse(unsigned.value) as {
      codeVerifier: string;
      state: string;
      nonce: string;
      returnTo?: string;
    };
    reply.clearCookie(LOGIN_STASH_COOKIE, { path: "/app/auth" });

    const callbackUrl = new URL(req.raw.url ?? "", config.PUBLIC_URL);
    let claims: OidcClaims;
    try {
      // The exchange with the identity provider is what the services' status
      // judges (ADR-055 §6); a missing login state above is the browser's
      // doing, and the allowlist below a policy, so neither counts; nor does
      // `access_denied`, the person cancelling at the provider, which answered.
      claims = await tracked(
        "signin",
        () => provider.completeLogin(callbackUrl, stash),
        (err) => errorClass(err) !== "access_denied",
      );
    } catch (err) {
      req.log.warn({ err }, "OIDC exchange failed");
      return reply.code(401).send({ error: "oidc", message: "Authentication refused" });
    }

    // The staging allowlist (ADR-028) is checked before any row is written:
    // a refused login leaves no user behind.
    if (!loginAdmits(config, claims)) {
      req.log.warn({ sub: claims.sub }, "Login refused by LOGIN_ALLOWLIST or a placeholder subject");
      return reply
        .code(403)
        .send({ error: "login_not_allowed", message: "This environment is restricted" });
    }

    const user = await signIn(app.db, config, claims);
    await app.openSession(reply, user);
    await audit(app.db, {
      actorUserId: user.id,
      actorType: "user",
      action: "auth.login",
      subjectType: "user",
      subjectId: user.id,
    });
    return reply.redirect(safeReturnTo(stash.returnTo), 303);
  });

  await apiTokenRoutes(app);
  await sebRoutes(app, config);
  await oauthRoutes(app, config);
  await impersonationRoutes(app);
  await superPowersRoutes(app);

  // Development persona picker. Registered only when explicitly enabled, and
  // config.ts refuses the flag under NODE_ENV=production.
  if (development) {
    app.log.warn("AUTH_DEV_LOGIN is on: /app/auth/dev opens sessions without an IdP");
    await devLoginRoutes(app, config);
  }

  app.post(
    LOGOUT_PATH,
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      // The audit entry is `deleteSession`'s: `auth.logout`, or the end of an impersonation.
      // And `superpowers.disabled` (`logout`) when they were still on (ADR-054).
      if (token) await deleteSession(app.db, token, app.clock.now());
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(CSRF_COOKIE, { path: "/" });
      return reply.code(204).send();
    },
  );

  app.get(
    "/app/api/me",
    // Every confined session reads who it is, whatever its activity (D21).
    { preHandler: (req, reply) => app.requireSession(req, reply), config: { ...SITTING, activities: ["evaluation", "project"] } },
    async (req) => {
      const u = req.user!;
      // Uploaded avatar takes priority over the IdP claim; ?v= busts the cache.
      const [uploaded] = await app.db
        .select({ updatedAt: avatars.updatedAt })
        .from(avatars)
        .where(eq(avatars.userId, u.id))
        .limit(1);
      const picture = shownAvatar(u.id, uploaded?.updatedAt, u.pictureUrl);
      return {
        id: u.id,
        email: u.email,
        givenName: u.givenName,
        familyName: u.familyName,
        role: u.role,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        avatarUrl: picture,
        hasUploadedAvatar: Boolean(uploaded),
        locale: u.locale,
        dateFormat: u.dateFormat,
        mcqPolicy: u.mcqPolicy,
        coach: { enabled: u.coachEnabled, seen: u.coachSeen },
        rpnCalculator: u.rpnCalculator,
        session: {
          kind: req.auth?.kind ?? "portal",
          evaluationId: req.auth?.evaluationId ?? null,
          projectId: req.auth?.projectId ?? null,
          readOnly: delegated(req.auth) && !development,
          superPowersUntil: isoOrNull(
            callerOf(req).reach === "all" ? (req.auth?.superPowersUntil ?? null) : null,
          ),
          superPowersAvailable: mayHoldSuperPowers(u, req.auth),
        },
      };
    },
  );

  // Account preferences persisted server-side, so they follow the user
  // across devices.
  app.patch(
    "/app/api/me",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      // Invariant 7: the body is validated by the contract schema the SPA
      // sends against, never by a hand-rolled chain of `in` checks.
      const parsed = MePatch.safeParse(req.body ?? {});
      if (!parsed.success) return invalid(reply, parsed.error);
      const patch = parsed.data;
      await app.db.update(users).set(patch).where(eq(users.id, req.user!.id));
      const before = req.user!;
      // The language, the date format and the MCQ policy are read by every
      // tab of the same account. This is the one place a hint to the actor's
      // own topic is wanted, and it is safe: it only refreshes `GET /me`,
      // which emits nothing in return (see the `onResponse` hook in app.ts).
      publish("mutation", [`user:${before.id}`]);
      return {
        locale: patch.locale === undefined ? before.locale : patch.locale,
        dateFormat: patch.dateFormat === undefined ? before.dateFormat : patch.dateFormat,
        mcqPolicy: patch.mcqPolicy === undefined ? before.mcqPolicy : patch.mcqPolicy,
      };
    },
  );

  // The coach marks a user has read. A merge in SQL rather than a
  // read-modify-write: two tabs reporting at once must both be kept.
  app.post(
    "/app/api/me/coach",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const parsed = CoachSeenPatch.safeParse(req.body ?? {});
      if (!parsed.success) return invalid(reply, parsed.error);
      const body = parsed.data;
      const [row] = await app.db
        .update(users)
        .set({
          coachSeen:
            "reset" in body
              ? []
              : // `x(v)` and not a bare alias: a bare `id` resolves to
                // `users.id` and lifts the aggregate into the UPDATE itself.
                sql`(select coalesce(jsonb_agg(distinct x.v order by x.v), '[]'::jsonb)
                       from jsonb_array_elements_text(${users.coachSeen} || ${JSON.stringify(body.seen)}::jsonb) as x(v))`,
        })
        .where(eq(users.id, req.user!.id))
        .returning({ seen: users.coachSeen });
      publish("mutation", [`user:${req.user!.id}`]);
      return { seen: row?.seen ?? [] };
    },
  );

  // What's new acknowledged (ADR-087): every entry live until now is seen,
  // on the database's clock, the one that dated the entries. The account's
  // own portal session only: an impersonation is refused here in development
  // too, not only by the read-only rule above.
  app.post("/app/api/me/changelog", { preHandler: ownSessionGuard(app) }, async (req, reply) => {
    await app.db.update(users).set({ changelogSeenAt: sql`now()` }).where(eq(users.id, req.user!.id));
    return reply.code(204).send();
  });
}

declare module "fastify" {
  interface FastifyInstance {
    requireSession: (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<FastifyReply | undefined>;
    /** Mints the session cookies for `user` (the single sign-in path); a portal session by default. */
    openSession: (reply: FastifyReply, user: SessionUser, auth?: NewSession) => Promise<void>;
    /** The value of {@link INTERNAL_CALL_HEADER} for this process. */
    internalCallSecret: string;
  }
}

/** fastify-plugin: the decorators (request.user, requireSession) must be
 *  visible to the other plugins; without fp they would stay encapsulated. */
export const authPlugin = fp(authPluginImpl, { name: "auth" });
