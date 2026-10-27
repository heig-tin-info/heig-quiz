/**
 * The removal of the `score_is_grade` scale (`0120_score_is_grade_linear`,
 * ADR-119 §11, L-06b), read from the shipped SQL: the rows are written while
 * the table still has its new column, the column is dropped to put
 * `project_repos` back in its old shape, and the migration's statements run
 * as they really run.
 *
 * What it pins: every grade a student was given or would be given stays the
 * same — the release's (stored, then read rather than recomputed) and the
 * live final score's — whatever the source of the score (a run, the review,
 * a teacher's with or without its own maximum), its maximum (6, or another
 * one the preset already read linearly) and the project's rounding; the
 * scores out of 6 (the staff's gradebook marks included) become points out
 * of 5, the scale linear, and each migrated project gets one
 * `project.scale_migrated` entry. A linear project keeps its scores, and its
 * released grades are stored too: editing its rounding afterwards moves
 * none of them.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { clamp, gradeFromPoints, projectGrade, roundToTenth, type Rounding } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import {
  auditLog,
  enrollments,
  githubOrganizations,
  gradebookColumns,
  gradebookMarks,
  projectGradeRuns,
  projectRepos,
  projects,
} from "../../db/schema.js";
import { testDatabase } from "../../test/db.js";
import { seedLive } from "../../test/live.js";
import { projectLiveScores, projectReleasedScore } from "./gradebook.js";
import type { ProjectRow } from "./views.js";

const MIGRATION = new URL("../../../drizzle/0120_score_is_grade_linear.sql", import.meta.url);
const DEADLINE = new Date("2026-10-09T22:00:00Z");

/** What the removed preset gave a score: a score out of 6 IS the grade, any other maximum linear. */
const presetGrade = (points: number, max: number, rounding: Rounding) =>
  max === 6 ? clamp(roundToTenth(points, rounding), 1, 6) : gradeFromPoints(points, max, { rounding });

let db: Db;
let client: PGlite;
let classroomId: string;
let teacherId: string;
let seats: { enrollmentId: string; userId: string }[];
let nextOrg = 81_000;

/** A locked, graded project; `kind` its scale, released or not. */
async function project(kind: "score_is_grade" | "linear", rounding: Rounding, released: boolean): Promise<string> {
  const n = nextOrg++;
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: `sm-org-${n}`, githubOrgId: n, installationId: n });
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    classroomId,
    orgId,
    name: `Lab ${n}`,
    slug: `sm-${n}`,
    state: "locked",
    startAt: new Date("2026-10-01T08:00:00Z"),
    deadlineAt: DEADLINE,
    deadlineAppliedAt: DEADLINE,
    sourceRepoId: n,
    sourceFullName: `sm-org-${n}/starter`,
    distributionRepoId: n + 1,
    distributionFullName: `sm-org-${n}/dist`,
    branches: ["main"],
    protectedFiles: [],
    gradingMode: "auto",
    // The removed kind, as production stored it.
    gradingScale: { kind, rounding } as never,
    createdBy: teacherId,
    ...(released ? { releasedAt: new Date("2026-10-10T08:00:00Z"), releasedBy: teacherId } : {}),
  });
  return id;
}

interface RunSpec {
  points: number | null;
  max: number | null;
  kind?: "ci" | "review";
  parseStatus?: "ok" | "malformed";
}

