/**
 * The door of an OIDC login (ADR-028 §3, ADR-111): the facts `loginRefusal`
 * loads for the pure rule (`admissionRefusal`, tested in `@quiz/domain`),
 * and the callback's answer, judged before any row is written.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig, type AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  auditLog,
  classrooms,
  courses,
  enrollments,
  teacherGrants,
  userEmails,
  userIdpClaims,
  users,
} from "../db/schema.js";
import { testServer, type TestServer } from "../test/http.js";
import { oidcClaims } from "../test/oidc.js";
import { placeholderSub } from "./adoption.js";
import { loginRefusal, signIn } from "./login.js";
import { OidcProvider, type OidcClaims } from "./oidc.js";

let server: TestServer;
let db: Db;
/** Admission alone, no allowlist: what production runs once it sets the list. */
let config: AppConfig;
let adminId: string;

beforeAll(async () => {
  server = await testServer({
    SUPER_ADMIN_EMAIL: "boss@example.org",
    LOGIN_ALLOWLIST: "dev@gmail.test,stranger@gmail.test,@heig-vd.ch",
    LOGIN_DOMAINS: "heig-vd.ch",
  });
  db = server.app.db;
  config = loadConfig({ SUPER_ADMIN_EMAIL: "boss@example.org", LOGIN_DOMAINS: "heig-vd.ch" });
  adminId = (await server.signIn("admin", "boss@example.org")).id;
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A login's claims: `raw` as userinfo would release it, the login address verified. */
function login(raw: Record<string, unknown>, opts: { complete?: boolean; sub?: string } = {}): OidcClaims {
  return oidcClaims(opts.sub ?? `s-${randomUUID()}`, raw, true, opts.complete ?? true);
}

/** Someone edu-ID knows and nobody here does: an `affiliate@eduid.ch` and a private mailbox. */
function stranger(email = `x-${randomUUID().slice(0, 8)}@gmail.test`) {
  return login({ email, eduPersonScopedAffiliation: ["affiliate@eduid.ch"], eduPersonAffiliation: ["affiliate"] });
}

async function rosterLine(email: string, userId: string | null = null) {
  const courseId = randomUUID();
  const classroomId = randomUUID();
  await db.insert(courses).values({ id: courseId, name: "PRG1", code: `PRG1-${courseId}` });
  await db.insert(classrooms).values({ id: classroomId, courseId, name: "PRG1-A" });
  await db.insert(enrollments).values({ id: randomUUID(), classroomId, nom: "N", prenom: "P", email, userId });
}

/** A placeholder account of the heig-classroom import, its address verified. */
async function placeholder(email: string) {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: placeholderSub(`cr-${id}`), email });
  await db.insert(userEmails).values({ userId: id, email, source: "login", verified: true });
  return id;
}

describe("loginRefusal (ADR-111)", () => {
  it("asks nothing of the database while LOGIN_DOMAINS is empty", async () => {
    const select = vi.spyOn(db, "select");
    expect(await loginRefusal(db, { ...config, LOGIN_DOMAINS: [] }, stranger())).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("reads the login address only once the IdP verified it", async () => {
    const claims = login({ email: "first.last@heig-vd.ch" });
    expect(await loginRefusal(db, config, claims)).toBeNull();
    expect(await loginRefusal(db, config, { ...claims, emailVerified: false })).toBe("not_invited");
  });

  it("admits an external student a roster line waits for, case-blind", async () => {
    const claims = stranger("ext.student@gmail.test");
    expect(await loginRefusal(db, config, claims)).toBe("not_invited");
    await rosterLine("Ext.Student@gmail.test");
    expect(await loginRefusal(db, config, claims)).toBeNull();
  });

  it("does not count a roster line another account already claimed", async () => {
    const holder = randomUUID();
    await db.insert(users).values({ id: holder, oidcSub: `h-${holder}`, email: "claimed@gmail.test" });
    await rosterLine("claimed@gmail.test", holder);
    expect(await loginRefusal(db, config, stranger("claimed@gmail.test"))).toBe("not_invited");
  });

  it("admits a person an admin granted the teacher role", async () => {
    await db.insert(teacherGrants).values({ id: randomUUID(), email: "guest.teacher@gmail.test", createdBy: adminId });
    expect(await loginRefusal(db, config, stranger("guest.teacher@gmail.test"))).toBeNull();
  });

  it("admits the person a heig-classroom placeholder waits for, and signs them in onto it", async () => {
    const id = await placeholder("imported@school.test");
    const claims = login({ email: "p@gmail.test", swissEduIDLinkedAffiliationMail: ["imported@school.test"] });
    expect(await loginRefusal(db, config, claims)).toBeNull();
    expect((await signIn(db, config, claims)).id).toBe(id);
  });

  it("admits a login two placeholders match, which signIn flags as ambiguous", async () => {
    const candidates = [await placeholder("twice@school.test"), await placeholder("twice@school.test")];
    const claims = login({ email: "q@gmail.test", swissEduIDLinkedAffiliationMail: ["twice@school.test"] });
    expect(await loginRefusal(db, config, claims)).toBeNull();
    const user = await signIn(db, config, claims);
    expect(candidates).not.toContain(user.id);
    const flagged = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "auth.adoption_ambiguous"), eq(auditLog.subjectId, user.id)));
    expect(flagged).toHaveLength(1);
  });

  it("admits an existing account, until it is anonymized", async () => {
    const first = stranger();
    const user = await signIn(db, { ...config, LOGIN_DOMAINS: [] }, first);
    expect(await loginRefusal(db, config, first)).toBeNull();
    await db.update(users).set({ anonymizedAt: new Date() }).where(eq(users.id, user.id));
    expect(await loginRefusal(db, config, first)).toBe("not_invited");
  });

  it("lets the super administrator past the staging allowlist and admission", async () => {
    const staging = { ...config, LOGIN_ALLOWLIST: "dev@heig.test" };
    expect(await loginRefusal(db, staging, login({ email: "boss@example.org" }, { complete: false }))).toBeNull();
  });
});

