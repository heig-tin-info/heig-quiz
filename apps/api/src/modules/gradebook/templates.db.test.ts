/**
 * An evaluation template's gradebook settings (ADR-131 §15, F-EVAL-24..26,
 * F-GBOOK-06) over the real application and the real migrations.
 *
 * The world: one course with two classrooms (A, with two claimed students,
 * and B) and a component of the mean, "Labo"; its seeded exam of two
 * questions; another course of the same teacher, with a component of its own.
 *
 * What it pins:
 * - a template's settings are read — its mode's defaults until written —
 *   and written by any member of the course's staff, a component of its
 *   course or the 404 of a missing one, never a position; anyone off the
 *   staff gets the 404 of a missing template; the write is audited on the
 *   template, hints nobody and moves no revision;
 * - its row reaches no reader: the staff table, the CSV, the student's
 *   cells, the Grades page, the personal export are byte for byte the same;
 * - an instance inherits the stored settings, nothing without them, nothing
 *   in an archived classroom; "save as template" keeps the source's; a pull
 *   brings none;
 * - a stored flag survives the template's change of mode (ADR-092 §4); the
 *   template holds its component in use, and its deletion takes its
 *   settings along.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EvaluationTemplate,
  GradebookColumnSettings,
  GradebookComponents,
  PERSONAL_DATA_EXPORT_PATH,
  TemplateDetail,
  TemplateInstance,
} from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { subscribe } from "../../events.js";
import { auditLog, classrooms, courseStaff, courses, gradebookColumns } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive, type Seeded } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";

type Headers = Record<string, string>;
type Signed = { id: string; headers: Headers };
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

let server: TestServer;
let restore: () => void;
let teacher: Signed;
let students: Signed[];
let seed: Seeded;
let other: Seeded;
let roomB: string;
let labo: string;
let oral: string;

const db = (): Db => server.app.db;
const call = (method: Method, url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const tplUrl = (id: string) => `/app/api/templates/${id}/gradebook`;
const colUrl = (id: string, classroomId = seed.classroomId) => `/app/api/classrooms/${classroomId}/gradebook/columns/evaluation/${id}`;

async function templateSettings(id: string): Promise<GradebookColumnSettings> {
  const res = await call("GET", tplUrl(id), teacher.headers);
  expect(res.statusCode, res.body).toBe(200);
  return GradebookColumnSettings.parse(res.json());
}

async function patchTemplate(id: string, body: object, who: Signed = teacher): Promise<GradebookColumnSettings> {
  const res = await call("PATCH", tplUrl(id), who.headers, body);
  expect(res.statusCode, res.body).toBe(200);
  return GradebookColumnSettings.parse(res.json());
}

async function columnSettings(id: string, classroomId = seed.classroomId): Promise<GradebookColumnSettings> {
  const res = await call("GET", colUrl(id, classroomId), teacher.headers);
  expect(res.statusCode, res.body).toBe(200);
  return GradebookColumnSettings.parse(res.json());
}

async function patchColumn(id: string, body: object, classroomId = seed.classroomId) {
  const res = await call("PATCH", colUrl(id, classroomId), teacher.headers, body);
  expect(res.statusCode, res.body).toBe(200);
}

/** A new, empty template of a course. */
async function newTemplate(mode: "exam" | "exercise", courseId = seed.courseId): Promise<string> {
  const res = await call("POST", `/app/api/courses/${courseId}/templates`, teacher.headers, { title: `Template ${mode}`, mode });
  expect(res.statusCode, res.body).toBe(201);
  return EvaluationTemplate.parse(res.json()).id;
}

/** "Save as template" of an evaluation. */
async function saveAsTemplate(evaluationId: string): Promise<string> {
  const res = await call("POST", `/app/api/evaluations/${evaluationId}/template`, teacher.headers, { title: "Saved" });
  expect(res.statusCode, res.body).toBe(201);
  return EvaluationTemplate.parse(res.json()).id;
}

/** "Instantiate" a template into a classroom of its course. */
async function instantiate(templateId: string, classroomId = seed.classroomId): Promise<string> {
  const res = await call("POST", `/app/api/templates/${templateId}/instances`, teacher.headers, { classroomId });
  expect(res.statusCode, res.body).toBe(201);
  return TemplateInstance.parse(res.json()).evaluation.id;
}

async function revisionOf(templateId: string): Promise<number> {
  const res = await call("GET", `/app/api/templates/${templateId}`, teacher.headers);
  expect(res.statusCode, res.body).toBe(200);
  return TemplateDetail.parse(res.json()).template.revision;
}