/** A repository of seat `seat`, frozen for good, with its slot runs and teacher's score; returns its run ids too. */
async function repo(
  projectId: string,
  seat: number,
  s: { current?: RunSpec; frozen?: RunSpec; review?: RunSpec; teacher?: { points: number; max: number | null } },
): Promise<{ id: string; runs: string[] }> {
  const id = randomUUID();
  const runs: string[] = [];
  const runOf = async (spec: RunSpec | undefined) => {
    if (!spec) return null;
    const runId = randomUUID();
    await db.insert(projectGradeRuns).values({
      id: runId,
      repoId: id,
      workflowRunId: Math.floor(Math.random() * 1e9),
      headBranch: "main",
      headSha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
      conclusion: "success",
      points: spec.points,
      max: spec.max,
      kind: spec.kind ?? "ci",
      parseStatus: spec.parseStatus ?? "ok",
      completedAt: new Date("2026-10-09T20:00:00Z"),
    });
    runs.push(runId);
    return runId;
  };
  const n = nextOrg++;
  await db.insert(projectRepos).values({
    id,
    projectId,
    userId: seats[seat]!.userId,
    githubRepoId: n,
    fullName: `sm/lab-${n}`,
    defaultBranch: "main",
    provisionStatus: "ok",
    acceptedAt: new Date("2026-10-01T09:00:00Z"),
    invitationStatus: "accepted",
    deadlineAppliedAt: DEADLINE,
    frozenAt: new Date("2026-10-09T22:30:00Z"),
    teacherPoints: s.teacher?.points ?? null,
    teacherMax: s.teacher?.max ?? null,
  });
  await db
    .update(projectRepos)
    .set({ currentGradeRunId: await runOf(s.current), frozenGradeRunId: await runOf(s.frozen), reviewGradeRunId: await runOf(s.review) })
    .where(eq(projectRepos.id, id));
  return { id, runs };
}

/** The release's snapshot, as `releaseProject` writes it: the live final score. */
async function snapshot(projectId: string): Promise<void> {
  const row = await projectRow(projectId);
  const live = await projectLiveScores(db, row, seats.map((s) => s.enrollmentId));
  for (const [enrollmentId, cell] of live) {
    const userId = seats.find((s) => s.enrollmentId === enrollmentId)!.userId;
    await db
      .update(projectRepos)
      .set({ releasedPoints: cell.points, releasedMax: cell.max })
      .where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.userId, userId)));
  }
}

const projectRow = async (id: string): Promise<ProjectRow> => (await db.select().from(projects).where(eq(projects.id, id)))[0]!;

/**
 * Every grade of the project by seat, the live final's and the release's:
 * with `oracle`, the scores (the live final, the release's snapshot) read by
 * it — before the migration, no grade is stored yet; without, as the readers
 * give them.
 */
async function grades(projectId: string, oracle?: (points: number, max: number) => number) {
  const row = await projectRow(projectId);
  const live = await projectLiveScores(db, row, seats.map((s) => s.enrollmentId));
  const repos = await db.select().from(projectRepos).where(eq(projectRepos.projectId, projectId));
  const out: Record<string, { live: number | null; released: number | null }> = {};
  for (const [i, seat] of seats.entries()) {
    const cell = live.get(seat.enrollmentId);
    if (oracle) {
      const r = repos.find((x) => x.userId === seat.userId);
      const snap = row.releasedAt !== null && r?.releasedPoints != null && r.releasedMax != null ? oracle(r.releasedPoints, r.releasedMax) : null;
      out[i] = { live: cell ? oracle(cell.points, cell.max) : null, released: snap };
    } else {
      out[i] = { live: cell?.grade ?? null, released: (await projectReleasedScore(db, row, seat.enrollmentId))?.grade ?? null };
    }
  }
  return out;
}

let released: string;
let unreleased: string;
let control: string;
let before: Record<string, Record<string, { live: number | null; released: number | null }>>;
let runIds: Record<string, string[]>;
let runsBefore: Map<string, { points: number | null; max: number | null }>;
let marks: Record<string, string>;

/** A staff `score` mark on the project's gradebook column, for seat `seat`. */
async function mark(projectId: string, seat: number, points: number, max: number): Promise<string> {
  const columnId = randomUUID();
  await db.insert(gradebookColumns).values({ id: columnId, classroomId, projectId, counts: true, updatedAt: new Date() });
  const id = randomUUID();
  await db.insert(gradebookMarks).values({ id, classroomId, columnId, enrollmentId: seats[seat]!.enrollmentId, kind: "score", points, max, setAt: new Date() });
  return id;
}

