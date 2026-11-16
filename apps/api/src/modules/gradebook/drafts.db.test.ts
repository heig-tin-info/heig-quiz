/**
 * A gradebook column's settings from the draft on (ADR-131, F-GBOOK-06) over
 * the real application and the real migrations.
 *
 * The world: one course with two classrooms (A, with two claimed students,
 * and B) and a component of the mean, "Labo"; a closed exam of A, the one
 * column of its table; another course of the same teacher.
 *
 * What it pins:
 * - the settings are read and written for a draft exam, exercise and graded
 *   project, never a poll, an archived or ungraded project, another
 *   classroom's activity; a mark on a draft stays a 404;
 * - a draft's stored row reaches no reader — the staff table, the CSV, the
 *   student's cells, the Grades page — until the draft leaves the draft,
 *   when its column appears with them; it holds its component in use, and
 *   goes with the draft; a write to it hints the staff only;
 * - a stored flag survives a change of mode (ADR-092 §4), an untouched draft
 *   reads its new mode's default;
 * - a duplicate carries weight, flag and component within the course, weight
 *   and flag into another, nothing without a stored column; a stored source
 *   makes a stored copy, its defaults included.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Evaluation, GradebookColumnSettings, GradebookComponents, GradebookStaff, PERSONAL_DATA_EXPORT_PATH } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { subscribe } from "../../events.js";
import { auditLog, classrooms, enrollments, evaluations, gradebookColumns, projects } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive, type Seeded } from "../../test/live.js";
import { gradedProject } from "../../test/project.js";
import * as evaluationService from "../evaluation/service.js";

type Headers = Record<string, string>;
type Signed = { id: string; headers: Headers };

let server: TestServer;
let restore: () => void;
let teacher: Signed;
let students: Signed[];
let seed: Seeded;
let other: Seeded;
let roomB: string;
let labo: string;

const db = (): Db => server.app.db;
const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const colUrl = (kind: "evaluation" | "project", id: string, classroomId = seed.classroomId) =>
  `/app/api/classrooms/${classroomId}/gradebook/columns/${kind}/${id}`;

async function settings(kind: "evaluation" | "project", id: string, classroomId = seed.classroomId): Promise<GradebookColumnSettings> {
  const res = await call("GET", colUrl(kind, id, classroomId), teacher.headers);
  expect(res.statusCode, res.body).toBe(200);
  return GradebookColumnSettings.parse(res.json());
}

async function patch(kind: "evaluation" | "project", id: string, body: object, classroomId = seed.classroomId) {
  const res = await call("PATCH", colUrl(kind, id, classroomId), teacher.headers, body);
  expect(res.statusCode, res.body).toBe(200);
}

/** A draft exam or exercise of a classroom, with no item. */
async function draft(title: string, mode: "exam" | "exercise", classroomId = seed.classroomId): Promise<string> {
  return (await evaluationService.createEvaluation(db(), { classroomId, title, mode, createdBy: teacher.id })).id;
}

/** A graded project of classroom A in `state`. */
async function project(name: string, state: "draft" | "scheduled", extra: Partial<typeof projects.$inferInsert> = {}): Promise<string> {
  const { id } = await gradedProject(db(), { classroomId: seed.classroomId, name, createdBy: teacher.id, released: false });
  await db().update(projects).set({ state, ...extra }).where(eq(projects.id, id));
  return id;
}

/** Everything a staff member and a student read of classroom A's gradebook, as bodies. */
async function readers() {
  const bodies = await Promise.all([
    call("GET", `/app/api/classrooms/${seed.classroomId}/gradebook`, teacher.headers),
    call("GET", `/app/api/classrooms/${seed.classroomId}/gradebook.csv`, teacher.headers),
    call("GET", `/app/api/student/classrooms/${seed.classroomId}/gradebook`, students[0]!.headers),
    call("GET", "/app/api/student/results", students[0]!.headers),
    call("GET", PERSONAL_DATA_EXPORT_PATH, students[0]!.headers),
  ]);
  for (const res of bodies) expect(res.statusCode, res.body).toBe(200);
  const [table, csv, tab, grades, personal] = bodies.map((res) => res.body);
  return { table: table!, csv: csv!, tab: tab!, grades: grades!, personal: personal! };
}

