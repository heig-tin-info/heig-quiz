/**
 * The move of the armed drafts to `scheduled` (`0129_project_scheduled_state`,
 * ADR-127 §5), read from the shipped SQL: the test runs the statements that
 * really run, on the table put back in its old shape. A draft the old ticker
 * would have published (a date, a built distribution, a deadline ahead)
 * becomes `scheduled`, an archived one included; anything else is left as
 * it was, and nobody is marked told.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { defaultProjectGradingScale } from "@quiz/contracts";

import { testDatabase } from "../test/db.js";
import { seedLive } from "../test/live.js";
import { githubOrganizations, projects } from "./schema.js";

const MIGRATION = new URL("../../drizzle/0129_project_scheduled_state.sql", import.meta.url);
const DAY = 24 * 3_600_000;
const ahead = (days: number) => new Date(Date.now() + days * DAY);

let client: PGlite;
const ids = {
  armed: randomUUID(),
  archived: randomUUID(),
  expired: randomUUID(),
  manual: randomUUID(),
  unbuilt: randomUUID(),
  published: randomUUID(),
};

beforeAll(async () => {
  const database = await testDatabase();
  client = database.client;
  const { db } = database;
  const { teacherId, classroomId } = await seedLive(db, { students: 0, questions: 0 });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: "heig-mig", githubOrgId: 901, installationId: 902 });
  const row = (id: string, over: Partial<typeof projects.$inferInsert>) => ({
    id,
    classroomId,
    orgId,
    name: id,
    slug: id,
    startAt: ahead(1),
    deadlineAt: ahead(7),
    sourceRepoId: 1,
    sourceFullName: "heig-mig/lab",
    distributionFullName: "heig-mig/lab-squashed",
    publishMode: "scheduled" as const,
    branches: ["main"],
    protectedFiles: [],
    gradingScale: defaultProjectGradingScale(),
    createdBy: teacherId,
    ...over,
  });
  await db.insert(projects).values([
    row(ids.armed, {}),
    row(ids.archived, { archivedAt: new Date() }),
    row(ids.expired, { startAt: ahead(-7), deadlineAt: ahead(-1) }),
    row(ids.manual, { publishMode: "manual" }),
    row(ids.unbuilt, { distributionFullName: null }),
    row(ids.published, { state: "published" }),
  ]);
  // The table as it was before the migration: no marker, the old index of the scheduled drafts.
  await client.exec(`
    DROP INDEX "projects_scheduled_publish_idx";
    ALTER TABLE "projects" DROP COLUMN "scheduled_announced_at";
    CREATE INDEX "projects_scheduled_publish_idx" ON "projects" USING btree ("start_at")
      WHERE "projects"."state" = 'draft' AND "projects"."publish_mode" = 'scheduled' AND "projects"."archived_at" IS NULL;
  `);
  for (const statement of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) await client.exec(statement);
});

describe("0129_project_scheduled_state", () => {
  it("schedules every armed draft, an archived one included, and leaves the rest as they were", async () => {
    const { rows } = await client.query<{ id: string; state: string; scheduled_announced_at: Date | null }>(
      `SELECT "id", "state", "scheduled_announced_at" FROM "projects"`,
    );
    const stateOf = new Map(rows.map((r) => [r.id, r.state]));
    expect(stateOf.get(ids.armed)).toBe("scheduled");
    expect(stateOf.get(ids.archived)).toBe("scheduled");
    expect(stateOf.get(ids.expired)).toBe("draft");
    expect(stateOf.get(ids.manual)).toBe("draft");
    expect(stateOf.get(ids.unbuilt)).toBe("draft");
    expect(stateOf.get(ids.published)).toBe("published");
    // Nobody was told: the marker stays null.
    expect(rows.every((r) => r.scheduled_announced_at === null)).toBe(true);
  });
});
