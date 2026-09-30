/**
 * Linking a user's GitHub account (F-GH-05, N-SEC-16, invariant 15; merge
 * task M2-03, ported from heig-classroom's `auth/github-link.ts`).
 *
 * The flow is the user-to-server OAuth of Quiz's OWN App (D23): no OAuth App
 * and no scope, so the user grants nothing on their repositories, and it is
 * never a sign-in — the user is already signed in, and stays who they are.
 *
 *   1. `GET /app/auth/github/link?return=<path>` sets a signed state cookie
 *      (a nonce, the user, the page to come back to, an expiry by the
 *      server's clock) and sends the browser to GitHub.
 *   2. GitHub sends it back to `GET /app/auth/github/callback?code&state`:
 *      the state is checked against the cookie, the code exchanged for a
 *      user token, `GET /user` read with it, and the token revoked. It lives
 *      in one local of {@link readAccount} and nowhere else: never stored,
 *      never logged, never returned.
 *   3. The account's immutable id and its login are written to
 *      `github_accounts`, and the browser goes back to the page it started
 *      from with `?github=linked | conflict | error` (`GithubLinkOutcome`).
 *
 * Only the user's own portal session may link or unlink: never a session
 * somebody else acts through (ADR-034) nor a confined one (ADR-027,
 * ADR-051). A confined session is not even there on these routes (default
 * deny, `serves`), so it gets the 401 of an anonymous caller; a delegated
 * one gets `403 session_required`, the refusal of Super Powers
 * (`superPowers.ts`) for the same reason.
 *
 * The whole plugin is registered only while `githubApp(config)` is on
 * (`app.ts`): with GitHub off, every route here is a 404.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Octokit } from "octokit";
import { z } from "zod";

import type { GithubAccountState, GithubLinkOutcome } from "@quiz/contracts";

import { audit } from "../audit.js";
import { iso } from "../clock.js";
import type { AppConfig } from "../config.js";
import { isUniqueViolation, type Db } from "../db/client.js";
import { classrooms, courseStaff, githubAccounts, githubClassroomLinks } from "../db/schema.js";
import { publish } from "../events.js";
import { currentLogin as loginOnGithub } from "../github/collaborators.js";
import { safeReturnTo } from "./returnTo.js";
import { delegated } from "./session.js";

export const GITHUB_LINK_PATH = "/app/auth/github/link";
/** GitHub's return. Its query carries the one-time `code`: the request log masks it (`redact.ts`). */
export const GITHUB_CALLBACK_PATH = "/app/auth/github/callback";
const ACCOUNT_PATH = "/app/api/me/github";

const STATE_COOKIE = "quiz_github_link";
/** Sent to the link and the callback only. */
const STATE_COOKIE_PATH = "/app/auth/github";
const STATE_TTL_MS = 10 * 60_000;

/** Where a return that is not an in-app page lands: the user's Settings, which hold the GitHub card. */
const SETTINGS = "/settings";

/** The {@link GithubAccountState} refusal of `currentLogin`, the body of its `409`. */
export const GITHUB_ACCOUNT_STALE = { error: "github_account_stale" } as const;

/**
 * The page to come back to: an in-app path of the SPA, by the one validator
 * of the login round trips (`safeReturnTo`). Anything else — a full URL, a
 * `//host`, the home page, or a path of the API itself (`/app/…`, where the
 * link route would only loop) — becomes the Settings page.
 */
export function linkReturn(raw: unknown): string {
  const path = safeReturnTo(raw);
  return path === "/" || path.startsWith("/app/") ? SETTINGS : path;
}

/** `path` with `?github=<outcome>` set, its other parameters and fragment kept. */
function withOutcome(path: string, outcome: GithubLinkOutcome): string {
  const url = new URL(path, "https://x.invalid");
  url.searchParams.set("github", outcome);
  return url.pathname + url.search + url.hash;
}

/** What the signed cookie carries between the link and the callback. */
const LinkState = z.object({
  nonce: z.string().min(1),
  userId: z.uuid(),
  returnTo: z.string(),
  /** The server's clock (invariant 5), in ms; the cookie's own `maxAge` is the browser's affair. */
  expiresAt: z.number(),
});
type LinkState = z.infer<typeof LinkState>;

/** GitHub's `GET /user`, the two fields kept. */
const GithubUser = z.object({ id: z.number().int().positive(), login: z.string().min(1) });
type GithubUser = z.infer<typeof GithubUser>;

const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "heig-quiz",
  "x-github-api-version": "2022-11-28",
} as const;

/**
 * Exchanges the code and reads the account it belongs to. The user token is
 * this function's local: it serves `GET /user` once and is then revoked at
 * GitHub (best effort — it would expire on its own) and dropped. No error
 * thrown here carries it: each names a status only.
 */
