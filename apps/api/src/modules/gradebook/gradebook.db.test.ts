/**
 * The gradebook (F-GBOOK, D06, ADR-074; merge task M5-03a) over the real
 * application and the real migrations.
 *
 * The world: one classroom, three claimed students (and an unclaimed roster
 * line, and a teacher's staff seat), whose columns are two released exams, a
 * released exercise, an exam closed but not released, an exam released under
 * the feedback policy `none`, a released project (one student's repository
 * scored by the teacher, one never accepted) and a project not released.
 *
 * What it pins:
 * - the staff's cells ARE the activities' own results (golden against
 *   `resultsView`), a released exam not taken an absence derived (a1.0), an
 *   exercise not taken an empty cell;
 * - the mean: weighted by whole percentages (relative, #545), to the tenth,
 *   from the displayed cells, over the released columns that count;
 *   exercises opt-in; the class means per column and overall, staff only;
 * - the marks: they win over a grade beneath only with `override` (`409
 *   grade_exists` otherwise), replace and clear, are audited with before and
 *   after, refuse an archived classroom;
 * - the student's exit: no unreleased grade, no source, no comment, no mark
 *   of an unreleased column, no other student, the mean only when published
 *   (the key absent otherwise) — for the student, a teacher in the student
 *   view and an impersonation session; staff routes a 404 to a student.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GradebookStaff, GradebookStudent, CSRF_COOKIE, type FeedbackPolicy, type GradebookStaffCell } from "@quiz/contracts";
import { gradebookMean, gradeFromPoints } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { SESSION_COOKIE, createSession } from "../../auth/session.js";
import type { Db } from "../../db/client.js";
import {
  auditLog,
  classrooms,
  courseStaff,
  enrollments,
  evaluationItems,
  evaluations,
  gradebookColumns,
  gradebookMarks,
  githubOrganizations,
  projectRepos,
  projects,
} from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { kioskStation } from "../../test/kiosk.js";
import { testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as grading from "../grading/service.js";
import * as live from "../live/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as results from "../results/service.js";

type Headers = Record<string, string>;
type Signed = { id: string; headers: Headers };

const SECRET = "SECRET-COMMENT-7f3a";

let server: TestServer;
let restore: () => void;
let teacher: Signed;
let outsider: Signed;
let admin: Signed;
let seated: Signed;
let students: Signed[];
let seed: Seeded;
let nextOrg = 91_000;

/** Column ids by name, and each student's roster line by index. */
const col: Record<string, string> = {};
let seats: string[] = [];

const db = (): Db => server.app.db;
const base = () => `/app/api/classrooms/${seed.classroomId}/gradebook`;
const colUrl = (kind: "evaluation" | "project", name: string) => `${base()}/columns/${kind}/${col[name]}`;
const markUrl = (kind: "evaluation" | "project", name: string, seat: string) => `${colUrl(kind, name)}/marks/${seat}`;