beforeAll(async () => {
  ({ db, client } = await testDatabase());
  const seeded = await seedLive(db, { students: 6, questions: 0 });
  classroomId = seeded.classroomId;
  teacherId = seeded.teacherId;
  seats = (await db.select().from(enrollments).where(eq(enrollments.classroomId, classroomId)))
    .filter((e) => e.userId !== null && !e.staff)
    .map((e) => ({ enrollmentId: e.id, userId: e.userId! }));
  expect(seats).toHaveLength(6);

  // Released, rounded to the nearest: a mark on a half tenth, a teacher's
  // mark without its own maximum (read against the review's 6), a review
  // out of 20 (already linear), a mark above 6, a teacher's mark with its
  // maximum, and a malformed current run under a scored frozen one.
  released = await project("score_is_grade", "nearest", true);
  const r0 = await repo(released, 0, { current: { points: 4.35, max: 6 } });
  const r1 = await repo(released, 1, { current: { points: 2, max: 6 }, review: { points: 3, max: 6, kind: "review" }, teacher: { points: 5.5, max: null } });
  const r2 = await repo(released, 2, { current: { points: 4, max: 6 }, review: { points: 17, max: 20, kind: "review" } });
  const r3 = await repo(released, 3, { current: { points: 7, max: 6 } });
  const r4 = await repo(released, 4, { current: { points: 1, max: 6 }, teacher: { points: 2.25, max: 6 } });
  const r5 = await repo(released, 5, { current: { points: null, max: null, parseStatus: "malformed" }, frozen: { points: 0.4, max: 6 } });
  await snapshot(released);

  // Unreleased, rounded down: a mark, a teacher's mark, a frozen score out of 20.
  unreleased = await project("score_is_grade", "down", false);
  const u0 = await repo(unreleased, 0, { current: { points: 4.86, max: 6 } });
  const u1 = await repo(unreleased, 1, { current: { points: 5, max: 6 }, teacher: { points: 3.33, max: 6 } });
  const u2 = await repo(unreleased, 2, { current: { points: 5, max: 6 }, frozen: { points: 12, max: 20 } });

  // Linear already: nothing moves, no audit entry.
  control = await project("linear", "up", true);
  const c0 = await repo(control, 0, { current: { points: 4.5, max: 6 } });
  await snapshot(control);

  // A staff mark out of 6 in each project's gradebook column (ADR-074).
  marks = { unreleased: await mark(unreleased, 3, 4.5, 6), control: await mark(control, 3, 4.5, 6) };

  runIds = { released: [r0, r1, r2, r3, r4, r5].flatMap((r) => r.runs), unreleased: [u0, u1, u2].flatMap((r) => r.runs), control: c0.runs };
  runsBefore = new Map((await db.select().from(projectGradeRuns)).map((r) => [r.id, { points: r.points, max: r.max }]));

  // What the removed preset gave (the linear scale for the control), from the scores before the migration.
  before = {
    released: await grades(released, (p, m) => presetGrade(p, m, "nearest")),
    unreleased: await grades(unreleased, (p, m) => presetGrade(p, m, "down")),
    control: await grades(control, (p, m) => gradeFromPoints(p, m, { rounding: "up" })),
  };

  await client.exec(`ALTER TABLE "project_repos" DROP COLUMN "released_grade";`);
  for (const statement of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) await client.exec(statement);
});

const after = (projectId: string) => grades(projectId);

