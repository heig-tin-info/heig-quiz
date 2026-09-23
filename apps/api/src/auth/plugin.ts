import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { avatars, users } from "../db/schema.js";
import { publish } from "../events.js";
import { MePatch, type PublicConfig } from "@quiz/contracts";

import { claimEnrollments } from "../modules/org/service.js";
import { roleForIdentity } from "../roles.js";
import { addressesOf, affiliationsOf, recordIdpClaims, syncUserEmails } from "./claims.js";
import { devLoginRoutes } from "./dev.js";
import { OidcProvider, type OidcClaims } from "./oidc.js";
import { returnToOf, safeReturnTo } from "./returnTo.js";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  createSession,
  deleteSession,
  findSessionUser,
} from "./session.js";

const LOGIN_STASH_COOKIE = "quiz_login";

export type SessionUser = typeof users.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

/**
 * User upsert at login (key: oidc_sub). The role is recomputed on every
 * login through the single rule of roles.ts.
 */
async function upsertUser(
  app: FastifyInstance,
  config: AppConfig,
  claims: OidcClaims,
): Promise<SessionUser> {
  // The role is computed on every address the IdP revealed, and on the
  // affiliations it asserts — a grant issued on an institutional address
  // must reach someone signing in under a private one.
  const role = await roleForIdentity(app.db, config, {
    emails: addressesOf(claims.raw).map((a) => a.email),
    affiliations: affiliationsOf(claims.raw),
  });
  const now = new Date();
  const [row] = await app.db
    .insert(users)
    .values({
      id: randomUUID(),
      oidcSub: claims.sub,
      email: claims.email,
      emailVerified: claims.emailVerified,
      givenName: claims.givenName,
      familyName: claims.familyName,
      swissEduId: claims.swissEduId,
      pictureUrl: claims.picture,
      role,
      lastLoginAt: now,
    })
    .onConflictDoUpdate({
      target: users.oidcSub,
      set: {
        email: claims.email,
        emailVerified: claims.emailVerified,
        givenName: claims.givenName,
        familyName: claims.familyName,
        swissEduId: claims.swissEduId,
        pictureUrl: claims.picture,
        role,
        lastLoginAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("User upsert returned no row");
  return row;
}

async function authPluginImpl(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const provider = new OidcProvider(config, app.log);
  const secure = config.NODE_ENV === "production";

  // --- Session resolution on every request ---
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    // A database failure here propagates on purpose: a lookup that cannot run
    // is an outage, not an anonymous visitor. Falling back to "anonymous"
    // would sign every teacher out mid-flow and turn our 5xx into 401.
    const found = await findSessionUser(app.db, token, {
      renewTtlHours: config.SESSION_TTL_HOURS,
    });
    if (!found) return;
    req.user = found.user;
    // Mirror the sliding renewal on the cookies, else the browser drops them
    // while the server-side session is still alive.
    if (found.renewedTo) {
      const base = { path: "/", sameSite: "lax", secure } as const;
      reply.setCookie(SESSION_COOKIE, token, {
        ...base,
        httpOnly: true,
        expires: found.renewedTo,
      });
      const csrf = req.cookies[CSRF_COOKIE];
      if (csrf) {
        reply.setCookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false, expires: found.renewedTo });
      }
    }
  });

  // --- Reusable guards ---
  app.decorate("requireSession", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    // Double-submit anti-CSRF on every mutation.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
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
    async (reply: FastifyReply, user: SessionUser) => {
      const session = await createSession(app.db, user.id, config.SESSION_TTL_HOURS);
      const base = { path: "/", sameSite: "lax", secure } as const;
      reply.setCookie(SESSION_COOKIE, session.token, {
        ...base,
        httpOnly: true,
        expires: session.expiresAt,
      });
      // Readable by the frontend for the X-CSRF-Token header (double-submit).
      reply.setCookie(CSRF_COOKIE, session.csrf, {
        ...base,
        httpOnly: false,
        expires: session.expiresAt,
      });
    },
  );

  // --- Public configuration ---
  /**
   * The only unauthenticated endpoint: what the sign-in screen must know
   * before anyone has a session. No personal data, no secret.
   */
  app.get("/app/api/config", async (): Promise<PublicConfig> => ({
    devLogin: config.AUTH_DEV_LOGIN && config.NODE_ENV !== "production",
  }));

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
      claims = await provider.completeLogin(callbackUrl, stash);
    } catch (err) {
      req.log.warn({ err }, "OIDC exchange failed");
      return reply.code(401).send({ error: "oidc", message: "Authentication refused" });
    }

    const user = await upsertUser(app, config, claims);
    // Snapshot of what the IdP released: diagnostic material, and never a
    // reason to refuse a session.
    try {
      await recordIdpClaims(app.db, user.id, claims.raw);
    } catch (err) {
      req.log.warn({ err }, "Could not record the IdP claims");
    }
    // The address set, on the other hand, IS load-bearing: the roster
    // matching below reads it, so a failure here must surface.
    await syncUserEmails(app.db, user.id, claims.raw, claims.emailVerified);
    if (claims.emailVerified) await claimEnrollments(app.db, { id: user.id });
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

  // Development persona picker. Registered only when explicitly enabled, and
  // config.ts refuses the flag under NODE_ENV=production.
  if (config.AUTH_DEV_LOGIN && config.NODE_ENV !== "production") {
    app.log.warn("AUTH_DEV_LOGIN is on: /app/auth/dev opens sessions without an IdP");
    await devLoginRoutes(app, config);
  }

  app.post(
    "/app/auth/logout",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) await deleteSession(app.db, token);
      await audit(app.db, {
        actorUserId: req.user?.id ?? null,
        actorType: "user",
        action: "auth.logout",
        subjectType: "user",
        subjectId: req.user?.id ?? "unknown",
      });
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(CSRF_COOKIE, { path: "/" });
      return reply.code(204).send();
    },
  );

  app.get(
    "/app/api/me",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req) => {
      const u = req.user!;
      // Uploaded avatar takes priority over the IdP claim; ?v= busts the cache.
      const [uploaded] = await app.db
        .select({ updatedAt: avatars.updatedAt })
        .from(avatars)
        .where(eq(avatars.userId, u.id))
        .limit(1);
      const avatarUrl = uploaded
        ? `/app/api/users/${u.id}/avatar?v=${uploaded.updatedAt.getTime()}`
        : u.pictureUrl;
      return {
        id: u.id,
        email: u.email,
        givenName: u.givenName,
        familyName: u.familyName,
        role: u.role,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        avatarUrl,
        hasUploadedAvatar: Boolean(uploaded),
        locale: u.locale,
        dateFormat: u.dateFormat,
        mcqPolicy: u.mcqPolicy,
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
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "validation", message: "Unsupported preference", details: parsed.error.issues });
      }
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
}

declare module "fastify" {
  interface FastifyInstance {
    requireSession: (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<FastifyReply | undefined>;
    /** Mints the session cookies for `user` (the single sign-in path). */
    openSession: (reply: FastifyReply, user: SessionUser) => Promise<void>;
  }
}

/** fastify-plugin: the decorators (request.user, requireSession) must be
 *  visible to the other plugins; without fp they would stay encapsulated. */
export const authPlugin = fp(authPluginImpl, { name: "auth" });
