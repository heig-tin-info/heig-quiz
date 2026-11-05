/**
 * The audit log is append-only, with a retention of three years (ADR-003 §5,
 * amended 2026-11-05; N-SEC-09): the trigger of migration 0130 refuses every
 * UPDATE, and the DELETE of a row younger than three years by the database's
 * clock, whatever the role, on `audit_log` and `legacy_classroom_audit_log`;
 * the one writer, `audit()`, keeps inserting, and `purgeAuditLog` (the daily
 * `audit.purge`) deletes the older rows of both tables and nothing else.
 */
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { audit, purgeAuditLog, SYSTEM_ACTOR } from "./audit.js";
import type { Db } from "./db/client.js";
import { auditLog, legacyClassroomAuditLog } from "./db/schema.js";
import { testDb } from "./test/db.js";

let db: Db;

beforeAll(async () => {
  db = await testDb();
  await audit(db, { ...SYSTEM_ACTOR, action: "pool.create", subjectType: "pool", subjectId: "p-1" });
});

/** The PostgreSQL error under the driver's wrapper. */
async function refusal(query: Promise<unknown>): Promise<{ code?: string; message: string }> {
  const error: unknown = await query.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  const cause = (error as { cause?: unknown }).cause ?? error;
  return cause as { code?: string; message: string };
}

/** An instant `interval` before the database's now. */
async function ago(interval: string, on: Db = db): Promise<Date> {
  const { rows } = await on.execute<{ ms: string }>(
    sql`SELECT (extract(epoch FROM now() - ${interval}::interval) * 1000)::bigint::text AS ms`,
  );
  return new Date(Number(rows[0]!.ms));
}

/** A row of the imported heig-classroom log, at `createdAt`. */
async function legacyRow(sourceId: number, subjectId: string, createdAt: Date, on: Db = db) {
  await on.insert(legacyClassroomAuditLog).values({
    sourceId,
    actorType: "system",
    action: "classroom.create",
    subjectType: "classroom",
    subjectId,
    createdAt,
  });
}

describe("audit_log immutability (ADR-003 §5)", () => {
  it("inserts through audit()", async () => {
    const rows = await db.select().from(auditLog).where(eq(auditLog.subjectId, "p-1"));
    expect(rows).toHaveLength(1);
  });

  it("refuses an UPDATE", async () => {
    const error = await refusal(db.update(auditLog).set({ action: "pool.delete" }).where(eq(auditLog.subjectId, "p-1")));
    expect(error.code).toBe("42501");
    expect(error.message).toContain("audit_log is append-only: UPDATE refused");
    const [row] = await db.select().from(auditLog).where(eq(auditLog.subjectId, "p-1"));
    expect(row?.action).toBe("pool.create");
  });

  it("refuses an UPDATE of a row past its three years too", async () => {
    await audit(db, { ...SYSTEM_ACTOR, action: "pool.create", subjectType: "pool", subjectId: "p-old-update", at: await ago("4 years") });
    const error = await refusal(db.update(auditLog).set({ payload: null }).where(eq(auditLog.subjectId, "p-old-update")));
    expect(error.code).toBe("42501");
  });

  it("refuses the DELETE of a fresh row", async () => {
    const error = await refusal(db.delete(auditLog).where(eq(auditLog.subjectId, "p-1")));
    expect(error.code).toBe("42501");
    expect(error.message).toContain("audit_log keeps a row three years: DELETE refused");
    expect(await db.select().from(auditLog).where(eq(auditLog.subjectId, "p-1"))).toHaveLength(1);
  });

  it("refuses the DELETE of a row a day short of three years", async () => {
    await audit(db, { ...SYSTEM_ACTOR, action: "pool.create", subjectType: "pool", subjectId: "p-young", at: await ago("3 years -1 days") });
    expect((await refusal(db.delete(auditLog).where(eq(auditLog.subjectId, "p-young")))).code).toBe("42501");
  });

  it("refuses a DELETE that reaches one fresh row among old ones, whole", async () => {
    await audit(db, { ...SYSTEM_ACTOR, action: "pool.create", subjectType: "pool", subjectId: "p-mixed", at: await ago("5 years") });
    await audit(db, { ...SYSTEM_ACTOR, action: "pool.create", subjectType: "pool", subjectId: "p-mixed" });
    expect((await refusal(db.delete(auditLog).where(eq(auditLog.subjectId, "p-mixed")))).code).toBe("42501");
    expect(await db.select().from(auditLog).where(eq(auditLog.subjectId, "p-mixed"))).toHaveLength(2);
  });

  it("still inserts after a refusal", async () => {
    await audit(db, { ...SYSTEM_ACTOR, action: "pool.delete", subjectType: "pool", subjectId: "p-1" });
    expect(await db.select().from(auditLog).where(eq(auditLog.subjectId, "p-1"))).toHaveLength(2);
  });

  it("guards legacy_classroom_audit_log under the same rule", async () => {
    await legacyRow(1, "c-fresh", new Date());
    const update = await refusal(
      db.update(legacyClassroomAuditLog).set({ payload: null }).where(eq(legacyClassroomAuditLog.subjectId, "c-fresh")),
    );
    expect(update.message).toContain("legacy_classroom_audit_log is append-only: UPDATE refused");
    const fresh = await refusal(db.delete(legacyClassroomAuditLog).where(eq(legacyClassroomAuditLog.subjectId, "c-fresh")));
    expect(fresh.code).toBe("42501");
  });
});

describe("audit.purge (ADR-003 §5, N-SEC-09)", () => {
  // A database of its own: what the blocks above left would blur the counts.
  let pdb: Db;

  beforeAll(async () => {
    pdb = await testDb();
    const at = async (interval: string) => ({ at: await ago(interval, pdb) });
    await audit(pdb, { ...SYSTEM_ACTOR, action: "pool.create", subjectType: "pool", subjectId: "kept-new" });
    await audit(pdb, { ...SYSTEM_ACTOR, action: "pool.create", subjectType: "pool", subjectId: "kept-young", ...(await at("3 years -1 days")) });
    await audit(pdb, { ...SYSTEM_ACTOR, action: "pool.create", subjectType: "pool", subjectId: "gone-1", ...(await at("3 years 1 day")) });
    await audit(pdb, { ...SYSTEM_ACTOR, action: "pool.create", subjectType: "pool", subjectId: "gone-2", ...(await at("7 years")) });
    await legacyRow(10, "kept-legacy", await ago("2 years", pdb), pdb);
    await legacyRow(11, "gone-legacy", await ago("4 years", pdb), pdb);
  });

  it("deletes the rows past three years of both tables, and nothing else", async () => {
    expect(await purgeAuditLog(pdb)).toBe(3);
    const left = await pdb.select({ s: auditLog.subjectId }).from(auditLog).orderBy(auditLog.subjectId);
    expect(left.map((r) => r.s)).toEqual(["kept-new", "kept-young"]);
    const legacy = await pdb.select({ s: legacyClassroomAuditLog.subjectId }).from(legacyClassroomAuditLog);
    expect(legacy.map((r) => r.s)).toEqual(["kept-legacy"]);

    // A second pass finds nothing more.
    expect(await purgeAuditLog(pdb)).toBe(0);
  });
});
