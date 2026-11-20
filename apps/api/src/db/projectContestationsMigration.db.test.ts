/**
 * The backfill of `0149_project_contestations` (ADR-139 §13, decision 8),
 * read from the shipped SQL: its last statement, run on projects released
 * before contestations shipped. A project graded by criteria gets seven days
 * from its FIRST release — the earliest `project.release` audit row, since
 * every release rewrites `released_at` — so one first released long ago and
 * released again this week stays closed; one with no audit row falls back on
 * `released_at`; a project in another mode, or not released, gets nothing.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { defaultProjectGradingScale } from "@quiz/contracts";

import { testDatabase } from "../test/db.js";
import { seedLive } from "../test/live.js";
import { auditLog, githubOrganizations, projects } from "./schema.js";

const MIGRATION = new URL("../../drizzle/0149_project_contestations.sql", import.meta.url);
const DAY = 24 * 3_600_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

let client: PGlite;
const ids = { rereleased: randomUUID(), fresh: randomUUID(), unaudited: randomUUID(), auto: randomUUID(), unreleased: randomUUID() };

beforeAll(async () => {
  const database = await testDatabase();
  client = database.client;
  const { db } = database;
  const { teacherId, classroomId } = await seedLive(db, { students: 0, questions: 0 });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: "heig-mig", githubOrgId: 903, installationId: 904 });
  const row = (id: string, over: Partial<typeof projects.$inferInsert>) => ({
    id,
    classroomId,
    orgId,
    name: id,
    slug: id,
    state: "locked" as const,
    startAt: ago(90),
    deadlineAt: ago(80),
    sourceRepoId: 1,
    sourceFullName: "heig-mig/lab",
    branches: ["main"],
    protectedFiles: [],
    gradingMode: "criteria" as const,
    gradingScale: defaultProjectGradingScale(),
    createdBy: teacherId,
    ...over,
  });
  await db.insert(projects).values([
    row(ids.rereleased, { releasedAt: ago(1) }),
    row(ids.fresh, { releasedAt: ago(1) }),
    row(ids.unaudited, { releasedAt: ago(2) }),
    row(ids.auto, { gradingMode: "auto", releasedAt: ago(1) }),
    row(ids.unreleased, {}),
  ]);
  const release = (projectId: string, at: Date, first: boolean) => ({
    actorUserId: teacherId,
    actorType: "user" as const,
    action: "project.release",
    subjectType: "project",
    subjectId: projectId,
    payload: { first, repos: 1, scored: 1 },
    createdAt: at,
  });
  // First released 60 days ago, released again yesterday; the fresh one released yesterday only.
  await db.insert(auditLog).values([release(ids.rereleased, ago(60), true), release(ids.rereleased, ago(1), false), release(ids.fresh, ago(1), true)]);
  // The backfill alone, as shipped: the last statement of the migration.
  const statements = readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint");
  await client.exec(statements.at(-1)!);
});

describe("0149_project_contestations' backfill", () => {
  it("opens seven days from the first release, never from a release again, and touches nothing else", async () => {
    const { rows } = await client.query<{ id: string; contestation_closes_at: Date | null; released_at: Date | null }>(
      `SELECT "id", "contestation_closes_at", "released_at" FROM "projects"`,
    );
    const closes = new Map(rows.map((r) => [r.id, r.contestation_closes_at?.getTime() ?? null]));
    const near = (actual: number | null | undefined, expected: Date) => expect(Math.abs(actual! - expected.getTime())).toBeLessThan(60_000);
    // 60 days ago + 7: closed already, whatever yesterday's release.
    near(closes.get(ids.rereleased), ago(53));
    expect(closes.get(ids.rereleased)!).toBeLessThan(Date.now());
    near(closes.get(ids.fresh), ago(-6));
    expect(closes.get(ids.fresh)!).toBeGreaterThan(Date.now());
    // No audit row kept: `released_at`.
    near(closes.get(ids.unaudited), ago(-5));
    expect(closes.get(ids.auto)).toBeNull();
    expect(closes.get(ids.unreleased)).toBeNull();
  });
});
