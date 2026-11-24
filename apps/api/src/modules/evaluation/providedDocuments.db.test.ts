/**
 * The documents an evaluation provides, staff side (ADR-144 §7, F-EVAL-37),
 * over the real application: the selection set and ordered by the patch, the
 * poll and another course refused, frozen with the configuration, carried by
 * a copy within the course and dropped across courses, carried by a template
 * whose revision it moves and left alone by a pull; and the library's side
 * of it — the delete refused while a template or an evaluation not yet over
 * provides the document, allowed once they are over, and `usedBy`.
 *
 * What a student reads of them is `live/documents.db.test.ts`'s.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CourseLibrary, EvaluationDetail, TemplateDetail } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { auditLog, classrooms, coursePools, courseStaff, evaluationProvidedDocuments } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { type Actor, testServer, type TestServer } from "../../test/http.js";
import { pdfBytes, uploadDocument } from "../../test/library.js";
import { reload, seedLive } from "../../test/live.js";
import { conditionsFor, previewView } from "../live/views.js";
import { releaseResults } from "../results/service.js";
import * as service from "./service.js";

let server: TestServer;
let restore: () => void;
let teacher: Actor;
let student: Actor;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
});
afterAll(async () => {
  await server.close();
  restore();
});

const db = () => server.app.db;
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  server.app.inject({ method, url, headers: teacher.headers, ...(payload === undefined ? {} : { payload }) });

/** An exam of its own course, and three documents of that course's library. */
async function world() {
  const seed = await seedLive(db(), { teacherId: teacher.id, studentIds: [student.id], settings: { lobby: "skip" } });
  const docs = [];
  for (const title of ["Datasheet", "Formulaire", "Norme"]) {
    docs.push(await uploadDocument(server, seed.courseId, teacher, { bytes: pdfBytes(), filename: `${title}.pdf`, title }));
  }
  return { seed, ids: docs.map((d) => d.id) };
}

const patch = (evaluationId: string, documents: string[]) => call("PATCH", `/app/api/evaluations/${evaluationId}`, { documents });
const detailOf = async (evaluationId: string) => {
  const res = await call("GET", `/app/api/evaluations/${evaluationId}`);
  expect(res.statusCode, res.body).toBe(200);
  return EvaluationDetail.parse(res.json());
};
const selected = async (evaluationId: string) => (await detailOf(evaluationId)).documents.map((d) => d.id);
const libraryOf = async (courseId: string) => CourseLibrary.parse((await call("GET", `/app/api/courses/${courseId}/documents`)).json());