const columnRows = (evaluationId: string) => db().select().from(gradebookColumns).where(eq(gradebookColumns.evaluationId, evaluationId));

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
  return bodies.map((res) => res.body);
}

/** The hint topics a request publishes. */
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

/** A component of a course, made by its owner. */
async function component(courseId: string, name: string): Promise<string> {
  const res = await call("POST", `/app/api/courses/${courseId}/gradebook/components`, teacher.headers, { name });
  expect(res.statusCode, res.body).toBe(201);
  return GradebookComponents.parse(res.json()).find((c) => c.name === name)!.id;
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-11-16T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  students = await Promise.all([0, 1].map(() => server.signIn("student")));
  seed = await seedLive(db(), { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 2 });
  roomB = randomUUID();
  await db().insert(classrooms).values({ id: roomB, courseId: seed.courseId, name: "B", period: "2026-B" });
  other = await seedLive(db(), { teacherId: teacher.id, studentIds: [], questions: 0 });
  labo = await component(seed.courseId, "Labo");
  oral = await component(other.courseId, "Oral");
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("a template's gradebook settings (ADR-131 §15)", () => {
  it("reads its mode's defaults until written, writes a component of its course, audits on the template, moves no revision", async () => {
    const template = await newTemplate("exercise");
    expect(await templateSettings(template)).toEqual({
      weight: 100,
      counts: false,
      componentId: null,
      released: false,
      meanPublished: false,
      components: [expect.objectContaining({ id: labo, name: "Labo" })],
    });
    expect(await patchTemplate(template, { weight: 40, counts: true, componentId: labo })).toMatchObject({ weight: 40, counts: true, componentId: labo });
    expect(await revisionOf(template)).toBe(1);
    const audited = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "gradebook.column_updated"), eq(auditLog.subjectId, template)));
    expect(audited.map((row) => [row.subjectType, row.payload])).toEqual([
      [
        "evaluation",
        {
          activityKind: "evaluation",
          activityId: template,
          before: { weight: 100, counts: false, position: null, componentId: null },
          after: { weight: 40, counts: true, position: null, componentId: labo },
        },
      ],
    ]);
    // Another course's component is the 404 of a missing one; a position is no template's.
    const foreign = await call("PATCH", tplUrl(template), teacher.headers, { componentId: oral });
    expect([foreign.statusCode, foreign.json().error]).toEqual([404, "not_found"]);
    expect((await call("PATCH", tplUrl(template), teacher.headers, { weight: 10, position: 1 })).statusCode).toBe(400);
    expect(await templateSettings(template)).toMatchObject({ weight: 40, counts: true, componentId: labo });
  });

  it("is any member's to write; anyone off the staff gets the 404 of a missing template", async () => {
    const template = await newTemplate("exam");
    const assistant = await server.signIn("teacher");
    await db().insert(courseStaff).values({ courseId: seed.courseId, userId: assistant.id, role: "assistant" });
    expect(await patchTemplate(template, { weight: 70 }, assistant)).toMatchObject({ weight: 70 });

    const stranger = await server.signIn("teacher");
    const missing = await call("GET", tplUrl(randomUUID()), stranger.headers);
    expect(missing.statusCode).toBe(404);
    for (const method of ["GET", "PATCH"] as const) {
      const res = await call(method, tplUrl(template), stranger.headers, method === "PATCH" ? { weight: 1 } : undefined);
      expect([res.statusCode, res.body], method).toEqual([404, missing.body]);
    }
    // A classroom's evaluation is no template: the 404 too.
    expect((await call("GET", tplUrl(seed.evaluationId), teacher.headers)).statusCode).toBe(404);
    expect(await templateSettings(template)).toMatchObject({ weight: 70 });
  });

  it("keeps a template's row out of the staff table, the CSV, the student's cells, the Grades page and the personal export, and hints nobody", async () => {
    const template = await newTemplate("exam");
    const before = await readers();
    const topics = await hinted(() => call("PATCH", tplUrl(template), teacher.headers, { weight: 13, componentId: labo }));
    expect(topics).toEqual([]);
    const after = await readers();
    expect(after).toEqual(before);
    for (const body of after) expect(body).not.toContain(template);
    expect((await columnRows(template))[0]!.classroomId).toBeNull();
  });

  it("gives an instance the template's stored settings, in any classroom of the course but an archived one; nothing without", async () => {
    const template = await newTemplate("exam");
    await patchTemplate(template, { weight: 30, counts: false, componentId: labo });
    expect(await columnSettings(await instantiate(template))).toMatchObject({ weight: 30, counts: false, componentId: labo });
    expect(await columnSettings(await instantiate(template, roomB), roomB)).toMatchObject({ weight: 30, counts: false, componentId: labo });

    const plain = await newTemplate("exam");
    expect(await columnRows(await instantiate(plain))).toEqual([]);

    const archived = randomUUID();
    await db().insert(classrooms).values({ id: archived, courseId: seed.courseId, name: "Old", period: "2025-A", archivedAt: new Date() });
    expect(await columnRows(await instantiate(template, archived))).toEqual([]);
  });

  it("saves an evaluation's stored settings into its template, never its position; nothing without", async () => {
    const source = (await evaluationService.createEvaluation(db(), { classroomId: seed.classroomId, title: "Source", mode: "exam", createdBy: teacher.id })).id;
    await patchColumn(source, { weight: 55, counts: false, componentId: labo, position: 4 });
    const template = await saveAsTemplate(source);
    expect(await templateSettings(template)).toMatchObject({ weight: 55, counts: false, componentId: labo });
    expect((await columnRows(template))[0]).toMatchObject({ classroomId: null, position: null });

    const plain = (await evaluationService.createEvaluation(db(), { classroomId: seed.classroomId, title: "Plain", mode: "exam", createdBy: teacher.id })).id;
    expect(await columnRows(await saveAsTemplate(plain))).toEqual([]);
  });

  it("brings no setting with a pull: the instance keeps its own (F-EVAL-26)", async () => {
    const template = await saveAsTemplate(seed.evaluationId);
    await patchTemplate(template, { weight: 20 });
    const instance = await instantiate(template);
    await patchColumn(instance, { weight: 80 });
    await patchTemplate(template, { weight: 10, counts: false });
    expect(await revisionOf(template)).toBe(1);
    // A real revision: the points of the template's first item.
    const detail = TemplateDetail.parse((await call("GET", `/app/api/templates/${template}`, teacher.headers)).json());
    const first = detail.items[0]!;
    const moved = await call("PATCH", `/app/api/templates/${template}/items/${first.id}`, teacher.headers, { points: first.points + 1 });
    expect(moved.statusCode, moved.body).toBe(200);
    const pulled = await call("POST", `/app/api/evaluations/${instance}/pull-template`, teacher.headers, { revision: 2 });
    expect(pulled.statusCode, pulled.body).toBe(200);
    expect(await columnSettings(instance)).toMatchObject({ weight: 80, counts: true });
  });

  it("keeps a stored flag across the template's change of mode; an untouched one reads its new default (ADR-092 §4)", async () => {
    const stored = await newTemplate("exam");
    const untouched = await newTemplate("exam");
    await patchTemplate(stored, { weight: 50 });
    for (const id of [stored, untouched]) {
      const res = await call("PATCH", `/app/api/templates/${id}`, teacher.headers, { mode: "exercise" });
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(await templateSettings(stored)).toMatchObject({ weight: 50, counts: true });
    expect(await templateSettings(untouched)).toMatchObject({ weight: 100, counts: false });
  });

  it("holds its component in use; deleting the template takes its settings along", async () => {
    // A course of its own, so no other test's column holds the component.
    const course = await seedLive(db(), { teacherId: teacher.id, studentIds: [], questions: 0 });
    const written = await component(course.courseId, "Projet");
    const template = await newTemplate("exam", course.courseId);
    await patchTemplate(template, { componentId: written });
    const components = async () =>
      GradebookComponents.parse((await call("GET", `/app/api/courses/${course.courseId}/gradebook/components`, teacher.headers)).json());
    expect(await components()).toEqual([{ id: written, name: "Projet", weight: 100, inUse: true }]);
    const refused = await call("DELETE", `/app/api/courses/${course.courseId}/gradebook/components/${written}`, teacher.headers);
    expect([refused.statusCode, refused.json().error]).toEqual([409, "component_in_use"]);

    expect((await call("DELETE", `/app/api/templates/${template}`, teacher.headers)).statusCode).toBe(204);
    expect(await columnRows(template)).toEqual([]);
    expect((await components())[0]!.inUse).toBe(false);

    // Deleting a course takes its template's settings along with its components, in one statement.
    const again = await newTemplate("exam", course.courseId);
    await patchTemplate(again, { componentId: written });
    await db().delete(courses).where(eq(courses.id, course.courseId));
    expect(await columnRows(again)).toEqual([]);
  });
});
