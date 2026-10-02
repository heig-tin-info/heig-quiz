/**
 * Linking a user's GitHub account (F-GH-05, N-SEC-16, invariant 15; merge
 * task M2-03, ported from heig-classroom's `auth/github-link.ts`). This file
 * is the one writer of `github_accounts`: the link, the unlink, the rename,
 * and the links the heig-classroom import carries over (`importAccountLink`).
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
 * Only the user's own portal session may link or unlink (`ownSessionGuard`,
 * the rule of Super Powers too): never a session somebody else acts through
 * (ADR-034) nor a Bearer token — `403 session_required`. A confined session
 * (ADR-027, ADR-051) is not even there on these routes (default deny,
 * `serves`), so it gets the 401 of an anonymous caller.
 *
 * The whole plugin is registered only while `githubApp(config)` is on
 * (`app.ts`): with GitHub off, every route here is a 404. Production
 * refuses to boot an App without its OAuth client (`config.ts`).
 */
import { randomBytes } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { App, Octokit } from "octokit";
import { z } from "zod";

import {
  GITHUB_ACCOUNT_STALE,
  type GithubAccountState,
  type GithubLinkOutcome,
} from "@quiz/contracts";

import { audit } from "../audit.js";
import { iso } from "../clock.js";
import type { AppConfig } from "../config.js";
import { isUniqueViolation, type Db, type Tx } from "../db/client.js";
import {
  classrooms,
  courseStaff,
  enrollments,
  githubAccounts,
  githubClassroomLinks,
  projectGroupMembers,
  projectRepos,
} from "../db/schema.js";
import { publish } from "../events.js";
import { githubApp } from "../github/app.js";
import { currentLogin } from "../github/collaborators.js";
import { ownSessionGuard } from "../modules/guards.js";
import { safeReturnTo } from "./returnTo.js";
import { GITHUB_CALLBACK_PATH } from "./paths.js";

export const GITHUB_LINK_PATH = "/app/auth/github/link";
/** GitHub's return. Its query carries the one-time `code`: the request log masks it (`redact.ts`). */
export { GITHUB_CALLBACK_PATH } from "./paths.js";
const ACCOUNT_PATH = "/app/api/me/github";

const STATE_COOKIE = "quiz_github_link";
/** Sent to the link and the callback only. */
const STATE_COOKIE_PATH = "/app/auth/github";
const STATE_TTL_MS = 10 * 60_000;

/** Where a return that is not an in-app page lands: the user's Settings, which hold the GitHub card. */
const SETTINGS = "/settings";

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
interface GithubUser {
  id: number;
  login: string;
}

/**
 * Exchanges the code and reads the account it belongs to. The user token is
 * this function's local: it serves `GET /user` once, then its revocation at
 * GitHub is sent without being awaited (the token would expire on its own;
 * a failure is logged, never the token) and it is dropped.
 */
async function readAccount(app: App, code: string, log: FastifyBaseLogger): Promise<GithubUser> {
  const { authentication } = await app.oauth.createToken({ code });
  const token = authentication.token;
  try {
    const octokit = await app.oauth.getUserOctokit({ token });
    const { data } = await octokit.request("GET /user");
    // GitHub's user ids fit a double (`github_user_id` is a bigint in `number` mode).
    return { id: Number(data.id), login: data.login };
  } finally {
    void app.oauth.deleteToken({ token }).catch((err: unknown) => {
      log.warn({ err: failure(err) }, "GitHub user token revocation failed");
    });
  }
}

/**
 * What the log may say of a failure here: its name, status and message.
 * Never the error itself: an Octokit `RequestError` carries its request, and
 * the BODY of the code exchange (client secret, code) or of the revocation
 * (the user token) is not redacted by Octokit — only its header is.
 */