describe("the selection (F-EVAL-37)", () => {
  it("is set, ordered and emptied by the patch, and read back with titles and kinds", async () => {
    const { seed, ids } = await world();
    const set = await patch(seed.evaluationId, [ids[2]!, ids[0]!]);
    expect(set.statusCode, set.body).toBe(200);
    expect(EvaluationDetail.parse(set.json()).documents).toEqual([
      { id: ids[2], title: "Norme", kind: "pdf" },
      { id: ids[0], title: "Datasheet", kind: "pdf" },
    ]);
    expect((await patch(seed.evaluationId, [ids[0]!, ids[2]!])).statusCode).toBe(200);
    expect(await selected(seed.evaluationId)).toEqual([ids[0], ids[2]]);
    expect((await patch(seed.evaluationId, [])).statusCode).toBe(200);
    expect(await selected(seed.evaluationId)).toEqual([]);
    // The update row records the field, as for any other (no action of its own).
    const rows = await db().select().from(auditLog).where(and(eq(auditLog.action, "evaluation.update"), eq(auditLog.subjectId, seed.evaluationId)));
    expect(rows.at(-1)!.payload).toEqual({ fields: ["documents"] });
  });

  it("refuses more than ten, a repeated one, an unknown one and another course's alike", async () => {
    const { seed, ids } = await world();
    expect((await patch(seed.evaluationId, Array.from({ length: 11 }, () => randomUUID()))).statusCode).toBe(400);
    expect((await patch(seed.evaluationId, [ids[0]!, ids[0]!])).statusCode).toBe(400);
    const other = await world();
    const unknown = await patch(seed.evaluationId, [ids[0]!, randomUUID()]);
    const foreign = await patch(seed.evaluationId, [ids[0]!, other.ids[0]!]);
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toEqual(foreign.json());
    expect(foreign.json().error).toBe("document_unknown");
    expect(await selected(seed.evaluationId)).toEqual([]);
  });

  it("refuses a poll, an empty list excepted", async () => {
    const { seed, ids } = await world();
    const poll = await service.createPollEvaluation(db(), {
      classroomId: seed.classroomId,
      title: "Poll",
      createdBy: teacher.id,
      questionId: seed.questionIds[0]!,
      accessCode: `P${randomUUID().slice(0, 5).toUpperCase()}`,
      defaultPoints: () => 1,
      now: server.clock.now(),
    });
    // A poll opens running, its configuration locked: once over with nobody in, the mode's own refusal speaks.
    await service.applyState(db(), poll.evaluation, "closed", server.clock.now());
    const refused = await patch(poll.evaluation.id, [ids[0]!]);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("documents_not_allowed");
    expect((await patch(poll.evaluation.id, [])).statusCode).toBe(200);
  });

  it("is frozen with the configuration: while it runs, and once an attempt exists", async () => {
    const { seed, ids } = await world();
    expect((await patch(seed.evaluationId, [ids[0]!])).statusCode).toBe(200);
    expect((await call("POST", `/app/api/evaluations/${seed.evaluationId}/start`, { confirm: true })).statusCode).toBe(200);
    const running = await patch(seed.evaluationId, [ids[1]!]);
    expect([running.statusCode, running.json().error]).toEqual([409, "running_locked"]);
    const entered = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${seed.evaluationId}/attempt/start`,
      headers: student.headers,
      payload: {},
    });
    expect(entered.statusCode, entered.body).toBe(200);
    expect((await call("POST", `/app/api/evaluations/${seed.evaluationId}/close`, { confirm: true })).statusCode).toBe(200);
    const closed = await patch(seed.evaluationId, []);
    expect([closed.statusCode, closed.json().error]).toEqual([409, "locked"]);
    expect(await selected(seed.evaluationId)).toEqual([ids[0]]);
  });
});

describe("the documents of a preview (ADR-144 §7)", () => {
  it("lists the selection to the teacher's stateless preview only, never to the builder's other callers", async () => {
    const { seed, ids } = await world();
    expect((await patch(seed.evaluationId, [ids[0]!, ids[1]!])).statusCode).toBe(200);
    const row = await reload(db(), seed.evaluationId);
    // The hand-out and every other caller of the builder: none, the conditions counting them all the same.
    const plain = await previewView(db(), row, server.clock.now());
    expect(plain.documents).toEqual([]);
    expect(plain.conditions.imposed).toContainEqual({ key: "documents", kind: "provided", count: 2 });
    // The hand-out (`evaluation/document.ts`) and the paper copies build on this default; the fake
    // type of these tests does not print, so their records are searched by the paper's own tests.
    // The stateless preview, the teacher's.
    const preview = await call("POST", `/app/api/evaluations/${seed.evaluationId}/preview`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().view.documents.map((d: { title: string }) => d.title)).toEqual(["Datasheet", "Formulaire"]);
  });
});

describe("a copy (ADR-031)", () => {
  it("keeps the selection within the course and drops it into another", async () => {
    const { seed, ids } = await world();
    expect((await patch(seed.evaluationId, [ids[1]!, ids[0]!])).statusCode).toBe(200);
    const same = await call("POST", `/app/api/evaluations/${seed.evaluationId}/duplicate`, { title: "Copy" });
    expect(same.statusCode, same.body).toBe(201);
    expect(await selected(same.json().id)).toEqual([ids[1], ids[0]]);

    // Another classroom of the same course keeps it; a classroom of another course, which links the pool, drops it.
    const sibling = randomUUID();
    await db().insert(classrooms).values({ id: sibling, courseId: seed.courseId, name: "B", period: "2026-B" });
    const kept = await call("POST", `/app/api/evaluations/${seed.evaluationId}/duplicate`, { title: "Sibling", classroomId: sibling });
    expect(kept.statusCode, kept.body).toBe(201);
    expect(await selected(kept.json().id)).toEqual([ids[1], ids[0]]);
    const other = await world();
    await db().insert(coursePools).values({ courseId: other.seed.courseId, poolId: seed.poolId });
    const moved = await call("POST", `/app/api/evaluations/${seed.evaluationId}/duplicate`, {
      title: "Elsewhere",
      classroomId: other.seed.classroomId,
    });
    expect(moved.statusCode, moved.body).toBe(201);
    expect(await selected(moved.json().id)).toEqual([]);
  });
});

describe("a template (ADR-031, F-EVAL-25, F-EVAL-26)", () => {
  const templateDetail = async (id: string) => {
    const res = await call("GET", `/app/api/templates/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return TemplateDetail.parse(res.json());
  };

  it("is saved and instantiated with the selection, moves its revision with it, and a pull leaves the instance's alone", async () => {
    const { seed, ids } = await world();
    expect((await patch(seed.evaluationId, [ids[0]!])).statusCode).toBe(200);
    const saved = await call("POST", `/app/api/evaluations/${seed.evaluationId}/template`, { title: "Template" });
    expect(saved.statusCode, saved.body).toBe(201);
    const templateId: string = saved.json().id;
    const template = await templateDetail(templateId);
    expect(template.documents.map((d) => d.id)).toEqual([ids[0]]);
    expect(template.template.revision).toBe(1);

    // A change of the selection is a change of the content: the revision moves, once.
    const edited = await call("PATCH", `/app/api/templates/${templateId}`, { documents: [ids[1]!, ids[0]!] });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await templateDetail(templateId)).template.revision).toBe(2);
    expect((await call("PATCH", `/app/api/templates/${templateId}`, { documents: [ids[1]!, ids[0]!] })).statusCode).toBe(200);
    expect((await templateDetail(templateId)).template.revision).toBe(2);

    const instance = await call("POST", `/app/api/templates/${templateId}/instances`, { classroomId: seed.classroomId });
    expect(instance.statusCode, instance.body).toBe(201);
    const instanceId: string = instance.json().evaluation.id;
    expect(await selected(instanceId)).toEqual([ids[1], ids[0]]);

    // The template moves on; a pull takes its questions, never its documents.
    expect((await call("PATCH", `/app/api/templates/${templateId}`, { documents: [ids[2]!] })).statusCode).toBe(200);
    expect((await patch(instanceId, [ids[0]!])).statusCode).toBe(200);
    const revision = (await templateDetail(templateId)).template.revision;
    const pulled = await call("POST", `/app/api/evaluations/${instanceId}/pull-template`, { revision });
    expect(pulled.statusCode, pulled.body).toBe(200);
    expect(await selected(instanceId)).toEqual([ids[0]]);
  });
});