describe("loginRefusal: the staging allowlist (ADR-028 §3)", () => {
  const staging = () => ({ ...config, LOGIN_DOMAINS: [], LOGIN_ALLOWLIST: "dev@heig.test" });

  it("refuses a listed login address the IdP did not verify", async () => {
    const claims = { ...login({ email: "dev@heig.test" }), emailVerified: false };
    expect(await loginRefusal(db, staging(), claims)).toBe("restricted");
  });

  it("admits a listed address the institution asserts", async () => {
    const claims = login({ email: "x@gmail.test", swissEduIDLinkedAffiliationMail: ["dev@heig.test"] });
    expect(await loginRefusal(db, staging(), { ...claims, emailVerified: false })).toBeNull();
  });
});

describe("the OIDC callback", () => {
  /** Drives the callback with the claims the IdP would have vouched for. */
  async function callback(claims: OidcClaims) {
    vi.spyOn(OidcProvider.prototype, "completeLogin").mockResolvedValue(claims);
    const stash = server.app.signCookie(JSON.stringify({ codeVerifier: "v", state: "s", nonce: "n", returnTo: "/" }));
    return server.app.inject({
      method: "GET",
      url: "/app/auth/callback?code=c&state=s",
      headers: { cookie: `${server.app.cookieName("quiz_login")}=${stash}` },
    });
  }

  /** Everything a sign-in writes about a person: none of it may exist after a refusal. */
  async function traces(sub: string, email: string) {
    const [account] = await db.select({ id: users.id }).from(users).where(eq(users.oidcSub, sub));
    const claims = await db.select().from(userIdpClaims).innerJoin(users, eq(users.id, userIdpClaims.userId)).where(eq(users.oidcSub, sub));
    const addresses = await db.select().from(userEmails).where(eq(userEmails.email, email));
    return { account, claims: claims.length, addresses: addresses.length };
  }

  it("sends a login outside the staging allowlist to the refusal page, writing nothing", async () => {
    const claims = login({ email: "outsider@gmail.test" });
    const res = await callback(claims);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/sign-in/refused?reason=restricted");
    expect(res.headers["set-cookie"]?.toString() ?? "").not.toMatch(/quiz_session=/);
    expect(await traces(claims.sub, "outsider@gmail.test")).toEqual({ account: undefined, claims: 0, addresses: 0 });
  });

  it("refuses an affiliate@eduid.ch alone before any row: no account, no claims", async () => {
    const claims = stranger("stranger@gmail.test");
    const res = await callback(claims);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/sign-in/refused?reason=not_invited");
    expect(await traces(claims.sub, "stranger@gmail.test")).toEqual({ account: undefined, claims: 0, addresses: 0 });
  });

  it("says to retry when userinfo failed for a new person, never for an existing account", async () => {
    const partial = login({ email: "dev@gmail.test" }, { complete: false });
    const res = await callback(partial);
    expect(res.headers.location).toBe("/sign-in/refused?reason=retry");
    expect((await traces(partial.sub, "dev@gmail.test")).account).toBeUndefined();

    await signIn(db, { ...config, LOGIN_DOMAINS: [] }, { ...partial, complete: true });
    const again = await callback(partial);
    expect(again.headers.location).toBe("/");
    expect(again.headers["set-cookie"]?.toString()).toMatch(/quiz_session=/);
  });
});