const call = (method: "GET" | "PUT" | "PATCH" | "DELETE", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

async function staffTable(headers = teacher.headers): Promise<GradebookStaff> {
  const res = await call("GET", base(), headers);
  expect(res.statusCode, res.body).toBe(200);
  return GradebookStaff.parse(res.json());
}

async function studentRead(headers: Headers) {
  const res = await call("GET", `/app/api/student/classrooms/${seed.classroomId}/gradebook`, headers);
  expect(res.statusCode, res.body).toBe(200);
  return { body: res.body, parsed: GradebookStudent.parse(res.json()), raw: res.json() as Record<string, unknown> };
}

const cellOf = (table: GradebookStaff, student: number, name: string): GradebookStaffCell => {
  const row = table.rows.find((r) => r.enrollmentId === seats[student]);
  expect(row, `row of student ${student}`).toBeDefined();
  return row!.cells[col[name]!]!;
};
const rowOf = (table: GradebookStaff, student: number) => table.rows.find((r) => r.enrollmentId === seats[student])!;

async function sessionOf(userId: string, auth: { kind: "impersonation" | "seb" | "kiosk"; actorUserId?: string; evaluationId?: string; deviceId?: string }) {
  const session = await createSession(db(), userId, 8, {
    kind: auth.kind,
    actorUserId: auth.actorUserId ?? null,
    evaluationId: auth.evaluationId ?? null,
    projectId: null,
    deviceId: auth.deviceId ?? null,
  });
  return { cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrf}`, "x-csrf-token": session.csrf };
}

/** An exam or exercise of the classroom worth 10 points on one item, under the feedback policy `when`. */
async function makeEvaluation(title: string, mode: "exam" | "exercise", when: FeedbackPolicy["when"] = "on_release"): Promise<string> {
  const created = await evaluationService.createEvaluation(db(), { classroomId: seed.classroomId, title, mode, createdBy: teacher.id });
  const stored = (await evaluationService.byId(db(), created.id))!;
  await evaluationService.addItems(
    db(),
    stored,
    seed.questionIds,
    (type, version) => typeOf(type).defaultPoints(loadConfig(type, version)),
    { attemptCount: 0 },
  );
  const [item] = await joinedItems(db(), created.id);
  await db().update(evaluationItems).set({ points: 10 }).where(eq(evaluationItems.id, item!.item.id));
  await db()
    .update(evaluations)
    .set({ feedbackPolicy: { ...(stored.feedbackPolicy as object), when } })
    .where(eq(evaluations.id, created.id));
  return created.id;
}

/** Runs the evaluation: each taker hands in, the teacher closes, grades 10-point items, and releases when asked. */
async function play(id: string, takers: { student: number; points: number }[], release: boolean) {
  const now = server.clock.now();
  let evaluation = await applyState(db(), await reload(db(), id), "running", now);
  const attempts: { attemptId: string; points: number }[] = [];
  for (const { student, points } of takers) {
    const participant = (await live.participantOf(db(), evaluation, students[student]!.id))!;
    const created = await live.ensureAttempt(db(), evaluation, participant, now);
    const attempt = await live.beginAttempt(db(), evaluation, created, participant, now);
    await live.submitAttempt(db(), evaluation, attempt, now);
    attempts.push({ attemptId: attempt.id, points });
  }
  evaluation = await live.closeEvaluation(db(), evaluation, now, "teacher");
  const [item] = await joinedItems(db(), id);
  for (const { attemptId, points } of attempts) {
    await grading.writeGrading(db(), {
      attemptId,
      itemId: item!.item.id,
      answerId: null,
      points,
      maxPoints: 10,
      source: "manual",
      state: "validated",
      details: { manual: true },
      now,
    });
  }
  if (release) await results.releaseResults(db(), await reload(db(), id), now);
  server.clock.advance(60_000);
}

/** A locked, graded project of the classroom; each entry is a student's repository scored by the teacher. */
async function makeProject(name: string, released: boolean, scored: { student: number; points: number; max: number }[]): Promise<string> {
  const n = nextOrg++;
  const orgId = randomUUID();
  await db().insert(githubOrganizations).values({ id: orgId, login: `gb-org-${n}`, githubOrgId: n, installationId: n });
  const id = randomUUID();
  const deadline = new Date("2026-10-09T22:00:00Z");
  await db().insert(projects).values({
    id,
    classroomId: seed.classroomId,
    orgId,
    name,
    slug: `gb-${n}`,
    state: "locked",
    startAt: new Date("2026-10-01T08:00:00Z"),
    deadlineAt: deadline,
    deadlineAppliedAt: deadline,
    sourceRepoId: n,
    sourceFullName: `gb-org-${n}/starter`,
    distributionRepoId: n + 1,
    distributionFullName: `gb-org-${n}/dist`,
    branches: ["main"],
    protectedFiles: [],
    gradingMode: "auto",
    gradingScale: { kind: "linear", rounding: "nearest" },
    createdBy: teacher.id,
    ...(released ? { releasedAt: new Date("2026-10-10T08:00:00Z"), releasedBy: teacher.id } : {}),
  });
  for (const { student, points, max } of scored) {
    await db().insert(projectRepos).values({
      id: randomUUID(),
      projectId: id,
      userId: students[student]!.id,
      githubRepoId: n * 10 + student,
      fullName: `gb-org-${n}/repo-${student}`,
      defaultBranch: "main",
      provisionStatus: "ok",
      acceptedAt: new Date("2026-10-01T09:00:00Z"),
      invitationStatus: "accepted",
      rulesetId: n,
      deadlineAppliedAt: deadline,
      frozenAt: new Date("2026-10-09T22:30:00Z"),
      teacherPoints: points,
      teacherMax: max,
      teacherComment: SECRET,
      ...(released ? { releasedPoints: points, releasedMax: max, releasedComment: SECRET } : {}),
    });
  }
  return id;
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-10-10T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  outsider = await server.signIn("teacher");
  admin = await server.signIn("admin");
  seated = await server.signIn("teacher");
  students = await Promise.all([0, 1, 2].map(() => server.signIn("student")));
  seed = await seedLive(db(), { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 1 });
  // A teacher's staff seat (ADR-018), and a roster line nobody claimed.
  await db().insert(enrollments).values([
    { id: randomUUID(), classroomId: seed.classroomId, nom: "Seated", prenom: "Teacher", email: "seated@heig.test", userId: seated.id, claimedAt: new Date(), staff: true },
    { id: randomUUID(), classroomId: seed.classroomId, nom: "Zzz", prenom: "Unclaimed", email: "unclaimed@heig.test" },
  ]);
  seats = (await db().select().from(enrollments).where(eq(enrollments.classroomId, seed.classroomId)))
    .filter((e) => e.userId !== null && !e.staff)
    .sort((a, b) => a.nom.localeCompare(b.nom))
    .map((e) => e.id);
  // `seedLive` names the students Nom0..Nom2, in the order of `students`.
  await db().update(evaluations).set({ title: "E1" }).where(eq(evaluations.id, seed.evaluationId));
  col["E1"] = seed.evaluationId;
  const [e1] = await joinedItems(db(), seed.evaluationId);
  await db().update(evaluationItems).set({ points: 10 }).where(eq(evaluationItems.id, e1!.item.id));

  // E1: s0 8/10 -> 5.0, s1 5/10 -> 3.5, s2 absent. Released.
  await play(seed.evaluationId, [{ student: 0, points: 8 }, { student: 1, points: 5 }], true);
  // E2: s0 6/10 -> 4.0, s2 10/10 -> 6.0, s1 absent. Released.
  col["E2"] = await makeEvaluation("E2", "exam");
  await play(col["E2"], [{ student: 0, points: 6 }, { student: 2, points: 10 }], true);
  // X1, an exercise: s0 9/10 -> 5.5; the others never opened it. Released.
  col["X1"] = await makeEvaluation("X1", "exercise");
  await play(col["X1"], [{ student: 0, points: 9 }], true);
  // E3: closed, not released: s0 3/10 -> 2.5 (an unreleased grade).
  col["E3"] = await makeEvaluation("E3", "exam");
  await play(col["E3"], [{ student: 0, points: 3 }], false);
  // E4: released under the policy none: s0 7/10 -> 4.5, a grade the student is not shown.
  col["E4"] = await makeEvaluation("E4", "exam", "none");
  await play(col["E4"], [{ student: 0, points: 7 }], true);
  // P1, released: s0 9/10 -> 5.5; s1 never accepted; s2 has a repository with no score yet.
  col["P1"] = await makeProject("P1", true, [{ student: 0, points: 9, max: 10 }]);
  // P2, not released: s0 1/10 -> 1.5.
  col["P2"] = await makeProject("P2", false, [{ student: 0, points: 1, max: 10 }]);
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("the staff's table (F-GBOOK-01)", () => {
  it("has a row per claimed student seat, never a staff seat nor an unclaimed line", async () => {
    const table = await staffTable();
    expect(table.rows.map((r) => r.enrollmentId).sort()).toEqual([...seats].sort());
    expect(table.rows.map((r) => r.email)).not.toContain("seated@heig.test");
    expect(table.rows.map((r) => r.email)).not.toContain("unclaimed@heig.test");
    expect(table.archived).toBe(false);
    expect(table.meanPublished).toBe(false);
  });

  it("lists exams, exercises and graded projects, never a poll; what counts follows the kind (D06)", async () => {
    const table = await staffTable();
    const byTitle = Object.fromEntries(table.columns.map((c) => [c.title, c]));
    expect(Object.keys(byTitle).sort()).toEqual(["E1", "E2", "E3", "E4", "P1", "P2", "X1"]);
    expect(byTitle["E1"]).toMatchObject({ kind: "evaluation", mode: "exam", released: true, weight: 100, counts: true });
    expect(byTitle["X1"]).toMatchObject({ mode: "exercise", released: true, counts: false });
    expect(byTitle["P1"]).toMatchObject({ kind: "project", mode: "project", released: true, counts: true });
    expect(byTitle["E3"]).toMatchObject({ released: false });
    expect(byTitle["P2"]).toMatchObject({ released: false });
  });

  it("equals the per-evaluation results: the grade of every student of every released evaluation (golden)", async () => {
    const table = await staffTable();
    for (const name of ["E1", "E2", "X1", "E4"]) {
      const view = await results.resultsView(db(), await reload(db(), col[name]!));
      for (const [index, student] of students.entries()) {
        const row = view.rows.find((r) => r.userId === student.id)!;
        const cell = cellOf(table, index, name);
        if (row.state === "absent") continue;
        expect(cell, `${name} of student ${index}`).toMatchObject({ kind: "grade", grade: row.grade, points: row.points, max: view.totalPoints, source: "results", hasGrade: true });
      }
    }
    expect(cellOf(table, 0, "E1").grade).toBe(5);
    expect(cellOf(table, 1, "E1").grade).toBe(3.5);
    expect(cellOf(table, 0, "X1").grade).toBe(5.5);
  });

  it("shows a released exam not taken as an absence a1.0, derived; an exercise not opened as an empty cell", async () => {
    const table = await staffTable();
    expect(cellOf(table, 2, "E1")).toMatchObject({ kind: "absent", grade: 1, source: "derived", mark: null, hasGrade: false });
    expect(cellOf(table, 1, "E2")).toMatchObject({ kind: "absent", grade: 1, source: "derived" });
    expect(cellOf(table, 1, "X1")).toMatchObject({ kind: "empty", grade: null, source: null });
    expect(cellOf(table, 2, "X1")).toMatchObject({ kind: "empty", grade: null });
  });

  it("reads a project's grade from its final score, with the source, and an empty cell where nothing was accepted", async () => {
    const table = await staffTable();
    expect(cellOf(table, 0, "P1")).toMatchObject({ kind: "grade", grade: 5.5, points: 9, max: 10, source: "teacher", changedAfterRelease: false });
    expect(cellOf(table, 1, "P1")).toMatchObject({ kind: "empty", grade: null, hasGrade: false });
  });

  it("shows no grade in a column not released, and leaves it out of the mean", async () => {
    const table = await staffTable();
    expect(cellOf(table, 0, "E3")).toMatchObject({ kind: "empty", grade: null });
    expect(cellOf(table, 0, "P2")).toMatchObject({ kind: "empty", grade: null });
  });

  it("follows its activity: a project score changed after the release changes the cell, flagged", async () => {
    const [repo] = await db().select().from(projectRepos).where(and(eq(projectRepos.projectId, col["P1"]!), eq(projectRepos.userId, students[0]!.id)));
    await db().update(projectRepos).set({ teacherPoints: 10, teacherMax: 10 }).where(eq(projectRepos.id, repo!.id));
    const table = await staffTable();
    expect(cellOf(table, 0, "P1")).toMatchObject({ grade: 6, changedAfterRelease: true });
    await db().update(projectRepos).set({ teacherPoints: 9, teacherMax: 10 }).where(eq(projectRepos.id, repo!.id));
  });
});

describe("the mean (F-GBOOK-02)", () => {
  it("is the weighted mean of the released columns that count, to the tenth, from the displayed cells", async () => {
    const table = await staffTable();
    // s0: E1 5.0, E2 4.0, E4 4.5 (released under `none`: the staff read the real grade) and P1 5.5 count;
    // X1 (an exercise) does not; E3 and P2 are not released.
    const expected = gradebookMean([
      { weight: 100, counts: true, cell: { kind: "grade", grade: 5 } },
      { weight: 100, counts: true, cell: { kind: "grade", grade: 4 } },
      { weight: 100, counts: true, cell: { kind: "grade", grade: gradeFromPoints(7, 10, {}) } },
      { weight: 100, counts: true, cell: { kind: "grade", grade: 5.5 } },
    ]);
    expect(expected).toBe(4.8); // 19 / 4 = 4.75, half up
    expect(rowOf(table, 0).mean).toBe(4.8);
    // s2: E1 absent (1.0), E2 6.0, E4 absent (1.0), P1 empty -> (1 + 6 + 1) / 3 = 2.666…
    expect(rowOf(table, 2).mean).toBe(2.7);
    // s1: E1 3.5, E2 absent, E4 absent, P1 empty -> 5.5 / 3 = 1.83…
    expect(rowOf(table, 1).mean).toBe(1.8);
  });

  it("gives the class mean of each released column and the class's overall mean, to the tenth", async () => {
    const table = await staffTable();
    const classMeanOf = (name: string) => table.columns.find((c) => c.activityId === col[name])!.classMean;
    // E1: 5.0, 3.5 and an absence counted 1.0 -> 9.5 / 3 = 3.17
    expect(classMeanOf("E1")).toBe(3.2);
    // E2: 4.0, an absence, 6.0 -> 11 / 3 = 3.67
    expect(classMeanOf("E2")).toBe(3.7);
    // X1, an exercise: its one grade, though it does not count; empty cells are left out.
    expect(classMeanOf("X1")).toBe(5.5);
    // P1: the one score; the seat that never accepted and the one not scored are empty.
    expect(classMeanOf("P1")).toBe(5.5);
    // Not released: no class mean.
    expect(classMeanOf("E3")).toBeNull();
    expect(classMeanOf("P2")).toBeNull();
    // The students' means 4.8, 1.8, 2.7 -> 9.3 / 3
    expect(table.classMean).toBe(3.1);
  });

  it("takes a weight as a relative percentage, 0 % leaving the column out, and an exercise once the teacher includes it", async () => {
    await call("PATCH", colUrl("evaluation", "E1"), teacher.headers, { weight: 50 });
    const res = await call("PATCH", colUrl("evaluation", "E4"), teacher.headers, { weight: 50 });
    expect(res.statusCode, res.body).toBe(200);
    const table = GradebookStaff.parse(res.json());
    expect(table.columns.find((c) => c.title === "E4")).toMatchObject({ weight: 50, counts: true });
    // s2: E1 absent at 50, E2 6.0 at 100, E4 absent at 50 -> (50 + 600 + 50) / 200 = 3.5
    expect(rowOf(table, 2).mean).toBe(3.5);

    const withExercise = GradebookStaff.parse((await call("PATCH", colUrl("evaluation", "X1"), teacher.headers, { counts: true })).json());
    // s0: E1 5.0 at 50, E2 4.0, E4 4.5 at 50, P1 5.5, X1 5.5 -> (250 + 400 + 225 + 550 + 550) / 400 = 4.94
    expect(rowOf(withExercise, 0).mean).toBe(4.9);
    // s1: X1 is an empty cell: it does not count against them.
    expect(withExercise.columns.find((c) => c.title === "X1")).toMatchObject({ counts: true });
    expect(rowOf(withExercise, 1).mean).toBe(rowOf(table, 1).mean);

    // 0 %: the column stays in the table, with its class mean, and out of every mean.
    const zero = GradebookStaff.parse((await call("PATCH", colUrl("evaluation", "E2"), teacher.headers, { weight: 0 })).json());
    expect(zero.columns.find((c) => c.title === "E2")).toMatchObject({ weight: 0, classMean: 3.7 });
    // s2: E1 absent at 50, E4 absent at 50 -> 1.0
    expect(rowOf(zero, 2).mean).toBe(1);

    for (const name of ["E1", "E2", "E4"]) await call("PATCH", colUrl("evaluation", name), teacher.headers, { weight: 100 });
    await call("PATCH", colUrl("evaluation", "X1"), teacher.headers, { counts: false });
  });

  it("refuses a weight out of range, a body that changes nothing, and a column the classroom does not have", async () => {
    expect((await call("PATCH", colUrl("evaluation", "E1"), teacher.headers, { weight: 101 })).statusCode).toBe(400);
    expect((await call("PATCH", colUrl("evaluation", "E1"), teacher.headers, { weight: 2.5 })).statusCode).toBe(400);
    expect((await call("PATCH", colUrl("evaluation", "E1"), teacher.headers, {})).statusCode).toBe(400);
    expect((await call("PATCH", `${base()}/columns/evaluation/${randomUUID()}`, teacher.headers, { weight: 2 })).statusCode).toBe(404);
    // A project id under `evaluation` is no column of an evaluation.
    expect((await call("PATCH", `${base()}/columns/evaluation/${col["P1"]}`, teacher.headers, { weight: 2 })).statusCode).toBe(404);
  });

  it("audits a column's update with before and after, and nothing for a write that changes nothing", async () => {
    const auditedE4 = async () =>
      (
        await db()
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.action, "gradebook.column_updated"), eq(auditLog.subjectId, seed.classroomId)))
          .orderBy(auditLog.id)
      ).filter((r) => (r.payload as { activityId: string }).activityId === col["E4"]);
    const earlier = (await auditedE4()).length;
    await call("PATCH", colUrl("evaluation", "E4"), teacher.headers, { weight: 30 });
    await call("PATCH", colUrl("evaluation", "E4"), teacher.headers, { weight: 30 });
    const forE4 = (await auditedE4()).slice(earlier);
    expect(forE4).toHaveLength(1);
    expect(forE4[0]!.payload).toMatchObject({
      activityKind: "evaluation",
      before: { weight: 100, counts: true, position: null },
      after: { weight: 30, counts: true, position: null },
    });
    await call("PATCH", colUrl("evaluation", "E4"), teacher.headers, { weight: 100 });
  });
});

describe("the staff's marks (D06, 2026-10-05)", () => {
  it("sets an absence over an empty cell without ceremony, and shows it with its source", async () => {
    const res = await call("PUT", markUrl("evaluation", "X1", seats[1]!), teacher.headers, { kind: "absent", comment: SECRET });
    expect(res.statusCode, res.body).toBe(200);
    const cell = cellOf(GradebookStaff.parse(res.json()), 1, "X1");
    expect(cell).toMatchObject({ kind: "absent", grade: 1, source: "mark", mark: { kind: "absent", comment: SECRET, setBy: expect.any(String) } });
    await call("DELETE", markUrl("evaluation", "X1", seats[1]!), teacher.headers);
  });

  it("refuses a mark over a real grade without override (409 grade_exists), accepts it with", async () => {
    const refused = await call("PUT", markUrl("evaluation", "E1", seats[0]!), teacher.headers, { kind: "absent" });
    expect([refused.statusCode, refused.json().error]).toEqual([409, "grade_exists"]);
    expect((await staffTable()).rows.find((r) => r.enrollmentId === seats[0])!.cells[col["E1"]!]).toMatchObject({ kind: "grade", mark: null });

    const done = await call("PUT", markUrl("evaluation", "E1", seats[0]!), teacher.headers, { kind: "absent", override: true });
    expect(done.statusCode, done.body).toBe(200);
    const table = GradebookStaff.parse(done.json());
    expect(cellOf(table, 0, "E1")).toMatchObject({ kind: "absent", grade: 1, source: "mark", hasGrade: true });
    // The mean follows the cell as displayed.
    expect(rowOf(table, 0).mean).toBeLessThan(5);
  });

  it("replaces a mark already there without a new override, and clears it explicitly: the activity's own grade returns", async () => {
    const replaced = await call("PUT", markUrl("evaluation", "E1", seats[0]!), teacher.headers, { kind: "score", points: 4, max: 10, comment: "regrade by hand" });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(cellOf(GradebookStaff.parse(replaced.json()), 0, "E1")).toMatchObject({ kind: "grade", grade: 3, points: 4, max: 10, source: "mark" });

    const cleared = await call("DELETE", markUrl("evaluation", "E1", seats[0]!), teacher.headers);
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cellOf(GradebookStaff.parse(cleared.json()), 0, "E1")).toMatchObject({ kind: "grade", grade: 5, source: "results", mark: null });
    // Clearing nothing is not an error, and not audited again.
    expect((await call("DELETE", markUrl("evaluation", "E1", seats[0]!), teacher.headers)).statusCode).toBe(200);

    const audited = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, seed.classroomId), eq(auditLog.action, "gradebook.mark_cleared")));
    const ofE1 = audited.filter((r) => (r.payload as { activityId: string }).activityId === col["E1"]);
    expect(ofE1).toHaveLength(1);
    expect(ofE1[0]!.payload).toMatchObject({ after: null, before: { kind: "score", points: 4, max: 10 } });
  });

  it("audits every set with before and after, and whether it overrode a grade", async () => {
    const sets = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, seed.classroomId), eq(auditLog.action, "gradebook.mark_set")));
    const ofE1 = sets.filter((r) => (r.payload as { activityId: string }).activityId === col["E1"]);
    expect(ofE1.map((r) => r.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ before: null, after: { kind: "absent", points: null, max: null, comment: null }, override: true }),
        expect.objectContaining({ before: { kind: "absent", points: null, max: null, comment: null }, after: expect.objectContaining({ kind: "score", points: 4 }), override: false }),
      ]),
    );
  });

  it("leaves replacing a RELEASED grade to an owner: an assistant gets 403 owner_required, and keeps the rest", async () => {
    const assistant = await server.signIn("teacher");
    await db().insert(courseStaff).values({ courseId: seed.courseId, userId: assistant.id, role: "assistant" });
    try {
      const refused = await call("PUT", markUrl("evaluation", "E1", seats[0]!), assistant.headers, { kind: "absent", override: true });
      expect([refused.statusCode, refused.json().error]).toEqual([403, "owner_required"]);
      expect(cellOf(await staffTable(), 0, "E1")).toMatchObject({ kind: "grade", mark: null });
      // An owner's override of a released grade: an assistant may neither change nor clear it, the owner may.
      expect((await call("PUT", markUrl("evaluation", "E1", seats[0]!), teacher.headers, { kind: "absent", override: true })).statusCode).toBe(200);
      const edit = await call("PUT", markUrl("evaluation", "E1", seats[0]!), assistant.headers, { kind: "score", points: 9, max: 10 });
      expect([edit.statusCode, edit.json().error]).toEqual([403, "owner_required"]);
      const clear = await call("DELETE", markUrl("evaluation", "E1", seats[0]!), assistant.headers);
      expect([clear.statusCode, clear.json().error]).toEqual([403, "owner_required"]);
      expect(cellOf(await staffTable(), 0, "E1")).toMatchObject({ kind: "absent", source: "mark" });
      expect((await call("DELETE", markUrl("evaluation", "E1", seats[0]!), teacher.headers)).statusCode).toBe(200);
      // Without the override it is still the 409 anyone gets.
      expect((await call("PUT", markUrl("evaluation", "E1", seats[0]!), assistant.headers, { kind: "absent" })).json().error).toBe("grade_exists");
      // An absence on an empty cell, and a mark on a column not released, stay open to every member.
      expect((await call("PUT", markUrl("evaluation", "X1", seats[1]!), assistant.headers, { kind: "absent" })).statusCode).toBe(200);
      expect((await call("PUT", markUrl("evaluation", "E3", seats[0]!), assistant.headers, { kind: "absent", override: true })).statusCode).toBe(200);
      await call("DELETE", markUrl("evaluation", "X1", seats[1]!), assistant.headers);
      await call("DELETE", markUrl("evaluation", "E3", seats[0]!), assistant.headers);
    } finally {
      await db().delete(courseStaff).where(eq(courseStaff.userId, assistant.id));
    }
  });

  it("fills the empty cell of a project never accepted with the teacher's score, by the project's own scale", async () => {
    const res = await call("PUT", markUrl("project", "P1", seats[1]!), teacher.headers, { kind: "score", points: 15, max: 20 });
    expect(res.statusCode, res.body).toBe(200);
    expect(cellOf(GradebookStaff.parse(res.json()), 1, "P1")).toMatchObject({ kind: "grade", grade: 4.8, points: 15, max: 20, source: "mark" });
    await call("DELETE", markUrl("project", "P1", seats[1]!), teacher.headers);
  });

  it("holds a mark on a column not released: staff only, and out of the mean until the release", async () => {
    const before = rowOf(await staffTable(), 0).mean;
    const res = await call("PUT", markUrl("evaluation", "E3", seats[0]!), teacher.headers, { kind: "absent", override: true });
    expect(res.statusCode, res.body).toBe(200);
    const table = GradebookStaff.parse(res.json());
    expect(cellOf(table, 0, "E3")).toMatchObject({ kind: "absent", source: "mark" });
    expect(rowOf(table, 0).mean).toBe(before);
    await call("DELETE", markUrl("evaluation", "E3", seats[0]!), teacher.headers);
  });

  it("refuses a score above its maximum, a seat that is not a claimed student's, and an unknown column", async () => {
    const above = await call("PUT", markUrl("evaluation", "X1", seats[1]!), teacher.headers, { kind: "score", points: 12, max: 10 });
    expect([above.statusCode, above.json().error]).toEqual([422, "score_above_max"]);
    expect((await call("PUT", markUrl("evaluation", "X1", seats[1]!), teacher.headers, { kind: "score", points: -1, max: 10 })).statusCode).toBe(400);
    expect((await call("PUT", markUrl("evaluation", "X1", seats[1]!), teacher.headers, { kind: "score", points: 1, max: 0 })).statusCode).toBe(400);
    expect((await call("PUT", markUrl("evaluation", "X1", seats[1]!), teacher.headers, { kind: "other" })).statusCode).toBe(400);

    const staffSeat = (await db().select().from(enrollments).where(and(eq(enrollments.classroomId, seed.classroomId), eq(enrollments.staff, true))))[0]!;
    const unclaimed = (await db().select().from(enrollments).where(and(eq(enrollments.classroomId, seed.classroomId), eq(enrollments.email, "unclaimed@heig.test"))))[0]!;
    for (const seat of [staffSeat.id, unclaimed.id, randomUUID()]) {
      expect((await call("PUT", markUrl("evaluation", "X1", seat), teacher.headers, { kind: "absent" })).statusCode, seat).toBe(404);
    }
    const nowhere = await call("PUT", `${base()}/columns/evaluation/${randomUUID()}/marks/${seats[1]}`, teacher.headers, { kind: "absent" });
    expect(nowhere.statusCode).toBe(404);
  });

  it("materializes the stored column with its kind's defaults on the first write that names it", async () => {
    const stored = await db().select().from(gradebookColumns).where(eq(gradebookColumns.classroomId, seed.classroomId));
    const x1 = stored.find((c) => c.evaluationId === col["X1"])!;
    expect(x1).toMatchObject({ weight: 100, projectId: null });
    expect(stored.filter((c) => c.evaluationId === col["X1"])).toHaveLength(1);
  });

  it("drops a student who left the roster, and their marks with them", async () => {
    await call("PUT", markUrl("evaluation", "X1", seats[2]!), teacher.headers, { kind: "absent" });
    expect(await db().select().from(gradebookMarks).where(eq(gradebookMarks.enrollmentId, seats[2]!))).toHaveLength(1);
    const [leaver] = await db().select().from(enrollments).where(eq(enrollments.id, seats[2]!));
    await db().delete(enrollments).where(eq(enrollments.id, seats[2]!));
    expect((await staffTable()).rows.map((r) => r.enrollmentId)).not.toContain(seats[2]);
    expect(await db().select().from(gradebookMarks).where(eq(gradebookMarks.enrollmentId, seats[2]!))).toHaveLength(0);
    await db().insert(enrollments).values(leaver!);
  });
});

describe("the published mean and the archived classroom (F-GBOOK-05, F-GBOOK-06)", () => {
  it("publishes the mean and stops, audited, and answers the table", async () => {
    const on = await call("PATCH", base(), teacher.headers, { meanPublished: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(GradebookStaff.parse(on.json()).meanPublished).toBe(true);
    // Again: nothing changes, nothing is audited again.
    await call("PATCH", base(), teacher.headers, { meanPublished: true });
    const off = GradebookStaff.parse((await call("PATCH", base(), teacher.headers, { meanPublished: false })).json());
    expect(off.meanPublished).toBe(false);
    const published = await db().select().from(auditLog).where(and(eq(auditLog.subjectId, seed.classroomId), eq(auditLog.action, "gradebook.mean_published")));
    const stopped = await db().select().from(auditLog).where(and(eq(auditLog.subjectId, seed.classroomId), eq(auditLog.action, "gradebook.mean_unpublished")));
    expect([published.length, stopped.length]).toEqual([1, 1]);
    expect((await call("PATCH", base(), teacher.headers, { meanPublished: "yes" })).statusCode).toBe(400);
  });

  it("is read-only once the classroom is archived: 409 classroom_archived, the table still read", async () => {
    await db().update(classrooms).set({ archivedAt: server.clock.now() }).where(eq(classrooms.id, seed.classroomId));
    try {
      const attempts = [
        call("PATCH", base(), teacher.headers, { meanPublished: true }),
        call("PATCH", colUrl("evaluation", "E1"), teacher.headers, { weight: 20 }),
        call("PUT", markUrl("evaluation", "X1", seats[1]!), teacher.headers, { kind: "absent" }),
        call("DELETE", markUrl("evaluation", "X1", seats[1]!), teacher.headers),
      ];
      for (const res of await Promise.all(attempts)) expect([res.statusCode, res.json().error]).toEqual([409, "classroom_archived"]);
      expect((await staffTable()).archived).toBe(true);
    } finally {
      await db().update(classrooms).set({ archivedAt: null }).where(eq(classrooms.id, seed.classroomId));
    }
  });
});

describe("the student's own cells (F-GBOOK-05, F-RES-04) and what must never reach them", () => {
  /** The cell a student reads for a column, by title. */
  const studentCell = (parsed: GradebookStudent, name: string) => parsed.cells[col[name]!];

  it("carries a student's released grades, the absence a1.0 derived, and nothing of a column that is not theirs yet", async () => {
    const s0 = (await studentRead(students[0]!.headers)).parsed;
    expect(studentCell(s0, "E1")).toEqual({ kind: "grade", grade: 5, points: 8, max: 10 });
    expect(studentCell(s0, "X1")).toMatchObject({ kind: "grade", grade: 5.5 });
    expect(studentCell(s0, "P1")).toMatchObject({ kind: "grade", grade: 5.5, points: 9, max: 10 });
    const s2 = (await studentRead(students[2]!.headers)).parsed;
    expect(studentCell(s2, "E1")).toEqual({ kind: "absent", grade: 1, points: null, max: null });
    const s1 = (await studentRead(students[1]!.headers)).parsed;
    expect(studentCell(s1, "X1")).toMatchObject({ kind: "empty", grade: null });
    expect(studentCell(s1, "P1")).toMatchObject({ kind: "empty", grade: null });
  });

  it("shows no grade of an evaluation released under the policy none, even over a staff mark", async () => {
    await call("PUT", markUrl("evaluation", "E4", seats[0]!), teacher.headers, { kind: "score", points: 2, max: 10, override: true });
    try {
      const { parsed, body } = await studentRead(students[0]!.headers);
      expect(studentCell(parsed, "E4")).toEqual({ kind: "withheld", grade: null, points: null, max: null });
      expect(body).not.toContain(`"grade":2`);
    } finally {
      await call("DELETE", markUrl("evaluation", "E4", seats[0]!), teacher.headers);
    }
  });

  it("shows no project column and no grade before the release", async () => {
    const { parsed } = await studentRead(students[0]!.headers);
    expect(parsed.columns.map((c) => c.activityId)).not.toContain(col["P2"]);
    expect(studentCell(parsed, "E3")).toMatchObject({ kind: "empty", grade: null });
  });

  it("shows a staff mark once its column is released, without the comment nor the points", async () => {
    await call("PUT", markUrl("evaluation", "X1", seats[1]!), teacher.headers, { kind: "absent", comment: SECRET });
    try {
      const { parsed, body } = await studentRead(students[1]!.headers);
      expect(studentCell(parsed, "X1")).toEqual({ kind: "absent", grade: 1, points: null, max: null });
      expect(body).not.toContain(SECRET);
    } finally {
      await call("DELETE", markUrl("evaluation", "X1", seats[1]!), teacher.headers);
    }
  });

  it("leaks no unreleased grade, no source, no comment, no other student, whoever the student caller is", async () => {
    // A mark on an unreleased column, with a comment and a grade of its own: staff only until the release.
    await call("PUT", markUrl("evaluation", "E3", seats[0]!), teacher.headers, { kind: "score", points: 1, max: 10, comment: SECRET, override: true });
    await call("PUT", markUrl("project", "P2", seats[1]!), teacher.headers, { kind: "score", points: 3, max: 10, comment: SECRET });
    try {
      const callers: [string, Headers][] = [
        ["student", students[0]!.headers],
        ["impersonation", await sessionOf(students[0]!.id, { kind: "impersonation", actorUserId: admin.id })],
      ];
      for (const [who, headers] of callers) {
        const { body, raw } = await studentRead(headers);
        // The unreleased: E3 (2.5, then the mark 1.5) and P2 (1.5, then the mark 2.5): none of those grades, nor the comment, anywhere.
        for (const forbidden of ['"grade":2.5', '"grade":1.5', SECRET, '"classMean"', '"source"', '"mark"', '"setBy"', '"comment"', '"hasGrade"', '"changedAfterRelease"', '"email"', '"enrollmentId"', '"teacherPoints"', '"review"', '"ci"']) {
          expect(body, `${who}: ${forbidden}`).not.toContain(forbidden);
        }
        // Nothing of the other students: their names, their e-mails, their cells.
        for (const other of await db().select().from(enrollments).where(eq(enrollments.classroomId, seed.classroomId))) {
          if (other.id !== seats[0]) {
            expect(body, `${who}: ${other.email}`).not.toContain(other.email);
          }
        }
        // The mean is not published: the key does not exist.
        expect("mean" in raw, who).toBe(false);
        // The weights and the counted flags are the teacher's, shown with the mean only.
        for (const column of raw["columns"] as Record<string, unknown>[]) expect(column).not.toHaveProperty("weight");
      }
    } finally {
      await call("DELETE", markUrl("evaluation", "E3", seats[0]!), teacher.headers);
      await call("DELETE", markUrl("project", "P2", seats[1]!), teacher.headers);
    }
  });

  it("gives a teacher in the student view, on their staff seat or none, the same shape with no cell", async () => {
    for (const headers of [seated.headers, teacher.headers]) {
      const { parsed, raw } = await studentRead(headers);
      expect(parsed.columns).toEqual([]);
      expect(parsed.cells).toEqual({});
      expect("mean" in raw).toBe(false);
    }
  });

  it("shows the mean only when the teacher publishes it, from the cells as displayed, with the weights then", async () => {
    await call("PATCH", base(), teacher.headers, { meanPublished: true });
    try {
      const s0 = (await studentRead(students[0]!.headers)).parsed;
      // s0 sees E1 5.0, E2 4.0, P1 5.5 (counted): E4 is withheld, so it is not in what they read.
      expect(s0.mean).toBe(gradebookMean([
        { weight: 100, counts: true, cell: { kind: "grade", grade: 5 } },
        { weight: 100, counts: true, cell: { kind: "grade", grade: 4 } },
        { weight: 100, counts: true, cell: { kind: "grade", grade: 5.5 } },
      ]));
      expect(s0.columns.find((c) => c.activityId === col["E1"])).toMatchObject({ weight: 100, counts: true });
      // The class means are the staff's: never in a student's payload, published mean or not.
      expect(JSON.stringify(s0)).not.toContain("classMean");
      expect(s0.columns.find((c) => c.activityId === col["X1"])).toMatchObject({ counts: false });
      // s1: E1 3.5, E2 absent (1.0): (3.5 + 1) / 2 = 2.25 -> 2.3.
      expect((await studentRead(students[1]!.headers)).parsed.mean).toBe(2.3);
    } finally {
      await call("PATCH", base(), teacher.headers, { meanPublished: false });
    }
    expect("mean" in (await studentRead(students[0]!.headers)).raw).toBe(false);
  });
});

describe("the CSV export (F-GBOOK-04, M5-03b)", () => {
  const csvUrl = () => `${base()}.csv`;
  const read = async () => {
    const res = await call("GET", csvUrl(), teacher.headers);
    expect(res.statusCode, res.body).toBe(200);
    return res;
  };
  /** The file's lines under the BOM: the header, the weights, a row per student, the class means. */
  const linesOf = async () => (await read()).payload.slice(1).trimEnd().split("\r\n");

  it("is the F-RES-02 format: a UTF-8 BOM, `;`, CRLF, an attachment", async () => {
    const res = await read();
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="[a-z0-9-]+\.csv"$/);
    expect(res.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(res.payload.endsWith("\r\n")).toBe(true);
  });

  it("has a row per claimed student, a column per gradebook column in order, and the mean", async () => {
    const table = await staffTable();
    const [header, , ...withClassMeans] = await linesOf();
    const rows = withClassMeans.slice(0, -1);
    expect(header!.split(";")).toEqual([
      "email",
      "last_name",
      "first_name",
      ...table.columns.map((c) => `${c.title}${c.released ? "" : " (unreleased)"}`),
      "mean",
    ]);
    expect(rows).toHaveLength(3);
    // Never the teacher's staff seat, nor the roster line nobody claimed.
    expect(rows.join("\n")).not.toContain("seated@heig.test");
    expect(rows.join("\n")).not.toContain("unclaimed@heig.test");
    for (const [i, row] of rows.entries()) {
      const fields = row.split(";");
      const source = table.rows[i]!;
      expect(fields.slice(0, 3)).toEqual([source.email, source.nom, source.prenom]);
      expect(fields).toHaveLength(3 + table.columns.length + 1);
      expect(fields.at(-1)).toBe(source.mean === null ? "" : source.mean.toFixed(1));
    }
  });

  it("writes a grade at one decimal, the absence `a1.0`, an empty cell empty", async () => {
    const table = await staffTable();
    const rows = (await linesOf()).slice(2);
    const at = (student: number, name: string) => {
      const index = table.columns.findIndex((c) => c.activityId === col[name]);
      const row = table.rows.findIndex((r) => r.enrollmentId === seats[student]);
      return rows[row]!.split(";")[3 + index];
    };
    expect(at(0, "E1")).toBe("5.0");
    expect(at(1, "E1")).toBe("3.5");
    // A derived absence.
    expect(at(2, "E1")).toBe("a1.0");
    expect(at(1, "E2")).toBe("a1.0");
    expect(at(1, "X1")).toBe("");
    // The unreleased column shows no grade of the activity.
    expect(at(0, "E3")).toBe("");
  });

  it("carries a staff absence mark as a1.0 too", async () => {
    const put = await call("PUT", markUrl("evaluation", "X1", seats[2]!), teacher.headers, { kind: "absent" });
    expect(put.statusCode, put.body).toBe(200);
    try {
      const table = await staffTable();
      const rows = (await linesOf()).slice(2);
      const index = 3 + table.columns.findIndex((c) => c.activityId === col["X1"]);
      expect(rows[table.rows.findIndex((r) => r.enrollmentId === seats[2])]!.split(";")[index]).toBe("a1.0");
    } finally {
      await call("DELETE", markUrl("evaluation", "X1", seats[2]!), teacher.headers);
    }
  });

  it("writes the weights under the header and the class means last (#545)", async () => {
    await call("PATCH", colUrl("evaluation", "E2"), teacher.headers, { weight: 40 });
    try {
      const table = await staffTable();
      const lines = await linesOf();
      const field = (line: string, name: string) => line.split(";")[3 + table.columns.findIndex((c) => c.activityId === col[name])];
      const weights = lines[1]!;
      expect(weights.split(";").slice(0, 3)).toEqual(["weight", "", ""]);
      expect([field(weights, "E1"), field(weights, "E2"), field(weights, "P1")]).toEqual(["100", "40", "100"]);
      // An exercise not counted carries no weight; nor does the mean.
      expect(field(weights, "X1")).toBe("");
      expect(weights.split(";").at(-1)).toBe("");

      const means = lines.at(-1)!;
      expect(means.split(";").slice(0, 3)).toEqual(["class_mean", "", ""]);
      expect([field(means, "E1"), field(means, "E2"), field(means, "X1"), field(means, "E3")]).toEqual(["3.2", "3.7", "5.5", ""]);
      expect(means.split(";").at(-1)).toBe(table.classMean!.toFixed(1));
    } finally {
      await call("PATCH", colUrl("evaluation", "E2"), teacher.headers, { weight: 100 });
    }
  });

  it("is a staff read: a teacher off the staff gets the 404, a student the teacher guard's 403, nobody 401", async () => {
    expect((await call("GET", csvUrl(), outsider.headers)).statusCode).toBe(404);
    expect((await call("GET", csvUrl(), students[0]!.headers)).statusCode).toBe(403);
    expect((await call("GET", csvUrl(), {})).statusCode).toBe(401);
  });
});

describe("who reaches the gradebook (invariant 6)", () => {
  it("answers a teacher off the staff with the 404 of a missing classroom, a student with the teacher guard's 403, an anonymous caller 401", async () => {
    for (const [headers, status] of [[outsider.headers, 404], [students[0]!.headers, 403]] as const) {
      expect((await call("GET", base(), headers)).statusCode).toBe(status);
      expect((await call("PATCH", base(), headers, { meanPublished: true })).statusCode).toBe(status);
      expect((await call("PUT", markUrl("evaluation", "X1", seats[1]!), headers, { kind: "absent" })).statusCode).toBe(status);
      expect((await call("DELETE", markUrl("evaluation", "X1", seats[1]!), headers)).statusCode).toBe(status);
    }
    expect((await call("GET", base(), {})).statusCode).toBe(401);
    // A teacher who is no student of the classroom reads nothing on the student's route.
    expect((await call("GET", `/app/api/student/classrooms/${seed.classroomId}/gradebook`, outsider.headers)).statusCode).toBe(404);
    expect((await call("GET", `/app/api/student/classrooms/${randomUUID()}/gradebook`, students[0]!.headers)).statusCode).toBe(404);
  });

  it("never serves a seb or a kiosk session, nor an impersonation session of a student outside the classroom", async () => {
    const seb = await sessionOf(students[0]!.id, { kind: "seb", evaluationId: col["E1"]! });
    expect((await call("GET", `/app/api/student/classrooms/${seed.classroomId}/gradebook`, seb)).statusCode).toBe(401);
    const station = await kioskStation(server.app);
    const kiosk = await sessionOf(students[0]!.id, { kind: "kiosk", evaluationId: col["E1"]!, deviceId: station.deviceId });
    expect((await call("GET", `/app/api/student/classrooms/${seed.classroomId}/gradebook`, { ...kiosk, cookie: `${kiosk.cookie}; ${station.cookie}` })).statusCode).toBe(401);
    const stranger = await server.signIn("student");
    const as = await sessionOf(stranger.id, { kind: "impersonation", actorUserId: admin.id });
    expect((await call("GET", `/app/api/student/classrooms/${seed.classroomId}/gradebook`, as)).statusCode).toBe(404);
  });

  it("refuses an impersonation session every write", async () => {
    const as = await sessionOf(students[0]!.id, { kind: "impersonation", actorUserId: admin.id });
    const res = await call("PUT", markUrl("evaluation", "X1", seats[1]!), as, { kind: "absent" });
    expect([403, 404]).toContain(res.statusCode);
  });
});