function failure(err: unknown) {
  const { name, status, message } = (err ?? {}) as { name?: unknown; status?: unknown; message?: unknown };
  return { name, status, message };
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

/** What became of one heig-classroom account link at the import. */
export type ImportedLinkOutcome =
  /** Written. */
  | "linked"
  /** The user already holds this very account (its login, if different, is Quiz's). */
  | "present"
  /** The user already holds another GitHub account: Quiz's is kept. */
  | "user_linked_elsewhere"
  /** The GitHub account is already another Quiz user's: nothing written. */
  | "account_taken";

/**
 * Carries a heig-classroom account link over to the Quiz user it was matched
 * to (spec 06 no. 44; merge task M1-06, `scripts/import-classroom.ts`). A link
 * is an identity, not a grant — the person's GitHub id and login, no token —
 * so the App that recorded it does not matter. Never moves an existing link:
 * Quiz's side wins every disagreement, which the import reports.
 */
export async function importAccountLink(
  db: Db | Tx,
  userId: string,
  account: GithubUser,
  linkedAt: Date,
): Promise<ImportedLinkOutcome> {
  const [mine] = await db
    .select({ githubUserId: githubAccounts.githubUserId })
    .from(githubAccounts)
    .where(eq(githubAccounts.userId, userId));
  if (mine) return mine.githubUserId === account.id ? "present" : "user_linked_elsewhere";
  const [taken] = await db
    .select({ userId: githubAccounts.userId })
    .from(githubAccounts)
    .where(eq(githubAccounts.githubUserId, account.id));
  if (taken) return "account_taken";
  await db
    .insert(githubAccounts)
    .values({ userId, githubUserId: account.id, login: account.login, linkedAt });
  await audit(db, {
    actorUserId: null,
    actorType: "system",
    action: "github.linked",
    subjectType: "user",
    subjectId: userId,
    payload: { githubUserId: account.id, login: account.login, via: "classroom_import" },
  });
  return "linked";
}

/**
 * Whether the user Settings card shows (F-GH-05, 05-web §5.3): the user is
 * on the staff of a classroom connected to GitHub, holds a claimed seat in
 * one, or has or had a project repository — their own, or one of a group
 * they are a member of — even once the classroom is disconnected.
 */
async function linkRelevant(db: Db, userId: string): Promise<boolean> {
  const one = { one: sql<number>`1` };
  const [row] = await db
    .select(one)
    .from(courseStaff)
    .innerJoin(classrooms, eq(classrooms.courseId, courseStaff.courseId))
    .innerJoin(githubClassroomLinks, eq(githubClassroomLinks.classroomId, classrooms.id))
    .where(eq(courseStaff.userId, userId))
    .union(
      db
        .select(one)
        .from(enrollments)
        .innerJoin(githubClassroomLinks, eq(githubClassroomLinks.classroomId, enrollments.classroomId))
        .where(eq(enrollments.userId, userId)),
    )
    .union(db.select(one).from(projectRepos).where(eq(projectRepos.userId, userId)))
    .union(
      db
        .select(one)
        .from(enrollments)
        .innerJoin(projectGroupMembers, eq(projectGroupMembers.enrollmentId, enrollments.id))
        .innerJoin(projectRepos, eq(projectRepos.groupId, projectGroupMembers.groupId))
        .where(eq(enrollments.userId, userId)),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The login GitHub knows TODAY for a user's linked account, followed through
 * its immutable id (`GET /user/{account_id}`, heig-classroom #41): a renamed
 * account's row is updated and `github.renamed` audited. A user with no link
 * left, or whose account GitHub no longer has, gets `GITHUB_ACCOUNT_STALE` —
 * the `409` body, "Relink GitHub" in the web. Any other failure (GitHub
 * unreachable, rate limit) throws: the caller may then go on with the stored
 * login. `octokit` is an installation client of the caller's organization
 * (an App JWT cannot read users).
 *
 * For the tasks that name or invite a student on GitHub (M3-03, M4-03);
 * nothing calls it yet.
 */
export async function linkedLogin(
  db: Db,
  octokit: Octokit,
  userId: string,
): Promise<string | typeof GITHUB_ACCOUNT_STALE> {
  const [linked] = await db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId));
  if (!linked) return GITHUB_ACCOUNT_STALE;
  const login = await currentLogin(octokit, linked.githubUserId);
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
  const github = githubApp(config);
  if (!github) throw new Error("githubLinkPlugin: the GitHub App is not configured");
  const secure = config.NODE_ENV === "production";
  const redirectUri = new URL(GITHUB_CALLBACK_PATH, config.PUBLIC_URL).href;
  const ownSession = ownSessionGuard(app);

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
    if (state.nonce !== echoed) return null;
    if (state.userId !== req.user!.id) return null;
    if (state.expiresAt <= app.clock.now().getTime()) return null;
    return state;
  };

  app.get(GITHUB_LINK_PATH, { preHandler: ownSession }, async (req, reply) => {
    const nonce = randomBytes(24).toString("base64url");
    const state: LinkState = {
      nonce,
      userId: req.user!.id,
      returnTo: linkReturn((req.query as { return?: unknown }).return),
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
    // One round trip, one state: GitHub's code is single-use, so a state
    // that came back has nothing left to serve.
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
      const account = await readAccount(github, code, req.log);
      outcome = await saveAccount(app.db, state.userId, account, app.clock.now());
    } catch (err) {
      req.log.warn({ err: failure(err) }, "GitHub account linking failed");
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
