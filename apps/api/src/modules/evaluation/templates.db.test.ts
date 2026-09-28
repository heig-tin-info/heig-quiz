/**
 * Evaluation templates (ADR-031) against the real migrations, over HTTP.
 *
 * Three things are asserted here that a screenshot cannot show: the schema
 * refuses a template that carries anything of a run; every template route
 * answers a caller off the course's staff with the 404 of a missing
 * template (invariant 6); and a template is reachable through no generic
 * evaluation route, no poll route, and — for its creator — not through the
 * owned-poll door that `classroom_id is null` used to open alone.
 */
import { randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EvaluationTemplate,
  PoolInUse,
  TemplateInstance,
  TemplatePoolUnlinked,
} from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import {
  auditLog,
  classrooms,
  coursePools,
  courseStaff,
  courses,
  evaluationItems,
  evaluations,
  isOwnedPoll,
  ownedPollSql,
  pools,
} from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { seedLive, type Seeded } from "../../test/live.js";
import { findManagedEvaluation, findReachableEvaluation } from "../guards.js";
import * as poolService from "../pool/service.js";
import * as service from "./service.js";

let server: TestServer;
let restore: () => void;
type Caller = { id: string; headers: Record<string, string> };

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
});
afterAll(async () => {
  await server.close();
  restore();
});

