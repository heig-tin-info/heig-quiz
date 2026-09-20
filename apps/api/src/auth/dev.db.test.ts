import { describe, expect, it } from "vitest";
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

describe("upsertPersona", () => {
  it("creates the account, its address set and its role", async () => {
    const app = await testApp();
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
    const app = await testApp();
    const first = await upsertPersona(app, student);
    const second = await upsertPersona(app, student);
    expect(second.id).toBe(first.id);
    expect(await app.db.select().from(users)).toHaveLength(1);
  });

  it("carries the persona's role, with no grant in the database", async () => {
    const app = await testApp();
    expect((await upsertPersona(app, student)).role).toBe("student");
    const admin = PERSONAS.find((p) => p.key === "admin")!;
    expect((await upsertPersona(app, admin)).role).toBe("admin");
  });
});
