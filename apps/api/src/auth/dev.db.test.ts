import type { FastifyInstance } from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { PERSONAS, devSub, upsertPersona } from "./dev.js";
import { userEmails, users } from "../db/schema.js";
import { testApp } from "../test/db.js";

/*
 * The development persona picker writes ordinary accounts through the
 * ordinary identity code: an account born here must be indistinguishable
 * from one born of an OIDC login, or the dev flow would exercise a second
 * code path nobody ships.
 */
const teacher = PERSONAS.find((p) => p.key === "teacher")!;
const student = PERSONAS.find((p) => p.key === "lea")!;

// One database for the file: each test reads back only the persona it
// signed in, so the order of the tests does not matter.
let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
});

describe("upsertPersona", () => {
  it("creates the account, its address set and its role", async () => {
    const user = await upsertPersona(app, teacher);
    expect(user.oidcSub).toBe(devSub(teacher));
    expect(user.role).toBe("teacher");
    expect(user.lastLoginAt).not.toBeNull();
    const addresses = await app.db
      .select()
      .from(userEmails)
      .where(eq(userEmails.userId, user.id));
    // The roster matches on the address SET, so a persona with no row there
    // would never claim its seat.
    expect(addresses.map((a) => a.email)).toEqual([teacher.email]);
    expect(addresses[0]!.verified).toBe(true);
  });

  it("is idempotent: signing in twice keeps one account", async () => {
    const first = await upsertPersona(app, student);
    const accounts = (await app.db.select().from(users)).length;
    const second = await upsertPersona(app, student);
    expect(second.id).toBe(first.id);
    // Not one account more, under any sub.
    expect(await app.db.select().from(users)).toHaveLength(accounts);
    expect(await app.db.select().from(users).where(eq(users.oidcSub, devSub(student)))).toHaveLength(1);
  });

  it("carries the persona's role, with no grant in the database", async () => {
    expect((await upsertPersona(app, student)).role).toBe("student");
    const admin = PERSONAS.find((p) => p.key === "admin")!;
    expect((await upsertPersona(app, admin)).role).toBe("admin");
  });
});
