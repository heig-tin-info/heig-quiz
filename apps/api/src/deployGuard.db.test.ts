/**
 * The query of deploy.sh's live-evaluation guard (docs/spec/05-architecture.md
 * §5.9), `scripts/live-evaluations.sql`: the very file the VM pipes into psql,
 * run here against the real migrations. What it returns is what refuses a
 * production deploy, so a schema change that breaks it fails here and not on
 * the VM, and each rule of "live" is pinned by one case.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isLiveNow, isTakeHome } from "@quiz/domain";

import type { Db } from "./db/client.js";
import { classrooms, courses, evaluations } from "./db/schema.js";
import { testDatabase } from "./test/db.js";

const QUERY = readFileSync(new URL("../../../scripts/live-evaluations.sql", import.meta.url), "utf8");

let db: Db;
let client: PGlite;
let classroomId: string;

beforeAll(async () => {
  ({ db, client } = await testDatabase());
  const courseId = randomUUID();
  await db.insert(courses).values({ id: courseId, name: "Programmation C", code: "PRG1" });
  classroomId = randomUUID();
  await db.insert(classrooms).values({ id: classroomId, courseId, name: "A", period: "2026-A" });
});

beforeEach(async () => {
  await db.delete(evaluations);
});

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function evaluation(row: {
  title: string;
  state: (typeof evaluations.$inferInsert)["state"];
  mode?: "exam" | "exercise" | "poll";
  lobby?: "skip" | "auto" | "manual";
  opensAt?: Date;
  closesAt?: Date;
  updatedAt?: Date;
}) {
  await db.insert(evaluations).values({
    id: randomUUID(),
    classroomId,
    title: row.title,
    mode: row.mode ?? "exam",
    state: row.state,
    settings: row.lobby ? { lobby: row.lobby } : {},
    gradingScale: {},
    feedbackPolicy: {},
    opensAt: row.opensAt ?? null,
    closesAt: row.closesAt ?? null,
    updatedAt: row.updatedAt ?? new Date(),
  });
}

/** The titles the guard would name, in its order. */
async function live(): Promise<string[]> {
  const result = await client.query<unknown[]>(QUERY, [], { rowMode: "array" });
  return result.rows.map((r) => r[0] as string);
}

describe("the deploy guard's live evaluations", () => {
  it("names an exam in the lobby, running or paused", async () => {
    await evaluation({ title: "lobby", state: "lobby" });
    await evaluation({ title: "running", state: "running" });
    await evaluation({ title: "paused", state: "paused" });
    expect((await live()).sort()).toEqual(["lobby", "paused", "running"]);
  });

  it("ignores every state where nobody is connected", async () => {
    for (const state of ["draft", "closed", "grading", "released"] as const) {
      await evaluation({ title: state, state });
    }
    expect(await live()).toEqual([]);
  });

  it("names a scheduled evaluation opening within 15 minutes, not a later one", async () => {
    await evaluation({ title: "soon", state: "scheduled", opensAt: ago(-10 * 60_000) });
    await evaluation({ title: "later", state: "scheduled", opensAt: ago(-20 * 60_000) });
    expect(await live()).toEqual(["soon"]);
  });

  it("names a scheduled evaluation whose opening just passed, not one 12 hours old", async () => {
    // While the app is down the ticker opens nothing: a past opening time is
    // still about to open, until it is so old that it would block for ever.
    await evaluation({ title: "just passed", state: "scheduled", opensAt: ago(5 * 60_000) });
    await evaluation({ title: "stale", state: "scheduled", opensAt: ago(13 * HOUR) });
    expect(await live()).toEqual(["just passed"]);
  });

  it("ignores a take-home exercise, not an in-class one nor a poll", async () => {
    await evaluation({ title: "take-home", state: "running", mode: "exercise", lobby: "skip" });
    await evaluation({ title: "in class", state: "running", mode: "exercise", lobby: "manual" });
    // No `lobby` stored: the contract's default, `manual`, is in class.
    await evaluation({ title: "default", state: "running", mode: "exercise" });
    await evaluation({ title: "poll", state: "running", mode: "poll" });
    expect((await live()).sort()).toEqual(["default", "in class", "poll"]);
  });

  it("ignores a session left open for more than 12 hours", async () => {
    await evaluation({ title: "forgotten", state: "running", updatedAt: ago(13 * HOUR) });
    await evaluation({ title: "this morning", state: "running", updatedAt: ago(11 * HOUR) });
    expect(await live()).toEqual(["this morning"]);
  });

  it("returns title, state, mode and the two times, in Swiss time", async () => {
    await evaluation({
      title: "Test 1",
      state: "running",
      opensAt: new Date("2026-09-28T06:15:00Z"),
      closesAt: new Date("2026-09-28T08:00:00Z"),
    });
    await evaluation({ title: "No times", state: "lobby" });
    const result = await client.query<unknown[]>(QUERY, [], { rowMode: "array" });
    expect(result.rows).toEqual([
      ["Test 1", "running", "exam", "2026-09-28 08:15", "2026-09-28 10:00"],
      ["No times", "lobby", "exam", "-", "-"],
    ]);
  });

  it("names exactly what `isLiveNow` of @quiz/domain calls live (#190)", async () => {
    // The Activities section groups "Live now" with the TypeScript twin of
    // this query: one definition of live, pinned on every case above at once.
    const cases: Parameters<typeof evaluation>[0][] = [
      { title: "lobby", state: "lobby" },
      { title: "running", state: "running" },
      { title: "paused", state: "paused" },
      { title: "draft", state: "draft" },
      { title: "released", state: "released" },
      { title: "soon", state: "scheduled", opensAt: ago(-10 * 60_000) },
      { title: "later", state: "scheduled", opensAt: ago(-20 * 60_000) },
      { title: "just passed", state: "scheduled", opensAt: ago(5 * 60_000) },
      { title: "stale", state: "scheduled", opensAt: ago(13 * HOUR) },
      { title: "take-home", state: "running", mode: "exercise", lobby: "skip" },
      { title: "in class", state: "running", mode: "exercise", lobby: "manual" },
      { title: "poll", state: "running", mode: "poll" },
      { title: "forgotten", state: "running", updatedAt: ago(13 * HOUR) },
    ];
    for (const row of cases) await evaluation(row);
    const now = new Date();
    const rows = await db.select().from(evaluations);
    const twin = rows
      .filter((r) =>
        isLiveNow(
          {
            state: r.state,
            takeHome: isTakeHome({ mode: r.mode, lobby: (r.settings as { lobby?: string }).lobby }),
            opensAt: r.opensAt,
            updatedAt: r.updatedAt,
          },
          now,
        ),
      )
      .map((r) => r.title);
    expect((await live()).sort()).toEqual(twin.sort());
  });
});