const call = (
  who: Caller,
  method: "GET" | "POST" | "DELETE" | "PATCH",
  url: string,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url,
    headers: who.headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

/** A course with an exam of two questions, its teacher signed in. */
async function world(): Promise<{ teacher: Caller; seed: Seeded }> {
  const teacher = await server.signIn("teacher");
  const seed = await seedLive(server.app.db, { teacherId: teacher.id });
  // Something of a run, which a template must NOT keep.
  await server.app.db
    .update(evaluations)
    .set({
      opensAt: new Date("2026-10-01T08:00:00Z"),
      closesAt: new Date("2026-10-01T10:00:00Z"),
      accessCode: "SECRET",
      ipAllowlist: ["10.0."],
    })
    .where(eq(evaluations.id, seed.evaluationId));
  return { teacher, seed };
}

async function saveTemplate(teacher: Caller, evaluationId: string): Promise<EvaluationTemplate> {
  const res = await call(teacher, "POST", `/app/api/evaluations/${evaluationId}/template`, {
    title: "Exam template",
  });
  expect(res.statusCode).toBe(201);
  return EvaluationTemplate.parse(res.json());
}

describe("the schema (ADR-031 §1)", () => {
  const base = (seed: Seeded) => ({
    id: randomUUID(),
    courseId: seed.courseId,
    title: "T",
    mode: "exam" as const,
    settings: {},
    gradingScale: {},
    feedbackPolicy: {},
    revision: 1,
  });
  const insert = (row: Record<string, unknown>) =>
    server.app.db.insert(evaluations).values(row as typeof evaluations.$inferInsert);

  it("accepts a bare template", async () => {
    const { seed } = await world();
    await expect(insert(base(seed))).resolves.toBeDefined();
  });

  it.each([
    ["an opening date", () => ({ opensAt: new Date() })],
    ["a closing date", () => ({ closesAt: new Date() })],
    ["an access code", () => ({ accessCode: "X" })],
    ["an IP list", () => ({ ipAllowlist: ["10."] })],
    ["another state than draft", () => ({ state: "running" })],
    ["the poll mode", () => ({ mode: "poll" })],
    ["no revision", () => ({ revision: null })],
    ["an origin of its own", (seed: Seeded) => ({ originTemplateId: seed.evaluationId })],
    ["a classroom as well", (seed: Seeded) => ({ classroomId: seed.classroomId })],
    // Neither a classroom nor a course, and not a poll: no home at all.
    ["no home at all (an exam)", () => ({ courseId: null, revision: null })],
  ] as const)("refuses a template with %s", async (_what, patch) => {
    const { seed } = await world();
    await expect(insert({ ...base(seed), ...patch(seed) })).rejects.toThrow();
  });
});

describe("the owned-poll predicate", () => {
  it("reads the same in SQL (ownedPollSql) and on a row (isOwnedPoll)", async () => {
    const { teacher, seed } = await world();
    const template = await saveTemplate(teacher, seed.evaluationId);
    const pollId = randomUUID();
    await server.app.db.insert(evaluations).values({
      id: pollId,
      title: "Owned poll",
      mode: "poll",
      settings: {},
      gradingScale: {},
      feedbackPolicy: {},
      createdBy: teacher.id,
    });
    const ids = [seed.evaluationId, template.id, pollId];
    const rows = await server.app.db
      .select({
        id: evaluations.id,
        classroomId: evaluations.classroomId,
        courseId: evaluations.courseId,
        mode: evaluations.mode,
        owned: sql<boolean>`${ownedPollSql()}`,
      })
      .from(evaluations)
      .where(inArray(evaluations.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Classroom evaluation, course template, owned poll.
    expect(ids.map((id) => byId.get(id)!.owned)).toEqual([false, false, true]);
    expect(ids.map((id) => isOwnedPoll(byId.get(id)!))).toEqual([false, false, true]);
  });
});

describe("save, list, instantiate, delete", () => {
  it("saves an evaluation as a template without anything of a run", async () => {
    const { teacher, seed } = await world();
    const template = await saveTemplate(teacher, seed.evaluationId);
    expect(template).toMatchObject({
      courseId: seed.courseId,
      title: "Exam template",
      mode: "exam",
      revision: 1,
      itemCount: 2,
    });
    const row = (await service.byId(server.app.db, template.id))!;
    expect(row).toMatchObject({
      classroomId: null,
      courseId: seed.courseId,
      opensAt: null,
      closesAt: null,
      accessCode: null,
      ipAllowlist: [],
      state: "draft",
      durationS: 1800,
    });
    const items = await server.app.db
      .select()
      .from(evaluationItems)
      .where(eq(evaluationItems.evaluationId, template.id));
    expect(items).toHaveLength(2);

    const listed = await call(teacher, "GET", `/app/api/courses/${seed.courseId}/templates`);
    expect(listed.statusCode).toBe(200);
    expect(EvaluationTemplate.array().parse(listed.json()).map((t) => t.id)).toEqual([template.id]);

    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.subjectId, template.id));
    expect(entry?.action).toBe("template.create");
  });

  it("refuses to save a poll as a template (422)", async () => {
    const { teacher, seed } = await world();
    const { evaluation } = await service.createPollEvaluation(server.app.db, {
      classroomId: seed.classroomId,
      title: "Poll",
      createdBy: teacher.id,
      questionId: seed.questionIds[0]!,
      accessCode: `P${randomUUID().slice(0, 5).toUpperCase()}`,
      defaultPoints: () => 1,
      now: server.clock.now(),
    });
    const res = await call(teacher, "POST", `/app/api/evaluations/${evaluation.id}/template`, {
      title: "No",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "template_poll" });
  });

  it("instantiates into a classroom of the same course, recording the origin", async () => {
    const { teacher, seed } = await world();
    const template = await saveTemplate(teacher, seed.evaluationId);
    const res = await call(teacher, "POST", `/app/api/templates/${template.id}/instances`, {
      classroomId: seed.classroomId,
    });
    expect(res.statusCode).toBe(201);
    const made = TemplateInstance.parse(res.json());
    expect(made.deprecatedItems).toEqual([]);
    expect(made.evaluation).toMatchObject({
      classroomId: seed.classroomId,
      title: "Exam template",
      state: "draft",
      opensAt: null,
      accessCode: null,
    });
    const row = (await service.byId(server.app.db, made.evaluation.id))!;
    expect(row).toMatchObject({ originTemplateId: template.id, originRevision: 1, courseId: null });
  });

  it("warns on a deprecated version and blocks on a pool no longer linked", async () => {
    const { teacher, seed } = await world();
    const template = await saveTemplate(teacher, seed.evaluationId);
    await poolService.deprecateVersion(server.app.db, seed.questionIds[1]!, 1, "wrong key");
    const warned = TemplateInstance.parse(
      (
        await call(teacher, "POST", `/app/api/templates/${template.id}/instances`, {
          classroomId: seed.classroomId,
        })
      ).json(),
    );
    expect(warned.deprecatedItems.map((i) => i.questionId)).toEqual([seed.questionIds[1]]);

    await server.app.db.delete(coursePools).where(eq(coursePools.courseId, seed.courseId));
    const blocked = await call(teacher, "POST", `/app/api/templates/${template.id}/instances`, {
      classroomId: seed.classroomId,
    });
    expect(blocked.statusCode).toBe(422);
    const body = TemplatePoolUnlinked.parse(blocked.json());
    expect(body.items.map((i) => i.position)).toEqual([0, 1]);
  });

  it("refuses a classroom of another course, even one the caller teaches (404)", async () => {
    const { teacher, seed } = await world();
    const other = await seedLive(server.app.db, { teacherId: teacher.id });
    const template = await saveTemplate(teacher, seed.evaluationId);
    const res = await call(teacher, "POST", `/app/api/templates/${template.id}/instances`, {
      classroomId: other.classroomId,
    });
    expect(res.statusCode).toBe(404);
  });

  it("deletes a template and leaves its instances running, unlinked", async () => {
    const { teacher, seed } = await world();
    const template = await saveTemplate(teacher, seed.evaluationId);
    const made = TemplateInstance.parse(
      (
        await call(teacher, "POST", `/app/api/templates/${template.id}/instances`, {
          classroomId: seed.classroomId,
        })
      ).json(),
    );
    expect((await call(teacher, "DELETE", `/app/api/templates/${template.id}`)).statusCode).toBe(204);
    const instance = (await service.byId(server.app.db, made.evaluation.id))!;
    expect(instance.originTemplateId).toBeNull();
    expect(instance.originRevision).toBe(1);
    expect((await call(teacher, "GET", `/app/api/evaluations/${instance.id}`)).statusCode).toBe(200);
  });

  it("leaves the instance unchanged when the template is edited, then deleted", async () => {
    const { teacher, seed } = await world();
    const template = await saveTemplate(teacher, seed.evaluationId);
    const made = TemplateInstance.parse(
      (
        await call(teacher, "POST", `/app/api/templates/${template.id}/instances`, {
          classroomId: seed.classroomId,
        })
      ).json(),
    );
    const instanceId = made.evaluation.id;
    const itemsOf = (evaluationId: string) =>
      server.app.db
        .select()
        .from(evaluationItems)
        .where(eq(evaluationItems.evaluationId, evaluationId))
        .orderBy(evaluationItems.position);
    const before = { row: await service.byId(server.app.db, instanceId), items: await itemsOf(instanceId) };

    // Edited in place through its own routes (F-EVAL-25).
    expect(
      (await call(teacher, "PATCH", `/app/api/templates/${template.id}`, { durationS: 60 })).statusCode,
    ).toBe(200);
    const [templateItem] = await itemsOf(template.id);
    expect(
      (
        await call(teacher, "PATCH", `/app/api/templates/${template.id}/items/${templateItem!.id}`, {
          points: 42,
        })
      ).statusCode,
    ).toBe(200);
    expect((await service.byId(server.app.db, template.id))!.revision).toBe(3);
    expect(await service.byId(server.app.db, instanceId)).toEqual(before.row);
    expect(await itemsOf(instanceId)).toEqual(before.items);

    expect((await call(teacher, "DELETE", `/app/api/templates/${template.id}`)).statusCode).toBe(204);
    expect(await service.byId(server.app.db, template.id)).toBeNull();
    expect(await service.byId(server.app.db, instanceId)).toEqual({ ...before.row, originTemplateId: null });
    expect(await itemsOf(instanceId)).toEqual(before.items);
  });

  it("goes with its course, and survives the classroom it was saved from", async () => {
    const { teacher, seed } = await world();
    const template = await saveTemplate(teacher, seed.evaluationId);
    await server.app.db.delete(classrooms).where(eq(classrooms.id, seed.classroomId));
    expect(await service.byId(server.app.db, template.id)).not.toBeNull();
    await server.app.db.delete(courses).where(eq(courses.id, seed.courseId));
    expect(await service.byId(server.app.db, template.id)).toBeNull();
  });
});

describe("access (invariant 6)", () => {
  it("answers every template route with the 404 of a missing template to a teacher off the staff", async () => {
    const { teacher, seed } = await world();
    const template = await saveTemplate(teacher, seed.evaluationId);
    const outsider = await server.signIn("teacher");
    // The outsider teaches a classroom of their own, which must not help.
    const theirs = await seedLive(server.app.db, { teacherId: outsider.id });

    const probes = (id: string, courseId: string) =>
      [
        ["GET", `/app/api/courses/${courseId}/templates`, undefined],
        ["DELETE", `/app/api/templates/${id}`, undefined],
        ["POST", `/app/api/templates/${id}/instances`, { classroomId: theirs.classroomId }],
        ["POST", `/app/api/templates/${id}/instances`, { classroomId: seed.classroomId }],
      ] as const;
    for (const [method, url, body] of probes(template.id, seed.courseId)) {
      const hit = await call(outsider, method, url, body);
      const miss = await call(
        outsider,
        method,
        url.replace(template.id, randomUUID()).replace(seed.courseId, randomUUID()),
        body,
      );
      expect([method, url, hit.statusCode]).toEqual([method, url, 404]);
      expect(hit.json()).toEqual(miss.json());
    }
    // Saving someone else's evaluation as a template is the evaluation's 404.
    expect(
      (await call(outsider, "POST", `/app/api/evaluations/${seed.evaluationId}/template`, { title: "x" }))
        .statusCode,
    ).toBe(404);
    // And the template is still there.
    expect(await service.byId(server.app.db, template.id)).not.toBeNull();
  });

  it("lets every member of the course's staff manage its templates", async () => {
    const { teacher, seed } = await world();
    const template = await saveTemplate(teacher, seed.evaluationId);
    const colleague = await server.signIn("teacher");
    await server.app.db.insert(courseStaff).values({ courseId: seed.courseId, userId: colleague.id });
    const listed = await call(colleague, "GET", `/app/api/courses/${seed.courseId}/templates`);
    expect(listed.json()).toHaveLength(1);
    expect((await call(colleague, "DELETE", `/app/api/templates/${template.id}`)).statusCode).toBe(204);
  });

  it("never reaches a template through a generic evaluation route, a poll route or the owned-poll door", async () => {
    const { teacher, seed } = await world();
    const template = await saveTemplate(teacher, seed.evaluationId);
    const id = template.id;

    // Its creator, through the finders the poll module and the stream use —
    // and an admin, whom `accessWhere` lets past every ownership test: the
    // owned-poll shape alone must keep a template out.
    const admin = await server.signIn("admin");
    const asTeacher = { id: teacher.id, role: "teacher" };
    expect(await findManagedEvaluation(server.app.db, asTeacher, id)).toBeNull();
    expect(await findReachableEvaluation(server.app.db, asTeacher, id)).toBeNull();
    expect(await findManagedEvaluation(server.app.db, { id: admin.id, role: "admin" }, id)).toBeNull();
    for (const [method, url] of [
      ["GET", `/app/api/evaluations/${id}/poll`],
      ["POST", `/app/api/evaluations/${id}/poll/end`],
    ] as const) {
      const res = await call(admin, method, url, method === "GET" ? undefined : {});
      expect([method, url, res.statusCode]).toEqual([method, url, 404]);
    }

    for (const [method, url] of [
      ["GET", `/app/api/evaluations/${id}`],
      ["GET", `/app/api/evaluations/${id}/pools`],
      ["PATCH", `/app/api/evaluations/${id}`],
      ["POST", `/app/api/evaluations/${id}/duplicate`],
      ["POST", `/app/api/evaluations/${id}/template`],
      ["GET", `/app/api/evaluations/${id}/poll`],
      ["POST", `/app/api/evaluations/${id}/poll/reveal`],
      ["POST", `/app/api/evaluations/${id}/poll/end`],
      ["POST", `/app/api/evaluations/${id}/poll/again`],
      ["POST", `/app/api/evaluations/${id}/poll/keep`],
    ] as const) {
      const res = await call(teacher, method, url, method === "GET" ? undefined : { title: "x" });
      expect([method, url, res.statusCode]).toEqual([method, url, 404]);
    }
    // Neither in the classroom's list nor in the teacher's polls.
    const listed = (await call(teacher, "GET", `/app/api/classrooms/${seed.classroomId}/evaluations`)).json() as {
      id: string;
    }[];
    expect(listed.map((e) => e.id)).not.toContain(id);
    const polls = (await call(teacher, "GET", "/app/api/polls")).json() as unknown;
    expect(JSON.stringify(polls)).not.toContain(id);
  });
});

describe("pool deletion (F-POOL-09)", () => {
  it("is refused while an evaluation or a template pins a version, and names them", async () => {
    const { teacher, seed } = await world();
    const template = await saveTemplate(teacher, seed.evaluationId);
    const res = await call(teacher, "DELETE", `/app/api/pools/${seed.poolId}`);
    expect(res.statusCode).toBe(409);
    const body = PoolInUse.parse(res.json());
    expect(body.hidden).toBe(0);
    expect(body.uses).toEqual(
      expect.arrayContaining([
        { id: seed.evaluationId, title: "Test évaluation", template: false },
        { id: template.id, title: "Exam template", template: true },
      ]),
    );

    // Once nothing pins it, the pool goes.
    await server.app.db.delete(evaluations).where(eq(evaluations.courseId, seed.courseId));
    await server.app.db.delete(evaluations).where(eq(evaluations.classroomId, seed.classroomId));
    expect((await call(teacher, "DELETE", `/app/api/pools/${seed.poolId}`)).statusCode).toBe(204);
  });

  it("reads a pinned version's foreign key as a refusal, not a 500, when the check is raced", async () => {
    const { seed } = await world();
    // Straight to the delete, as if an evaluation pinned the pool after the check.
    expect(await poolService.deletePool(server.app.db, seed.poolId)).toBe(false);
    expect(
      await server.app.db.select().from(pools).where(eq(pools.id, seed.poolId)),
    ).toHaveLength(1);
  });

  it("only counts the holders a pool owner off the course cannot open", async () => {
    const { teacher, seed } = await world();
    await saveTemplate(teacher, seed.evaluationId);
    // The pool's owner holds no seat on the course that uses it.
    const owner = await server.signIn("teacher");
    await server.app.db.update(pools).set({ ownerId: owner.id }).where(eq(pools.id, seed.poolId));
    const res = await call(owner, "DELETE", `/app/api/pools/${seed.poolId}`);
    expect(res.statusCode).toBe(409);
    expect(PoolInUse.parse(res.json())).toEqual({ error: "pool_in_use", uses: [], hidden: 2 });
  });
});
