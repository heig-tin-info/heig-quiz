/**
 * A pseudonymized account stays out (ADR-117 §7): no sign-in is ever
 * written onto its row, and a session that survived it opens nothing. A
 * sign-in on any other account ends its dormancy.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import { users } from "../db/schema.js";
import { testDb } from "../test/db.js";
import { testServer, type TestServer } from "../test/http.js";
import { oidcClaims } from "../test/oidc.js";
import { AnonymizedAccountError, signIn } from "./login.js";

const config = { SUPER_ADMIN_EMAIL: "", STAFF_AFFILIATION_DOMAINS: ["heig-vd.ch"], LOGIN_ALLOWLIST: "" } as unknown as AppConfig;

describe("signIn", () => {
  it("refuses a subject whose account is pseudonymized, and writes nothing on it", async () => {
    const db = await testDb();
    const id = randomUUID();
    const sub = `sub-${id}`;
    await db.insert(users).values({
      id,
      oidcSub: sub,
      email: `anon-${id}@example.invalid`,
      givenName: "Anonymous",
      anonymizedAt: new Date("2026-11-01T00:00:00Z"),
    });
    const [before] = await db.select().from(users).where(eq(users.id, id));
    await expect(signIn(db, config, oidcClaims(sub, { email: "back@heig-vd.ch", given_name: "Back" }, true))).rejects.toBeInstanceOf(
      AnonymizedAccountError,
    );
    expect(await db.select().from(users).where(eq(users.id, id))).toEqual([before]);
  });

  it("ends the dormancy: the notice and the reminder are forgotten", async () => {
    const db = await testDb();
    const sub = `sub-${randomUUID()}`;
    const first = await signIn(db, config, oidcClaims(sub, { email: "dormant@heig-vd.ch" }, true));
    const at = new Date("2026-01-01T00:00:00Z");
    await db.update(users).set({ inactivityNotifiedAt: at, inactivityRemindedAt: at }).where(eq(users.id, first.id));
    const again = await signIn(db, config, oidcClaims(sub, { email: "dormant@heig-vd.ch" }, true));
    expect(again).toMatchObject({ id: first.id, inactivityNotifiedAt: null, inactivityRemindedAt: null });
    // The fact the callback carries once to the page (ADR-117 §5): this sign-in ended a dormancy, no other did.
    expect(first.reactivated).toBe(false);
    expect(again.reactivated).toBe(true);
    expect((await signIn(db, config, oidcClaims(sub, { email: "dormant@heig-vd.ch" }, true))).reactivated).toBe(false);
  });
});

describe("the session of a pseudonymized account", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await testServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("opens nothing: anonymous, its cookie cleared", async () => {
    const student = await server.signIn("student");
    const me = () => server.app.inject({ method: "GET", url: "/app/api/me", headers: student.headers });
    expect((await me()).statusCode).toBe(200);
    await server.app.db.update(users).set({ anonymizedAt: new Date() }).where(eq(users.id, student.id));
    const refused = await me();
    expect(refused.statusCode).toBe(401);
    expect(String(refused.headers["set-cookie"])).toMatch(/quiz_session=;/);
  });
});
