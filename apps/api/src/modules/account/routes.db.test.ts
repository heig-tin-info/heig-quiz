/**
 * The two doors to a pseudonymization a person reaches (ADR-117 §5, §6),
 * over the real application: the student's own, from their own portal
 * session only; the administrator's, Super Powers on, on any account. What
 * the wipe itself does (every refusal, the pool succession):
 * `service.db.test.ts`; the administration's inactive list:
 * `admin/routes.db.test.ts`.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SELF_PSEUDONYMIZE_PATH, adminPseudonymizePath } from "@quiz/contracts";

import { createApiToken } from "../../auth/tokens.js";
import { auditLog, users } from "../../db/schema.js";
import { sessionOf, testServer, type TestServer } from "../../test/http.js";
import { kioskStation } from "../../test/kiosk.js";
import { seedLive } from "../../test/live.js";

let server: TestServer;

beforeAll(async () => {
  server = await testServer();
});

afterAll(async () => {
  await server.close();
});

const db = () => server.app.db;
const post = (url: string, headers: Record<string, string>) => server.app.inject({ method: "POST", url, headers });
const anonymizedAt = async (id: string) =>
  (await db().select({ at: users.anonymizedAt }).from(users).where(eq(users.id, id)))[0]!.at;
const auditOf = async (id: string) =>
  (await db().select().from(auditLog).where(and(eq(auditLog.action, "user.anonymized"), eq(auditLog.subjectId, id))))[0];

describe(`POST ${SELF_PSEUDONYMIZE_PATH}`, () => {
  it("pseudonymizes a student's own account, ends the session and clears its cookies", async () => {
    const student = await server.signIn("student");
    const res = await post(SELF_PSEUDONYMIZE_PATH, student.headers);
    expect(res.statusCode).toBe(204);
    expect(String(res.headers["set-cookie"])).toMatch(/quiz_session=;/);
    expect(await anonymizedAt(student.id)).not.toBeNull();
    // The session is gone with the identity.
    expect((await server.app.inject({ method: "GET", url: "/app/api/me", headers: student.headers })).statusCode).toBe(401);
    expect(await auditOf(student.id)).toMatchObject({ actorUserId: student.id, payload: { userId: student.id, by: "self" } });
  });

  it("refuses an impersonation, a seb or kiosk session and an API token, and leaves the account as it was", async () => {
    const seed = await seedLive(db(), { students: 1, questions: 0 });
    const [student] = seed.studentIds as [string];
    const admin = await server.signIn("admin");
    const impersonation = await sessionOf(db(), student, { kind: "impersonation", actorUserId: admin.id });
    expect((await post(SELF_PSEUDONYMIZE_PATH, impersonation)).statusCode).toBe(403);
    const seb = await sessionOf(db(), student, { kind: "seb", evaluationId: seed.evaluationId });
    expect([401, 403]).toContain((await post(SELF_PSEUDONYMIZE_PATH, seb)).statusCode);
    const station = await kioskStation(server.app);
    const kiosk = await sessionOf(db(), student, { kind: "kiosk", evaluationId: seed.evaluationId, deviceId: station.deviceId });
    expect([401, 403]).toContain((await post(SELF_PSEUDONYMIZE_PATH, { ...kiosk, cookie: `${kiosk.cookie}; ${station.cookie}` })).statusCode);
    const { token } = await createApiToken(db(), student, { name: "t", expiresInDays: 30, scope: "api" }, server.clock.now());
    expect([401, 403]).toContain((await post(SELF_PSEUDONYMIZE_PATH, { authorization: `Bearer ${token}` })).statusCode);
    expect(await anonymizedAt(student)).toBeNull();
  });

  it("answers a refusal with its contract code: a staff account is the administrator's", async () => {
    // Staff by a course seat: the role rule's, never the stored role alone.
    const course = await seedLive(db(), { students: 0, questions: 0 });
    const res = await post(SELF_PSEUDONYMIZE_PATH, await sessionOf(db(), course.teacherId, { kind: "portal" }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "staff" });
    expect(await anonymizedAt(course.teacherId)).toBeNull();
  });
});

describe("POST /app/api/admin/users/:id/pseudonymize", () => {
  it("is an administrator's, with Super Powers on", async () => {
    const target = await server.signIn("student");
    const teacher = await server.signIn("teacher");
    expect((await post(adminPseudonymizePath(target.id), teacher.headers)).statusCode).toBe(403);
    const admin = await server.signIn("admin");
    const off = await post(adminPseudonymizePath(target.id), admin.headers);
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ error: "super_powers_required" });
    expect(await anonymizedAt(target.id)).toBeNull();
  });

  it("pseudonymizes a staff account the person could not", async () => {
    const seed = await seedLive(db(), { students: 0, questions: 0 });
    const admin = await server.signInWithSuperPowers();
    expect((await post(adminPseudonymizePath(seed.teacherId), admin.headers)).statusCode).toBe(204);
    expect(await anonymizedAt(seed.teacherId)).not.toBeNull();
    expect(await auditOf(seed.teacherId)).toMatchObject({ actorUserId: admin.id, payload: { by: "admin" } });
  });

  it("answers a missing account, and the administrator's own, as missing", async () => {
    const admin = await server.signInWithSuperPowers();
    expect((await post(adminPseudonymizePath(randomUUID()), admin.headers)).statusCode).toBe(404);
    expect((await post(adminPseudonymizePath(admin.id), admin.headers)).statusCode).toBe(404);
    expect((await post(adminPseudonymizePath("not-a-uuid"), admin.headers)).statusCode).toBe(404);
    expect(await anonymizedAt(admin.id)).toBeNull();
  });
});
