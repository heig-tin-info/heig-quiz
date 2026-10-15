/**
 * The backfill of a token's scope (`0116_api_token_scope`, ADR-113 §6), read
 * from the shipped SQL: the test runs the statements that really run, on the
 * table put back in its old shape. Every personal token issued before the
 * scopes becomes an explicit `api`; an OAuth access token and a help-assistant
 * token are never touched and stay without one.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { testDatabase } from "../test/db.js";
import { seedLive } from "../test/live.js";

const MIGRATION = new URL("../../drizzle/0116_api_token_scope.sql", import.meta.url);

let client: PGlite;
const ids = { personal: randomUUID(), endless: randomUUID(), oauth: randomUUID(), assist: randomUUID() };

async function insert(id: string, userId: string, extra: { expiresAt?: string | null; grantId?: string; audience?: string }) {
  await client.query(
    `INSERT INTO "api_tokens" ("id", "user_id", "name", "token_hash", "prefix", "expires_at", "grant_id", "audience")
     VALUES ($1, $2, 'old', $3, 'quiz_pat_old', $4, $5, $6)`,
    [id, userId, randomUUID().replaceAll("-", "").padEnd(64, "0"), extra.expiresAt ?? null, extra.grantId ?? null, extra.audience ?? null],
  );
}

beforeAll(async () => {
  const database = await testDatabase();
  client = database.client;
  const { teacherId } = await seedLive(database.db, { students: 0, questions: 0 });
  // The table as it was before the migration: no scope, no CHECK.
  await client.exec(`
    ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_scope_personal_ck";
    ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_scope_ck";
    ALTER TABLE "api_tokens" DROP COLUMN "scope";
  `);
  const grantId = randomUUID();
  await client.query(`INSERT INTO "oauth_clients" ("id", "kind", "name", "redirect_uris") VALUES ('c1', 'dcr', 'Host', ARRAY['https://h.test/cb'])`);
  await client.query(
    `INSERT INTO "oauth_grants" ("id", "user_id", "client_id", "scope", "resource", "refresh_hash", "expires_at")
     VALUES ($1, $2, 'c1', 'quiz offline_access', 'https://quiz.test/app/api/mcp', $3, now() + interval '90 days')`,
    [grantId, teacherId, "f".repeat(64)],
  );
  await insert(ids.personal, teacherId, { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  await insert(ids.endless, teacherId, {});
  await insert(ids.oauth, teacherId, { grantId, audience: "https://quiz.test/app/api/mcp" });
  await insert(ids.assist, teacherId, { audience: "urn:quiz:assist" });
  for (const statement of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) await client.exec(statement);
});

describe("0116_api_token_scope", () => {
  it("makes every personal token an explicit api, endless ones included, and touches no other", async () => {
    const { rows } = await client.query<{ id: string; scope: string | null; expires_at: Date | null }>(
      `SELECT "id", "scope", "expires_at" FROM "api_tokens"`,
    );
    const scopeOf = new Map(rows.map((r) => [r.id, r.scope]));
    expect(scopeOf.get(ids.personal)).toBe("api");
    expect(scopeOf.get(ids.endless)).toBe("api");
    expect(scopeOf.get(ids.oauth)).toBeNull();
    expect(scopeOf.get(ids.assist)).toBeNull();
    // The lifetime of an existing token is left as it was: no forced sunset.
    expect(rows.find((r) => r.id === ids.endless)!.expires_at).toBeNull();
  });
});