describe("the library's side (ADR-144 §7)", () => {
  it("tells where a document is used, and refuses its delete while a template or an unfinished evaluation provides it", async () => {
    const { seed, ids } = await world();
    const [a] = ids as [string];
    expect((await patch(seed.evaluationId, [a])).statusCode).toBe(200);
    const saved = await call("POST", `/app/api/evaluations/${seed.evaluationId}/template`, { title: "Template" });
    const templateId: string = saved.json().id;
    const remove = () => call("DELETE", `/app/api/courses/${seed.courseId}/documents/${a}`);
    const usedBy = async () => (await libraryOf(seed.courseId)).documents.find((d) => d.id === a)!.usedBy;
    expect(await usedBy()).toEqual([
      { evaluationId: seed.evaluationId, title: "Test évaluation", state: "draft", template: false },
      { evaluationId: templateId, title: "Template", state: "draft", template: true },
    ]);

    const refusedBy = async () => {
      const res = await remove();
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toBe("document_in_use");
      return (res.json().evaluations as { evaluationId: string; state: string }[]).map((e) => [e.evaluationId, e.state]);
    };
    // A draft and a template.
    expect(await refusedBy()).toEqual([[seed.evaluationId, "draft"], [templateId, "draft"]]);
    expect((await call("DELETE", `/app/api/templates/${templateId}`, { confirmTitle: "Template" })).statusCode).toBe(204);
    // Scheduled, then running.
    const opensAt = new Date(server.clock.now().getTime() + 3_600_000).toISOString();
    const closesAt = new Date(server.clock.now().getTime() + 7_200_000).toISOString();
    expect((await call("PATCH", `/app/api/evaluations/${seed.evaluationId}`, { opensAt, closesAt })).statusCode).toBe(200);
    const scheduled = await call("POST", `/app/api/evaluations/${seed.evaluationId}/state`, { to: "scheduled" });
    expect(scheduled.statusCode, scheduled.body).toBe(200);
    expect(await refusedBy()).toEqual([[seed.evaluationId, "scheduled"]]);
    await service.applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    expect(await refusedBy()).toEqual([[seed.evaluationId, "running"]]);
    // Over: the delete goes, the selection with it, recorded in the audit row.
    await service.applyState(db(), await reload(db(), seed.evaluationId), "closed", server.clock.now());
    expect((await remove()).statusCode).toBe(204);
    expect(await db().select().from(evaluationProvidedDocuments).where(eq(evaluationProvidedDocuments.documentId, a))).toEqual([]);
    const [row] = await db().select().from(auditLog).where(and(eq(auditLog.action, "course.document_delete"), eq(auditLog.subjectId, seed.courseId)));
    expect(row!.payload).toMatchObject({ documentId: a, evaluations: [seed.evaluationId] });
    const evaluation = await reload(db(), seed.evaluationId);
    expect(conditionsFor(evaluation, 0, await service.providedDocumentCount(db(), evaluation.id)).imposed.map((l) => l.key)).not.toContain("documents");
  });

  it("lets a released evaluation's document go", async () => {
    const { seed, ids } = await world();
    expect((await patch(seed.evaluationId, [ids[0]!])).statusCode).toBe(200);
    await service.applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    await service.applyState(db(), await reload(db(), seed.evaluationId), "closed", server.clock.now());
    await releaseResults(db(), await reload(db(), seed.evaluationId), server.clock.now());
    expect((await reload(db(), seed.evaluationId)).state).toBe("released");
    expect((await libraryOf(seed.courseId)).documents.find((d) => d.id === ids[0])!.usedBy).toMatchObject([{ state: "released" }]);
    expect((await call("DELETE", `/app/api/courses/${seed.courseId}/documents/${ids[0]}`)).statusCode).toBe(204);
    expect((await detailOf(seed.evaluationId)).documents).toEqual([]);
  });

  it("is a course's staff's alone: a colleague on another course is refused like a stranger", async () => {
    const { seed, ids } = await world();
    const other = await server.signIn("teacher");
    const elsewhere = await seedLive(db(), { teacherId: other.id, studentIds: [] });
    await db().insert(courseStaff).values({ courseId: elsewhere.courseId, userId: teacher.id, role: "assistant" });
    // The teacher reaches both courses, yet one course's selection takes none of the other's documents.
    const res = await patch(elsewhere.evaluationId, [ids[0]!]);
    expect([res.statusCode, res.json().error]).toEqual([422, "document_unknown"]);
    expect(seed.courseId).not.toBe(elsewhere.courseId);
  });
});
