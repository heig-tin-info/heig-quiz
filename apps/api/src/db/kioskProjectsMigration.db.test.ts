/**
 * `0135_kiosk_projects` (ADR-089, amendment of 2026-11-15, M6-11b), read
 * from the shipped SQL and run on the three tables put back in their old
 * shape, holding the rows production holds: projects in every mode, an
 * exam's pairings in every state, sessions of every kind. An `online_seb`
 * project keeps SEB as its level; every other row keeps what it had, the
 * new columns null or `any`; then the checks and the foreign keys hold.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { defaultProjectGradingScale } from "@quiz/contracts";

import { createSession, PORTAL } from "../auth/session.js";
import { testDatabase } from "../test/db.js";
import { seedLive } from "../test/live.js";
import { githubOrganizations, kioskDevices, kioskPairings, projects } from "./schema.js";

const MIGRATION = new URL("../../drizzle/0135_kiosk_projects.sql", import.meta.url);
const digest = () => createHash("sha256").update(randomUUID()).digest("hex");

let client: PGlite;
const ids = { free: randomUUID(), online: randomUUID(), exam: randomUUID(), device: randomUUID(), consumed: randomUUID(), pending: randomUUID() };

beforeAll(async () => {
  const database = await testDatabase();
  client = database.client;
  const { db } = database;
  const { teacherId, classroomId, evaluationId, studentIds } = await seedLive(db, { students: 1, questions: 0 });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: "heig-kmig", githubOrgId: 911, installationId: 912 });
  const row = (id: string, workMode: "free" | "online") => ({
    id,
    classroomId,
    orgId,
    name: id,
    slug: id,
    startAt: new Date(),
    deadlineAt: new Date(Date.now() + 7 * 86_400_000),
    sourceRepoId: 1,
    sourceFullName: "heig-kmig/lab",
    branches: ["main"],
    protectedFiles: [],
    gradingScale: defaultProjectGradingScale(),
    createdBy: teacherId,
    workMode,
  });
  await db.insert(projects).values([row(ids.free, "free"), row(ids.online, "online"), row(ids.exam, "online")]);
  await db.insert(kioskDevices).values({ id: ids.device, googleDeviceId: `g-${ids.device}`, label: "Poste n° 1", status: "active" });
  const expiresAt = new Date(Date.now() + 300_000);
  const pairing = { deviceId: ids.device, deviceCodeHash: digest(), userCodeHash: digest(), expiresAt };
  await db.insert(kioskPairings).values([
    { ...pairing, id: ids.consumed, state: "consumed", userId: studentIds[0]!, evaluationId, consumedAt: new Date() },
    { ...pairing, id: ids.pending, deviceCodeHash: digest(), state: "pending" },
  ]);
  await createSession(db, studentIds[0]!, 8, PORTAL);
  await createSession(db, studentIds[0]!, 8, { kind: "kiosk", actorUserId: null, evaluationId, projectId: null, deviceId: ids.device });

  // The three tables as they were before the migration; one project under Safe Exam Browser (M6-07).
  await client.exec(`
    ALTER TABLE "projects" DROP CONSTRAINT "projects_devices_supervised";
    ALTER TABLE "kiosk_pairings" DROP CONSTRAINT "kiosk_pairings_one_activity";
    ALTER TABLE "sessions" DROP COLUMN "kiosk_pairing_id";
    ALTER TABLE "projects" DROP COLUMN "devices";
    ALTER TABLE "kiosk_pairings" DROP COLUMN "project_id";
    ALTER TABLE "kiosk_pairings" DROP COLUMN "close_completed_at";
    UPDATE "projects" SET "work_mode" = 'online_seb' WHERE "id" = '${ids.exam}';
  `);
  for (const statement of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) await client.exec(statement);
});

describe("0135_kiosk_projects", () => {
  it("keeps SEB for an online_seb project and `any` for the others, with no backfill elsewhere", async () => {
    const { rows } = await client.query<{ id: string; devices: string }>(`SELECT "id", "devices" FROM "projects"`);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.devices]))).toEqual({ [ids.free]: "any", [ids.online]: "any", [ids.exam]: "seb" });
    const pairings = await client.query<{ project_id: string | null; close_completed_at: Date | null }>(
      `SELECT "project_id", "close_completed_at" FROM "kiosk_pairings"`,
    );
    expect(pairings.rows).toHaveLength(2);
    expect(pairings.rows.every((p) => p.project_id === null && p.close_completed_at === null)).toBe(true);
    const sessions = await client.query<{ kiosk_pairing_id: string | null }>(`SELECT "kiosk_pairing_id" FROM "sessions"`);
    expect(sessions.rows).toHaveLength(2);
    expect(sessions.rows.every((s) => s.kiosk_pairing_id === null)).toBe(true);
  });

  it("then ties `any` to the unsupervised modes, one activity per pairing, and a deleted project to no pairing", async () => {
    await expect(client.exec(`UPDATE "projects" SET "devices" = 'any' WHERE "id" = '${ids.exam}'`)).rejects.toThrow(/projects_devices_supervised/);
    await expect(client.exec(`UPDATE "projects" SET "devices" = 'kiosk' WHERE "id" = '${ids.online}'`)).rejects.toThrow(/projects_devices_supervised/);
    await client.exec(`UPDATE "projects" SET "devices" = 'kiosk' WHERE "id" = '${ids.exam}'`);
    await expect(client.exec(`UPDATE "kiosk_pairings" SET "project_id" = '${ids.exam}' WHERE "id" = '${ids.consumed}'`)).rejects.toThrow(
      /kiosk_pairings_one_activity/,
    );
    await client.exec(`UPDATE "kiosk_pairings" SET "project_id" = '${ids.exam}' WHERE "id" = '${ids.pending}'`);
    await client.exec(`DELETE FROM "projects" WHERE "id" = '${ids.exam}'`);
    const { rows } = await client.query<{ project_id: string | null }>(`SELECT "project_id" FROM "kiosk_pairings" WHERE "id" = '${ids.pending}'`);
    expect(rows).toEqual([{ project_id: null }]);
  });
});
