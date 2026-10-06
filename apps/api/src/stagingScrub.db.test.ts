/**
 * What a staging refresh does to production's data once restored
 * (ADR-028, N-SEC-18, M2-06): `scripts/staging-scrub.sql`, the very file
 * `staging-refresh.sh` pipes into psql, run here against the real
 * migrations. A refresh from a dump holding installations leaves no
 * production installation reachable and no project the ticker would drive.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { defaultProjectGradingScale } from "@quiz/contracts";

import type { Db } from "./db/client.js";
import { classrooms, courses, githubOrganizations, projects, sessions, users } from "./db/schema.js";
import { testDatabase } from "./test/db.js";

const SCRUB = readFileSync(new URL("../../../scripts/staging-scrub.sql", import.meta.url), "utf8");
const ARCHIVED = new Date("2026-09-01T08:00:00Z");

let db: Db;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await testDatabase());
});

describe("staging-scrub.sql", () => {
  it("forgets every installation, archives every project, empties the sessions, and is idempotent", async () => {
    const userId = randomUUID();
    await db.insert(users).values({ id: userId, oidcSub: "scrub", email: "t@heig-vd.ch", role: "teacher" });
    await db.insert(sessions).values({ sidHash: "a".repeat(64), userId, expiresAt: new Date(Date.now() + 3_600_000) });
    const courseId = randomUUID();
    await db.insert(courses).values({ id: courseId, name: "Programmation C", code: "PRG1" });
    const classroomId = randomUUID();
    await db.insert(classrooms).values({ id: classroomId, courseId, name: "A", period: "2026-A" });
    const installed = randomUUID();
    const suspended = randomUUID();
    await db.insert(githubOrganizations).values([
      { id: installed, login: "heig-prod", githubOrgId: 1, installationId: 11 },
      { id: suspended, login: "heig-suspended", githubOrgId: 2, installationId: 12, suspendedAt: ARCHIVED },
    ]);
    const project = (slug: string, archivedAt: Date | null) => ({
      id: randomUUID(),
      classroomId,
      orgId: installed,
      name: slug,
      slug,
      state: "published" as const,
      startAt: ARCHIVED,
      deadlineAt: new Date(Date.now() - 60_000),
      sourceRepoId: slug.length,
      sourceFullName: `heig-prod/${slug}`,
      branches: ["main"],
      protectedFiles: [],
      gradingScale: defaultProjectGradingScale(),
      createdBy: userId,
      archivedAt,
    });
    const live = project("live", null);
    const old = project("older", ARCHIVED);
    await db.insert(projects).values([live, old]);

    for (let run = 0; run < 2; run += 1) {
      await client.exec(SCRUB);
      const orgs = await db.select().from(githubOrganizations);
      expect(orgs.map((o) => [o.login, o.installationId, o.suspendedAt])).toEqual(
        expect.arrayContaining([
          ["heig-prod", null, null],
          ["heig-suspended", null, null],
        ]),
      );
      const [liveRow] = await db.select().from(projects).where(eq(projects.id, live.id));
      expect(liveRow!.archivedAt).not.toBeNull();
      const [oldRow] = await db.select().from(projects).where(eq(projects.id, old.id));
      expect(oldRow!.archivedAt).toEqual(ARCHIVED);
      expect(await db.select().from(sessions)).toEqual([]);
    }
  });
});