async function readAccount(config: AppConfig, code: string): Promise<GithubUser> {
  const exchange = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.GITHUB_APP_CLIENT_ID,
      client_secret: config.GITHUB_APP_CLIENT_SECRET,
      code,
    }),
  });
  const token = ((await exchange.json().catch(() => null)) as { access_token?: unknown } | null)
    ?.access_token;
  if (!exchange.ok || typeof token !== "string" || token === "") {
    throw new Error(`GitHub code exchange refused (${exchange.status})`);
  }
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`GitHub GET /user: ${res.status}`);
    const user = GithubUser.safeParse(await res.json());
    if (!user.success) throw new Error("GitHub GET /user: unexpected body");
    return { id: user.data.id, login: user.data.login };
  } finally {
    const basic = Buffer.from(
      `${config.GITHUB_APP_CLIENT_ID}:${config.GITHUB_APP_CLIENT_SECRET}`,
    ).toString("base64");
    await fetch(
      `https://api.github.com/applications/${encodeURIComponent(config.GITHUB_APP_CLIENT_ID)}/token`,
      {
        method: "DELETE",
        headers: { ...GITHUB_HEADERS, authorization: `Basic ${basic}` },
        body: JSON.stringify({ access_token: token }),
      },
    ).catch(() => undefined);
  }
}

/**
 * Writes the link: the user's row, created or moved to this account. The
 * UNIQUE on `github_user_id` is the refusal of an account already another
 * user's (`conflict`, and nothing written).
 */
async function saveAccount(
  db: Db,
  userId: string,
  account: GithubUser,
  now: Date,
): Promise<GithubLinkOutcome> {
  const row = { githubUserId: account.id, login: account.login, linkedAt: now };
  const entry = {
    actorUserId: userId,
    actorType: "user",
    subjectType: "user",
    subjectId: userId,
  } as const;
  try {
    await db
      .insert(githubAccounts)
      .values({ userId, ...row })
      .onConflictDoUpdate({ target: githubAccounts.userId, set: row });
  } catch (err) {
    if (!isUniqueViolation(err, "github_accounts_github_user_id_unique")) throw err;
    await audit(db, { ...entry, action: "github.link_conflict", payload: { githubUserId: account.id } });
    return "conflict";
  }
  await audit(db, {
    ...entry,
    action: "github.linked",
    payload: { githubUserId: account.id, login: account.login },
  });
  return "linked";
}

/**
 * Whether the user Settings card shows (F-GH-05, 05-web §5.3): the user is
 * on the staff of a classroom connected to GitHub. "Has or had a project"
 * joins this test when projects exist (M3-01).
 */
async function linkRelevant(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(courseStaff)
    .innerJoin(classrooms, eq(classrooms.courseId, courseStaff.courseId))
    .innerJoin(githubClassroomLinks, eq(githubClassroomLinks.classroomId, classrooms.id))
    .where(eq(courseStaff.userId, userId))
    .limit(1);
  return row !== undefined;
}

/**
 * The login GitHub knows TODAY for a user's linked account, followed through
 * its immutable id (`GET /user/{account_id}`, heig-classroom #41): a renamed
 * account's row is updated and `github.renamed` audited. A user with no link
 * left, or whose account GitHub no longer has, gets
 * {@link GITHUB_ACCOUNT_STALE} — the `409` body, "Relink GitHub" in the web.
 * Any other failure (GitHub unreachable, rate limit) throws: the caller may
 * then go on with the stored login. `octokit` is an installation client of
 * the caller's organization (an App JWT cannot read users).
 *
 * For the tasks that name or invite a student on GitHub (M3-03, M4-03);
 * nothing calls it yet.
 */
export async function currentLogin(
  db: Db,
  octokit: Octokit,
  userId: string,
): Promise<string | typeof GITHUB_ACCOUNT_STALE> {
  const [linked] = await db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId));
  if (!linked) return GITHUB_ACCOUNT_STALE;
  const login = await loginOnGithub(octokit, linked.githubUserId);
  if (login === null) return GITHUB_ACCOUNT_STALE;
  if (login === linked.login) return login;
  // Conditional on the login read: two requests that notice the same rename
  // audit it once.
  const moved = await db
    .update(githubAccounts)
    .set({ login })
    .where(and(eq(githubAccounts.userId, userId), eq(githubAccounts.login, linked.login)))
    .returning({ userId: githubAccounts.userId });
  if (moved.length > 0) {
    await audit(db, {
      actorUserId: null,
      actorType: "system",
      action: "github.renamed",
      subjectType: "user",
      subjectId: userId,
      payload: { githubUserId: linked.githubUserId, from: linked.login, to: login },
    });
  }
  return login;
}