describe("0120_score_is_grade_linear (ADR-119 §11)", () => {
  it("keeps every grade of a released project, the release's stored", async () => {
    expect(before.released).toEqual({
      0: { live: 4.4, released: 4.4 },
      1: { live: 5.5, released: 5.5 },
      2: { live: 5.3, released: 5.3 },
      3: { live: 6, released: 6 },
      4: { live: 2.3, released: 2.3 },
      5: { live: 1, released: 1 },
    });
    expect(await after(released)).toEqual(before.released);
    const repos = await db.select().from(projectRepos).where(eq(projectRepos.projectId, released));
    const bySeat = (i: number) => repos.find((r) => r.userId === seats[i]!.userId)!;
    expect([0, 1, 2, 3, 4, 5].map((i) => bySeat(i).releasedGrade)).toEqual([4.4, 5.5, 5.3, 6, 2.3, 1]);
    // The scores as points: (g − 1) out of 5, clamped; a score out of 20 unchanged.
    expect(bySeat(0)).toMatchObject({ releasedMax: 5 });
    expect(bySeat(0).releasedPoints).toBeCloseTo(3.35, 9);
    expect(bySeat(1)).toMatchObject({ teacherPoints: 4.5, teacherMax: 5, releasedPoints: 4.5, releasedMax: 5 });
    expect(bySeat(2)).toMatchObject({ releasedPoints: 17, releasedMax: 20, teacherPoints: null, teacherMax: null });
    expect(bySeat(3)).toMatchObject({ releasedPoints: 5, releasedMax: 5 });
    expect(bySeat(4)).toMatchObject({ teacherPoints: 1.25, teacherMax: 5, releasedPoints: 1.25, releasedMax: 5 });
    expect(bySeat(5)).toMatchObject({ releasedPoints: 0, releasedMax: 5 });
  });

  it("keeps every grade of an unreleased project, by its rounding", async () => {
    expect(before.unreleased).toEqual({
      0: { live: 4.8, released: null },
      1: { live: 3.3, released: null },
      2: { live: 4, released: null },
      3: { live: null, released: null },
      4: { live: null, released: null },
      5: { live: null, released: null },
    });
    expect(await after(unreleased)).toEqual(before.unreleased);
    const repos = await db.select().from(projectRepos).where(eq(projectRepos.projectId, unreleased));
    expect(repos.every((r) => r.releasedGrade === null && r.releasedPoints === null)).toBe(true);
  });

  it("converts every run out of 6 of the migrated projects, and no other", async () => {
    const runs = new Map((await db.select().from(projectGradeRuns)).map((r) => [r.id, r]));
    for (const id of [...runIds.released!, ...runIds.unreleased!]) {
      const was = runsBefore.get(id)!;
      const now = runs.get(id)!;
      if (was.max === 6) {
        expect(now.max).toBe(5);
        expect(now.points).toBeCloseTo(clamp(was.points! - 1, 0, 5), 9);
      } else {
        expect({ points: now.points, max: now.max }).toEqual(was);
      }
    }
    expect(runs.get(runIds.control![0]!)).toMatchObject({ points: 4.5, max: 6 });
  });

  it("makes the scale linear, keeps the rounding, and leaves a linear project's scores alone", async () => {
    expect((await projectRow(released)).gradingScale).toEqual({ kind: "linear", rounding: "nearest" });
    expect((await projectRow(unreleased)).gradingScale).toEqual({ kind: "linear", rounding: "down" });
    expect((await projectRow(control)).gradingScale).toEqual({ kind: "linear", rounding: "up" });
    expect(before.control![0]).toEqual({ live: 4.8, released: 4.8 });
    expect(await after(control)).toEqual(before.control);
    const [c] = await db.select().from(projectRepos).where(eq(projectRepos.projectId, control));
    expect(c).toMatchObject({ releasedPoints: 4.5, releasedMax: 6, releasedGrade: 4.8 });
  });

  it("freezes every released grade: a rounding edited afterwards moves the live grade, never the release's", async () => {
    const row = await projectRow(control);
    await db.update(projects).set({ gradingScale: { kind: "linear", rounding: "down" } }).where(eq(projects.id, control));
    try {
      expect((await after(control))[0]).toEqual({ live: 4.7, released: 4.8 });
    } finally {
      await db.update(projects).set({ gradingScale: row.gradingScale }).where(eq(projects.id, control));
    }
  });

  it("converts the staff's marks out of 6 of a migrated project's column, and keeps their grade", async () => {
    const byId = async (id: string) => (await db.select().from(gradebookMarks).where(eq(gradebookMarks.id, id)))[0]!;
    const converted = await byId(marks.unreleased!);
    expect(converted).toMatchObject({ points: 3.5, max: 5 });
    expect(projectGrade(converted.points!, converted.max!, { kind: "linear", rounding: "down" }).grade).toBe(presetGrade(4.5, 6, "down"));
    expect(await byId(marks.control!)).toMatchObject({ points: 4.5, max: 6 });
  });

  it("audits one entry per migrated project, by the system", async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "project.scale_migrated"), inArray(auditLog.subjectId, [released, unreleased, control])));
    const of = (id: string) => rows.filter((r) => r.subjectId === id);
    expect(of(control)).toEqual([]);
    expect(of(released)).toEqual([
      expect.objectContaining({
        actorType: "system",
        actorUserId: null,
        subjectType: "project",
        payload: { from: "score_is_grade", released: true, runs: 7, teacherScores: 2, releasedScores: 5, gradebookMarks: 0 },
      }),
    ]);
    expect(of(unreleased)).toEqual([
      expect.objectContaining({ payload: { from: "score_is_grade", released: false, runs: 3, teacherScores: 1, releasedScores: 0, gradebookMarks: 1 } }),
    ]);
  });
});
