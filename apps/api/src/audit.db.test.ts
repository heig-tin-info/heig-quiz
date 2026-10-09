/**
 * The audit log is append-only (ADR-003 §5): the trigger of migration 0096
 * refuses UPDATE and DELETE on `audit_log`, whatever the role, while the one
 * writer, `audit()`, keeps inserting.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { audit, SYSTEM_ACTOR } from "./audit.js";
import type { Db } from "./db/client.js";
import { auditLog } from "./db/schema.js";
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

describe("audit_log immutability (ADR-003 §5)", () => {
  it("inserts through audit()", async () => {
    const rows = await db.select().from(auditLog).where(eq(auditLog.subjectId, "p-1"));
    expect(rows).toHaveLength(1);
  });

  it("refuses an UPDATE", async () => {
    const error = await refusal(db.update(auditLog).set({ action: "pool.delete" }).where(eq(auditLog.subjectId, "p-1")));
    expect(error.code).toBe("42501");
    expect(error.message).toContain("append-only: UPDATE refused");
    const [row] = await db.select().from(auditLog).where(eq(auditLog.subjectId, "p-1"));
    expect(row?.action).toBe("pool.create");
  });

  it("refuses a DELETE, even of no row", async () => {
    expect((await refusal(db.delete(auditLog).where(eq(auditLog.subjectId, "p-1")))).message).toContain(
      "append-only: DELETE refused",
    );
    expect((await refusal(db.delete(auditLog).where(eq(auditLog.subjectId, "none")))).code).toBe("42501");
    expect(await db.select().from(auditLog).where(eq(auditLog.subjectId, "p-1"))).toHaveLength(1);
  });

  it("still inserts after a refusal", async () => {
    await audit(db, { ...SYSTEM_ACTOR, action: "pool.delete", subjectType: "pool", subjectId: "p-1" });
    expect(await db.select().from(auditLog).where(eq(auditLog.subjectId, "p-1"))).toHaveLength(2);
  });
});