export async function githubLinkPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const { config } = opts;
  const secure = config.NODE_ENV === "production";
  const redirectUri = new URL(GITHUB_CALLBACK_PATH, config.PUBLIC_URL).href;

  /** The caller's own portal session, and nothing else (module comment). */
  const ownSession = async (req: FastifyRequest, reply: FastifyReply) => {
    const denied = await app.requireSession(req, reply);
    if (denied) return denied;
    if (req.authVia !== "session" || req.auth?.kind !== "portal" || delegated(req.auth)) {
      return reply.code(403).send({ error: "session_required" });
    }
    return undefined;
  };

  /**
   * The state of this callback, or null: the cookie present and signed by
   * us, not past its expiry by the server's clock, issued to THIS user, and
   * its nonce the one GitHub echoes back.
   */
  const stateOf = (req: FastifyRequest): LinkState | null => {
    const raw = req.cookies[STATE_COOKIE];
    const echoed = (req.query as { state?: unknown }).state;
    if (!raw || typeof echoed !== "string") return null;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value === null) return null;
    let parsed: ReturnType<typeof LinkState.safeParse>;
    try {
      parsed = LinkState.safeParse(JSON.parse(unsigned.value));
    } catch {
      return null;
    }
    if (!parsed.success) return null;
    const state = parsed.data;
    const a = Buffer.from(state.nonce);
    const b = Buffer.from(echoed);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (state.userId !== req.user!.id) return null;
    if (state.expiresAt <= app.clock.now().getTime()) return null;
    return state;
  };

  app.get(GITHUB_LINK_PATH, { preHandler: ownSession }, async (req, reply) => {
    const returnTo = linkReturn((req.query as { return?: unknown }).return);
    if (config.GITHUB_APP_CLIENT_ID === "" || config.GITHUB_APP_CLIENT_SECRET === "") {
      req.log.warn("GitHub account linking needs GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET");
      return reply.redirect(withOutcome(returnTo, "error"), 303);
    }
    const nonce = randomBytes(24).toString("base64url");
    const state: LinkState = {
      nonce,
      userId: req.user!.id,
      returnTo,
      expiresAt: app.clock.now().getTime() + STATE_TTL_MS,
    };
    reply.setCookie(STATE_COOKIE, JSON.stringify(state), {
      path: STATE_COOKIE_PATH,
      httpOnly: true,
      // Lax: GitHub's redirect back is a cross-site top-level GET, which
      // Lax lets through and Strict would not.
      sameSite: "lax",
      secure,
      signed: true,
      maxAge: STATE_TTL_MS / 1000,
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", config.GITHUB_APP_CLIENT_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    // No scope: an App's user token has none, and `GET /user` needs none.
    url.searchParams.set("state", nonce);
    return reply.redirect(url.href, 303);
  });

  app.get(GITHUB_CALLBACK_PATH, { preHandler: ownSession }, async (req, reply) => {
    const state = stateOf(req);
    // Used or refused, a state serves once.
    reply.clearCookie(STATE_COOKIE, { path: STATE_COOKIE_PATH });
    // A forged, replayed or stale callback reaches GitHub for nothing and
    // writes nothing; without a trusted state there is no page to go back to.
    if (!state) return reply.redirect(withOutcome(SETTINGS, "error"), 303);
    const back = (outcome: GithubLinkOutcome) =>
      reply.redirect(withOutcome(state.returnTo, outcome), 303);
    // No code: the user cancelled at GitHub (`error=access_denied`).
    const code = (req.query as { code?: unknown }).code;
    if (typeof code !== "string" || code === "") return back("error");
    let outcome: GithubLinkOutcome;
    try {
      const account = await readAccount(config, code);
      outcome = await saveAccount(app.db, state.userId, account, app.clock.now());
    } catch (err) {
      req.log.warn({ err }, "GitHub account linking failed");
      return back("error");
    }
    // The user's other tabs refresh their card; a GET publishes no hint of its own (`app.ts`).
    if (outcome === "linked") publish("mutation", [`user:${state.userId}`]);
    return back(outcome);
  });

  app.get(
    ACCOUNT_PATH,
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req): Promise<GithubAccountState> => {
      const userId = req.user!.id;
      const [linked] = await app.db
        .select({ login: githubAccounts.login, linkedAt: githubAccounts.linkedAt })
        .from(githubAccounts)
        .where(eq(githubAccounts.userId, userId));
      return {
        account: linked ? { login: linked.login, linkedAt: iso(linked.linkedAt) } : null,
        relevant: await linkRelevant(app.db, userId),
      };
    },
  );

  /** Unlinks. Idempotent: with no link, nothing is written and nothing audited. */
  app.delete(ACCOUNT_PATH, { preHandler: ownSession }, async (req, reply) => {
    const userId = req.user!.id;
    const [gone] = await app.db
      .delete(githubAccounts)
      .where(eq(githubAccounts.userId, userId))
      .returning({ githubUserId: githubAccounts.githubUserId, login: githubAccounts.login });
    if (gone) {
      await audit(app.db, {
        actorUserId: userId,
        actorType: "user",
        action: "github.unlinked",
        subjectType: "user",
        subjectId: userId,
        payload: gone,
      });
      publish("mutation", [`user:${userId}`]);
    }
    return reply.code(204).send();
  });
}