/** The hint topics a request publishes (the gradebook's own, never the generic one). */
async function hinted(request: () => Promise<{ statusCode: number; body: string }>): Promise<string[]> {
  const topics: string[] = [];
  const unsubscribe = subscribe((m) => {
    if (m.kind === "hint") topics.push(...m.topics);
  });
  try {
    const res = await request();
    expect(res.statusCode, res.body).toBe(200);
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    unsubscribe();
  }
  return topics;
}

const columnRow = async (activity: { evaluationId: string } | { projectId: string }) =>
  db()
    .select()
    .from(gradebookColumns)
    .where("evaluationId" in activity ? eq(gradebookColumns.evaluationId, activity.evaluationId) : eq(gradebookColumns.projectId, activity.projectId));

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-11-16T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  students = await Promise.all([0, 1].map(() => server.signIn("student")));
  seed = await seedLive(db(), { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 1 });
  // The seeded exam, closed: classroom A's one column.
  await db().update(evaluations).set({ state: "closed" }).where(eq(evaluations.id, seed.evaluationId));
  roomB = randomUUID();
  await db().insert(classrooms).values({ id: roomB, courseId: seed.courseId, name: "B", period: "2026-B" });
  other = await seedLive(db(), { teacherId: teacher.id, studentIds: [], questions: 0 });
  const made = await call("POST", `/app/api/courses/${seed.courseId}/gradebook/components`, teacher.headers, { name: "Labo", weight: 37 });
  expect(made.statusCode, made.body).toBe(201);
  labo = GradebookComponents.parse(made.json())[0]!.id;
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("a column's settings from the draft on (ADR-131)", () => {
  it("keeps a draft's stored settings out of the staff table, the CSV, the student's cells, the Grades page and the personal export", async () => {
    const exam = await draft("Draft exam", "exam");
    const lab = await project("Draft project", "draft");
    // A scheduled project is announced to its students (ADR-127), not listed in the gradebook.
    const announced = await project("Scheduled project", "scheduled");
    const before = await readers();
    await patch("evaluation", exam, { weight: 61, componentId: labo });
    await patch("project", lab, { weight: 59, counts: false, componentId: labo });
    await patch("project", announced, { weight: 57, componentId: labo });
    const after = await readers();
    expect(after).toEqual(before);
    for (const body of Object.values(after)) for (const id of [exam, lab]) expect(body).not.toContain(id);
    for (const body of [after.table, after.csv, after.tab, after.grades]) expect(body).not.toContain(announced);
    // The staff's table lists every component of the course; a student, only one holding a column of theirs that counts.
    for (const body of [after.tab, after.grades, after.personal]) for (const leak of [labo, "Labo", '"weight"']) expect(body).not.toContain(leak);
  });

  it("reads and writes a draft exam's, exercise's and graded project's settings, the stored ones or the mode's defaults", async () => {
    const exam = await draft("Exam", "exam");
    const exercise = await draft("Exercise", "exercise");
    const scheduled = await project("Scheduled project", "scheduled");
    expect(await settings("evaluation", exam)).toEqual({
      weight: 100,
      counts: true,
      componentId: null,
      released: false,
      meanPublished: false,
      components: [expect.objectContaining({ id: labo, name: "Labo", weight: 37 })],
    });
    expect(await settings("evaluation", exercise)).toMatchObject({ weight: 100, counts: false, componentId: null });
    expect(await settings("project", scheduled)).toMatchObject({ counts: true, released: false });

    await patch("evaluation", exercise, { weight: 40, counts: true, componentId: labo });
    expect(await settings("evaluation", exercise)).toMatchObject({ weight: 40, counts: true, componentId: labo });
    const [audited] = (
      await db().select().from(auditLog).where(and(eq(auditLog.action, "gradebook.column_updated"), eq(auditLog.subjectId, seed.classroomId)))
    ).filter((row) => (row.payload as { activityId: string }).activityId === exercise);
    expect(audited!.payload).toEqual({
      activityKind: "evaluation",
      activityId: exercise,
      before: { weight: 100, counts: false, position: null, componentId: null },
      after: { weight: 40, counts: true, position: null, componentId: labo },
    });
    // A column already in the table reads the same way.
    expect(await settings("evaluation", seed.evaluationId)).toMatchObject({ weight: 100, counts: true, released: false });
  });

  it("answers a poll, an archived or ungraded project, another classroom's activity the 404 of a missing column; a mark on a draft too", async () => {
    const poll = await draft("Poll", "exam");
    await db().update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, poll));
    const archived = await project("Archived", "draft", { archivedAt: new Date() });
    const ungraded = await project("Ungraded", "draft", { gradingMode: "none" });
    const elsewhere = await draft("Elsewhere", "exam", roomB);
    const exam = await draft("Unmarked", "exam");
    for (const [kind, id] of [["evaluation", poll], ["project", archived], ["project", ungraded], ["evaluation", elsewhere], ["project", exam]] as const) {
      for (const method of ["GET", "PATCH"] as const) {
        const res = await call(method, colUrl(kind, id), teacher.headers, method === "PATCH" ? { weight: 10 } : undefined);
        expect([res.statusCode, res.json().error], `${method} ${kind} ${id}`).toEqual([404, "not_found"]);
      }
    }
    const [seat] = await db().select().from(enrollments).where(eq(enrollments.userId, students[0]!.id));
    const mark = await call("PUT", `${colUrl("evaluation", exam)}/marks/${seat!.id}`, teacher.headers, { kind: "absent" });
    expect(mark.statusCode).toBe(404);
  });

  it("holds a component in use while a draft's column is in it", async () => {
    // A course of its own, so no other test's column holds the component.
    const course = await seedLive(db(), { teacherId: teacher.id, studentIds: [], questions: 0 });
    const made = await call("POST", `/app/api/courses/${course.courseId}/gradebook/components`, teacher.headers, { name: "Oral" });
    const oral = GradebookComponents.parse(made.json())[0]!.id;
    const exam = await draft("Holder", "exam", course.classroomId);
    const components = async () =>
      GradebookComponents.parse((await call("GET", `/app/api/courses/${course.courseId}/gradebook/components`, teacher.headers)).json());
    expect((await components())[0]!.inUse).toBe(false);
    await patch("evaluation", exam, { componentId: oral }, course.classroomId);
    expect(await components()).toEqual([{ id: oral, name: "Oral", weight: 100, inUse: true }]);
    const refused = await call("DELETE", `/app/api/courses/${course.courseId}/gradebook/components/${oral}`, teacher.headers);
    expect([refused.statusCode, refused.json().error]).toEqual([409, "component_in_use"]);
  });

  it("tells only the staff of a draft's settings; a listed column's students too", async () => {
    const exam = await draft("Quiet", "exam");
    const quiet = await hinted(() => call("PATCH", colUrl("evaluation", exam), teacher.headers, { weight: 33 }));
    expect(quiet).toContain(`course:${seed.courseId}`);
    expect(quiet.filter((t) => t.startsWith("user:") || t.startsWith("classroom:"))).toEqual([]);
    const heard = await hinted(() => call("PATCH", colUrl("evaluation", seed.evaluationId), teacher.headers, { weight: 34 }));
    expect(heard).toEqual(expect.arrayContaining([`course:${seed.courseId}`, ...students.map((s) => `user:${s.id}`)]));
    await patch("evaluation", seed.evaluationId, { weight: 100 });
  });

  it("gives the column the draft's stored settings when the draft leaves the draft", async () => {
    const exam = await draft("Announced", "exam");
    await patch("evaluation", exam, { weight: 23, componentId: labo });
    await db().update(evaluations).set({ state: "scheduled" }).where(eq(evaluations.id, exam));
    const table = GradebookStaff.parse((await call("GET", `/app/api/classrooms/${seed.classroomId}/gradebook`, teacher.headers)).json());
    expect(table.columns.find((c) => c.activityId === exam)).toMatchObject({ weight: 23, counts: true, componentId: labo, released: false });
    await db().update(evaluations).set({ state: "draft" }).where(eq(evaluations.id, exam));
  });

  it("keeps a stored flag across a change of mode; an untouched draft reads its new mode's default (ADR-092 §4)", async () => {
    const stored = await draft("Stored", "exam");
    const untouched = await draft("Untouched", "exam");
    await patch("evaluation", stored, { weight: 50 });
    for (const id of [stored, untouched]) {
      const res = await call("PATCH", `/app/api/evaluations/${id}`, teacher.headers, { mode: "exercise" });
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(await settings("evaluation", stored)).toMatchObject({ weight: 50, counts: true });
    expect(await settings("evaluation", untouched)).toMatchObject({ weight: 100, counts: false });
  });

  it("takes a draft's column along when the draft is deleted", async () => {
    const exam = await draft("Deleted", "exam");
    await patch("evaluation", exam, { weight: 70 });
    expect(await columnRow({ evaluationId: exam })).toHaveLength(1);
    const res = await call("DELETE", `/app/api/evaluations/${exam}`, teacher.headers, { confirmTitle: "Deleted" });
    expect(res.statusCode, res.body).toBe(204);
    expect(await columnRow({ evaluationId: exam })).toEqual([]);
  });

  it("carries a duplicate's weight, flag and component within the course, weight and flag into another, nothing without a stored column", async () => {
    const source = await draft("Source", "exercise");
    await patch("evaluation", source, { weight: 42, counts: true, componentId: labo, position: 3 });
    const duplicate = async (id: string, classroomId?: string) => {
      const res = await call("POST", `/app/api/evaluations/${id}/duplicate`, teacher.headers, { title: "Copy", ...(classroomId ? { classroomId } : {}) });
      expect(res.statusCode, res.body).toBe(201);
      return Evaluation.parse(res.json()).id;
    };
    const same = await duplicate(source);
    const sibling = await duplicate(source, roomB);
    const foreign = await duplicate(source, other.classroomId);
    expect(await settings("evaluation", same)).toMatchObject({ weight: 42, counts: true, componentId: labo });
    expect(await settings("evaluation", sibling, roomB)).toMatchObject({ weight: 42, counts: true, componentId: labo });
    expect(await settings("evaluation", foreign, other.classroomId)).toMatchObject({ weight: 42, counts: true, componentId: null });
    // Never the position, which orders the source's classroom.
    expect((await columnRow({ evaluationId: same }))[0]!.position).toBeNull();
    const [copied] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "gradebook.column_updated"), eq(auditLog.subjectId, other.classroomId)));
    expect(copied!.payload).toEqual({
      activityKind: "evaluation",
      activityId: foreign,
      before: { weight: 100, counts: false, position: null, componentId: null },
      after: { weight: 42, counts: true, position: null, componentId: null },
    });

    const plain = await draft("Plain", "exam");
    expect(await columnRow({ evaluationId: await duplicate(plain) })).toEqual([]);
    // A stored row holding the defaults is copied as a stored row, unaudited: its flag survives a change of mode, as the source's.
    const kept = await draft("Kept", "exam");
    await patch("evaluation", kept, { counts: true });
    const keptCopy = await duplicate(kept);
    expect(await columnRow({ evaluationId: keptCopy })).toHaveLength(1);
    const auditedCopy = (await db().select().from(auditLog).where(eq(auditLog.action, "gradebook.column_updated"))).filter(
      (row) => (row.payload as { activityId: string }).activityId === keptCopy,
    );
    expect(auditedCopy).toEqual([]);
    expect((await call("PATCH", `/app/api/evaluations/${keptCopy}`, teacher.headers, { mode: "exercise" })).statusCode).toBe(200);
    expect(await settings("evaluation", keptCopy)).toMatchObject({ counts: true });
    // An archived classroom's gradebook is read-only: the copy lands there without settings.
    const archived = randomUUID();
    await db().insert(classrooms).values({ id: archived, courseId: seed.courseId, name: "Old", period: "2025-A", archivedAt: new Date() });
    expect(await columnRow({ evaluationId: await duplicate(source, archived) })).toEqual([]);
  });
});
