/**
 * Creating an empty template and editing one in place (F-EVAL-24, F-EVAL-25;
 * ADR-031, addendum of 2026-09-28), over HTTP against the real migrations.
 *
 * Four things are asserted: the revision moves exactly once per request that
 * changes the content, and never for a title or a no-op; the template patch
 * refuses anything of a run with a 400; the editor sees the flags
 * *Instantiate* acts on; and the parallel routes are sealed both ways — a
 * template on no generic evaluation route, an evaluation or a poll on no
 * template route, and nobody off the course's staff anywhere (invariant 6).
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EvaluationTemplate,
  ItemPreview,
  PoolSummary,
  TemplateDetail,
  TemplateInstance,
} from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { auditLog, concepts, coursePools, courseStaff, questions } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { seedLive, type Seeded } from "../../test/live.js";
import * as conceptService from "../concept/service.js";
import * as poolService from "../pool/service.js";
import * as service from "./service.js";
import * as templates from "./templates.js";

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

type Method = "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
const call = (who: Caller, method: Method, url: string, payload?: unknown) =>
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
  return { teacher, seed };
}

/** The seeded exam, saved as a template of its course: two items. */
async function savedTemplate(teacher: Caller, seed: Seeded): Promise<TemplateDetail> {
  const res = await call(teacher, "POST", `/app/api/evaluations/${seed.evaluationId}/template`, {
    title: "Exam template",
  });
  expect(res.statusCode).toBe(201);
  return detail(teacher, EvaluationTemplate.parse(res.json()).id);
}

async function detail(teacher: Caller, id: string): Promise<TemplateDetail> {
  const res = await call(teacher, "GET", `/app/api/templates/${id}`);
  expect(res.statusCode).toBe(200);
  return TemplateDetail.parse(res.json());
}

/** A write under `/templates/:id`, expected to succeed; the detail it answers. */
async function write(teacher: Caller, method: Method, url: string, body?: unknown) {
  const res = await call(teacher, method, url, body);
  expect([url, res.statusCode, res.json()]).toMatchObject([url, 200, {}]);
  return TemplateDetail.parse(res.json());
}

/** A new published version of a seeded question (fake `short` type). */
async function republish(teacherId: string, questionId: string, answer: string): Promise<void> {
  const [question] = await server.app.db.select().from(questions).where(eq(questions.id, questionId));
  await poolService.putDraft(server.app.db, question!, {
    config: { statement: `Statement v2 of ${questionId}`, answer },
  });
  await poolService.publishQuestion(server.app.db, question!, { userId: teacherId });
}

describe("creating an empty template (F-EVAL-24)", () => {
  it("makes an empty template at revision 1 from a title, a mode and a preset", async () => {
    const { teacher, seed } = await world();
    const res = await call(teacher, "POST", `/app/api/courses/${seed.courseId}/templates`, {
      title: "TP template",
      mode: "exercise",
    });
    expect(res.statusCode).toBe(201);
    const made = EvaluationTemplate.parse(res.json());
    expect(made).toMatchObject({
      courseId: seed.courseId,
      title: "TP template",
      mode: "exercise",
      revision: 1,
      itemCount: 0,
      totalPoints: 0,
    });
    // The exercise preset, as for a classroom's creation.
    const shown = await detail(teacher, made.id);
    expect(shown.template.settings).toMatchObject({ timing: "manual", lobby: "skip" });
    expect(shown.template.feedbackPolicy.when).toBe("immediate");
    const row = (await service.byId(server.app.db, made.id))!;
    expect(row).toMatchObject({ classroomId: null, courseId: seed.courseId, state: "draft" });

    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.subjectId, made.id));
    expect(entry?.action).toBe("template.create");
    expect(entry?.payload).toEqual({ courseId: seed.courseId, title: "TP template", mode: "exercise" });

    const listed = await call(teacher, "GET", `/app/api/courses/${seed.courseId}/templates`);
    expect(EvaluationTemplate.array().parse(listed.json()).map((t) => t.id)).toContain(made.id);
  });

  it("refuses a poll (422 template_poll)", async () => {
    const { teacher, seed } = await world();
    const res = await call(teacher, "POST", `/app/api/courses/${seed.courseId}/templates`, {
      title: "Poll",
      mode: "poll",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "template_poll" });
  });

  it("is filled through its own routes, and instantiated with the revision it reached", async () => {
    const { teacher, seed } = await world();
    const made = EvaluationTemplate.parse(
      (
        await call(teacher, "POST", `/app/api/courses/${seed.courseId}/templates`, {
          title: "Filled",
          mode: "exam",
        })
      ).json(),
    );
    const pools = PoolSummary.array().parse(
      (await call(teacher, "GET", `/app/api/templates/${made.id}/pools`)).json(),
    );
    expect(pools.map((p) => p.id)).toEqual([seed.poolId]);

    const added = await write(teacher, "POST", `/app/api/templates/${made.id}/items`, {
      questionIds: seed.questionIds,
    });
    expect(added.items).toHaveLength(2);
    expect(added.template.revision).toBe(2);
    const timed = await write(teacher, "PATCH", `/app/api/templates/${made.id}`, { durationS: 600 });
    expect(timed.template).toMatchObject({ revision: 3, durationS: 600 });

    const preview = await call(
      teacher,
      "GET",
      `/app/api/templates/${made.id}/preview/items/${added.items[0]!.id}`,
    );
    expect(preview.statusCode).toBe(200);
    expect(ItemPreview.parse(preview.json()).itemId).toBe(added.items[0]!.id);

    const instance = TemplateInstance.parse(
      (
        await call(teacher, "POST", `/app/api/templates/${made.id}/instances`, {
          classroomId: seed.classroomId,
        })
      ).json(),
    );
    const row = (await service.byId(server.app.db, instance.evaluation.id))!;
    expect(row).toMatchObject({ originTemplateId: made.id, originRevision: 3, durationS: 600 });
    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, row.id), eq(auditLog.action, "template.instantiate")));
    expect(entry?.payload).toMatchObject({ templateId: made.id, revision: 3 });
  });
});

describe("the revision (ADR-031, addendum d)", () => {
  it("does not move on a title-only patch, nor on a patch that changes nothing", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    const url = `/app/api/templates/${t.template.id}`;
    const renamed = await write(teacher, "PATCH", url, { title: "Renamed" });
    expect(renamed.template).toMatchObject({ title: "Renamed", revision: 1 });
    const same = await write(teacher, "PATCH", url, {
      settings: { navigation: t.template.settings.navigation },
      durationS: t.template.durationS,
      mcqPolicy: t.template.mcqPolicy,
    });
    expect(same.template.revision).toBe(1);
    // Every write is audited, bumped or not.
    const entries = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, t.template.id), eq(auditLog.action, "template.update")));
    expect(entries.map((e) => e.payload)).toEqual([
      { fields: ["title"], revised: false, revision: 1 },
      { fields: ["settings", "mcqPolicy", "durationS"], revised: false, revision: 1 },
    ]);
  });

  it("moves once for a patch of the title and a setting", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    const next = await write(teacher, "PATCH", `/app/api/templates/${t.template.id}`, {
      title: "Both",
      settings: { shuffleItems: !t.template.settings.shuffleItems },
      feedbackPolicy: { showKey: !t.template.feedbackPolicy.showKey },
    });
    expect(next.template).toMatchObject({ title: "Both", revision: 2 });
  });

  it("moves once per item write that changes something, and not for one that does not", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    const base = `/app/api/templates/${t.template.id}`;
    const [first, second] = t.items;

    const pointed = await write(teacher, "PATCH", `${base}/items/${first!.id}`, { points: 7 });
    expect(pointed.template.revision).toBe(2);
    expect(pointed.items[0]!.points).toBe(7);
    const samePoints = await write(teacher, "PATCH", `${base}/items/${first!.id}`, { points: 7 });
    expect(samePoints.template.revision).toBe(2);
    const milestone = await write(teacher, "PATCH", `${base}/items/${first!.id}`, { milestone: true });
    expect(milestone.template.revision).toBe(3);

    const sameOrder = await write(teacher, "PUT", `${base}/items/order`, {
      itemIds: [first!.id, second!.id],
    });
    expect(sameOrder.template.revision).toBe(3);
    const swapped = await write(teacher, "PUT", `${base}/items/order`, {
      itemIds: [second!.id, first!.id],
    });
    expect(swapped.template.revision).toBe(4);
    expect(swapped.items.map((i) => i.id)).toEqual([second!.id, first!.id]);

    const nothingStale = await write(teacher, "POST", `${base}/items/update-versions`);
    expect(nothingStale.template.revision).toBe(4);

    const removed = await write(teacher, "DELETE", `${base}/items/${first!.id}`);
    expect(removed.template.revision).toBe(5);
    expect(removed.items.map((i) => [i.id, i.position])).toEqual([[second!.id, 0]]);
    const removedAgain = await write(teacher, "DELETE", `${base}/items/${first!.id}`);
    expect(removedAgain.template.revision).toBe(5);

    const added = await write(teacher, "POST", `${base}/items`, { questionIds: [seed.questionIds[0]] });
    expect(added.template.revision).toBe(6);
    expect(added.template.itemCount).toBe(2);
  });

  it("moves once when every stale item is updated to its latest version", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    await republish(seed.teacherId, seed.questionIds[0]!, "v2-a");
    await republish(seed.teacherId, seed.questionIds[1]!, "v2-b");
    const stale = await detail(teacher, t.template.id);
    expect(stale.staleItems.sort()).toEqual(t.items.map((i) => i.id).sort());

    const updated = await write(teacher, "POST", `/app/api/templates/${t.template.id}/items/update-versions`, {});
    expect(updated.template.revision).toBe(2);
    expect(updated.staleItems).toEqual([]);
    expect(updated.items.map((i) => i.versionNumber)).toEqual([2, 2]);
  });

  it("changes nothing and moves nothing when a write is refused", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    // The in-class rule on `immediate` feedback holds on a template (F-EVAL-11).
    const refused = await call(teacher, "PATCH", `/app/api/templates/${t.template.id}`, {
      title: "Not kept",
      feedbackPolicy: { when: "immediate" },
    });
    expect(refused.statusCode).toBe(422);
    expect((await detail(teacher, t.template.id)).template).toMatchObject({
      title: "Exam template",
      revision: 1,
    });
  });
});

describe("the template patch (ADR-031, addendum c)", () => {
  it.each([
    ["an opening date", { opensAt: "2026-10-01T08:00:00.000Z" }],
    ["a closing date", { closesAt: "2026-10-01T10:00:00.000Z" }],
    ["an access code", { accessCode: "SECRET" }],
    ["an IP list", { ipAllowlist: ["10.0."] }],
    ["an unknown key", { state: "running" }],
  ])("refuses %s with a 400, and writes nothing", async (_what, body) => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    const res = await call(teacher, "PATCH", `/app/api/templates/${t.template.id}`, {
      title: "Not kept",
      ...body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation" });
    expect((await detail(teacher, t.template.id)).template.title).toBe("Exam template");
  });

  it("refuses an empty patch with a 400", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    const res = await call(teacher, "PATCH", `/app/api/templates/${t.template.id}`, {});
    expect(res.statusCode).toBe(400);
  });

  it("draws only from the course's linked pools (422 question_not_in_course)", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    const elsewhere = await seedLive(server.app.db, { teacherId: teacher.id });
    const res = await call(teacher, "POST", `/app/api/templates/${t.template.id}/items`, {
      questionIds: [elsewhere.questionIds[0]],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "question_not_in_course" });
    expect((await detail(teacher, t.template.id)).template).toMatchObject({ revision: 1, itemCount: 2 });
  });
});

describe("a template deleted under a write", () => {
  it("is refused as a missing template, and bumps nothing", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    const row = (await service.byId(server.app.db, t.template.id))!;
    await templates.deleteTemplate(server.app.db, row);
    await expect(
      templates.editTemplate(server.app.db, row, (tx, locked, ctx) =>
        service.patchEvaluation(tx, locked, { durationS: 60 }, { ...ctx, now: server.clock.now() }),
      ),
    ).rejects.toBeInstanceOf(templates.TemplateGone);
  });
});

describe("the item flags of the editor", () => {
  it("names a stale version, a deprecated one and a pool no longer linked", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    expect(t.items.map((i) => [i.deprecated, i.poolUnlinked])).toEqual([
      [false, false],
      [false, false],
    ]);
    expect(t.staleItems).toEqual([]);

    await republish(seed.teacherId, seed.questionIds[0]!, "v2");
    await poolService.deprecateVersion(server.app.db, seed.questionIds[1]!, 1, "wrong key");
    const flagged = await detail(teacher, t.template.id);
    expect(flagged.staleItems).toEqual([t.items[0]!.id]);
    expect(flagged.items[0]).toMatchObject({ versionNumber: 1, latestVersionNumber: 2 });
    expect(flagged.items.map((i) => i.deprecated)).toEqual([false, true]);

    await server.app.db.delete(coursePools).where(eq(coursePools.courseId, seed.courseId));
    const unlinked = await detail(teacher, t.template.id);
    expect(unlinked.items.map((i) => i.poolUnlinked)).toEqual([true, true]);
  });

  it("carries each question's difficulty and concepts, in the reader's language", async () => {
    const { teacher, seed } = await world();
    const [first, second] = seed.questionIds as [string, string];
    const conceptId = randomUUID();
    await server.app.db.insert(concepts).values({
      id: conceptId,
      status: "validated",
      labelFr: "Pointeur",
      keyFr: "pointeur",
      labelEn: "Pointer",
      keyEn: "pointer",
    });
    await conceptService.setQuestionConcepts(server.app.db, first, [conceptId]);
    await server.app.db.update(questions).set({ difficulty: 4 }).where(eq(questions.id, second));

    const t = await savedTemplate(teacher, seed);
    expect(t.items.map((i) => i.difficulty)).toEqual([2, 4]);
    expect(t.concepts[first]!.map((c) => c.label)).toEqual(["Pointer"]);
    expect(t.concepts[second]).toEqual([]);
  });
});

describe("access (invariant 6)", () => {
  /** Every route of the template editor, for a template id and one of its items. */
  const templateRoutes = (id: string, itemId: string, courseId: string) =>
    [
      ["POST", `/app/api/courses/${courseId}/templates`, { title: "x", mode: "exam" }],
      ["GET", `/app/api/templates/${id}`, undefined],
      ["GET", `/app/api/templates/${id}/pools`, undefined],
      ["PATCH", `/app/api/templates/${id}`, { title: "x" }],
      ["POST", `/app/api/templates/${id}/items`, { questionIds: [randomUUID()] }],
      ["PATCH", `/app/api/templates/${id}/items/${itemId}`, { points: 1 }],
      ["PUT", `/app/api/templates/${id}/items/order`, { itemIds: [itemId] }],
      ["DELETE", `/app/api/templates/${id}/items/${itemId}`, undefined],
      ["POST", `/app/api/templates/${id}/items/update-versions`, {}],
      ["GET", `/app/api/templates/${id}/preview/items/${itemId}`, undefined],
      ["GET", `/app/api/templates/${id}/preview/items/${itemId}/solution`, undefined],
    ] as const;

  it("answers a teacher off the staff the 404 of a missing template, on every route", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    const outsider = await server.signIn("teacher");
    await seedLive(server.app.db, { teacherId: outsider.id });
    for (const [method, url, body] of templateRoutes(t.template.id, t.items[0]!.id, seed.courseId)) {
      const hit = await call(outsider, method, url, body);
      const miss = await call(
        outsider,
        method,
        url.replace(t.template.id, randomUUID()).replace(seed.courseId, randomUUID()),
        body,
      );
      expect([method, url, hit.statusCode]).toEqual([method, url, 404]);
      expect(hit.json()).toEqual(miss.json());
    }
    const after = await detail(teacher, t.template.id);
    expect(after.template).toMatchObject({ title: "Exam template", revision: 1, itemCount: 2 });
  });

  it("answers a student the same refusal for a template as for none", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    const student = await server.signIn("student");
    for (const [method, url, body] of templateRoutes(t.template.id, t.items[0]!.id, seed.courseId)) {
      const hit = await call(student, method, url, body);
      const miss = await call(
        student,
        method,
        url.replace(t.template.id, randomUUID()).replace(seed.courseId, randomUUID()),
        body,
      );
      // `teacherGuard` refuses the role before any entity is looked up.
      expect([method, url, hit.statusCode]).toEqual([method, url, 403]);
      expect(hit.json()).toEqual(miss.json());
    }
  });

  it("lets a colleague on the course's staff edit it", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    const colleague = await server.signIn("teacher");
    await server.app.db.insert(courseStaff).values({ courseId: seed.courseId, userId: colleague.id });
    const next = await write(colleague, "PATCH", `/app/api/templates/${t.template.id}`, { durationS: 90 });
    expect(next.template.revision).toBe(2);
  });

  it("reaches a template through no generic evaluation route", async () => {
    const { teacher, seed } = await world();
    const t = await savedTemplate(teacher, seed);
    const id = t.template.id;
    const itemId = t.items[0]!.id;
    const attemptId = randomUUID();
    const routes = [
      // The editor's.
      ["GET", `/app/api/evaluations/${id}`],
      ["PATCH", `/app/api/evaluations/${id}`],
      ["DELETE", `/app/api/evaluations/${id}`],
      ["GET", `/app/api/evaluations/${id}/pools`],
      ["POST", `/app/api/evaluations/${id}/items`],
      ["PATCH", `/app/api/evaluations/${id}/items/${itemId}`],
      ["PUT", `/app/api/evaluations/${id}/items/order`],
      ["DELETE", `/app/api/evaluations/${id}/items/${itemId}`],
      ["POST", `/app/api/evaluations/${id}/items/update-versions`],
      ["POST", `/app/api/evaluations/${id}/state`],
      ["POST", `/app/api/evaluations/${id}/duplicate`],
      ["POST", `/app/api/evaluations/${id}/template`],
      // Preview.
      ["POST", `/app/api/evaluations/${id}/preview`],
      ["GET", `/app/api/evaluations/${id}/preview/items/${itemId}`],
      ["GET", `/app/api/evaluations/${id}/preview/items/${itemId}/solution`],
      ["POST", `/app/api/evaluations/${id}/preview/run`],
      ["POST", `/app/api/evaluations/${id}/preview/simulate`],
      ["POST", `/app/api/evaluations/${id}/preview/grade`],
      // Live and dashboard.
      ["GET", `/app/api/evaluations/${id}/dashboard`],
      ["POST", `/app/api/evaluations/${id}/start`],
      ["POST", `/app/api/evaluations/${id}/pause`],
      ["POST", `/app/api/evaluations/${id}/resume`],
      ["POST", `/app/api/evaluations/${id}/close`],
      ["POST", `/app/api/evaluations/${id}/extend`],
      ["POST", `/app/api/evaluations/${id}/attempt`],
      ["DELETE", `/app/api/evaluations/${id}/attempt`],
      ["POST", `/app/api/evaluations/${id}/retake`],
      ["GET", `/app/api/evaluations/${id}/seb`],
      ["GET", `/app/api/evaluations/${id}/attempts/${attemptId}`],
      ["POST", `/app/api/evaluations/${id}/attempts/${attemptId}/close`],
      ["POST", `/app/api/evaluations/${id}/attempts/${attemptId}/reopen`],
      // Poll.
      ["GET", `/app/api/evaluations/${id}/poll`],
      ["POST", `/app/api/evaluations/${id}/poll/reveal`],
      ["POST", `/app/api/evaluations/${id}/poll/end`],
      ["POST", `/app/api/evaluations/${id}/poll/again`],
      ["POST", `/app/api/evaluations/${id}/poll/keep`],
      // Grading.
      ["GET", `/app/api/evaluations/${id}/grading`],
      ["POST", `/app/api/evaluations/${id}/grading/run`],
      ["GET", `/app/api/evaluations/${id}/grading/progress`],
      ["GET", `/app/api/evaluations/${id}/grading/steps`],
      ["POST", `/app/api/evaluations/${id}/grading/validate-batch`],
      ["GET", `/app/api/evaluations/${id}/items/${itemId}/versions`],
      ["POST", `/app/api/evaluations/${id}/items/${itemId}/regrade`],
      // Results.
      ["GET", `/app/api/evaluations/${id}/results`],
      ["GET", `/app/api/evaluations/${id}/results.csv`],
      ["GET", `/app/api/evaluations/${id}/results/by-question`],
      ["POST", `/app/api/evaluations/${id}/release`],
      ["POST", `/app/api/evaluations/${id}/unrelease`],
    ] as const;
    // A body each schema accepts where it can: a 404 must come from the
    // loader, not from a validation that happens to run first.
    const bodies: Record<string, unknown> = {
      PATCH: { title: "x", points: 1 },
      PUT: { itemIds: [itemId] },
    };
    for (const [method, url] of routes) {
      const body = method === "GET" || method === "DELETE" ? undefined : (bodies[method] ?? {});
      const res = await call(teacher, method, url, body);
      expect([method, url, res.statusCode]).toEqual([method, url, 404]);
    }
    // The live stream: watching a template is refused like watching nothing.
    for (const kind of ["evaluation", "lobby"]) {
      const watch = (subject: string) =>
        call(teacher, "GET", `/app/api/events?watch=${encodeURIComponent(`${kind}:${subject}`)}`);
      const [hit, miss] = [await watch(id), await watch(randomUUID())];
      expect([kind, hit.statusCode]).toEqual([kind, 404]);
      expect(hit.json()).toEqual(miss.json());
    }
    expect((await detail(teacher, id)).template).toMatchObject({ title: "Exam template", revision: 1 });
  });

  it("reaches an evaluation, a classroom poll or an owned poll through no template route", async () => {
    const { teacher, seed } = await world();
    const classroomPoll = await service.createPollEvaluation(server.app.db, {
      classroomId: seed.classroomId,
      title: "Poll",
      createdBy: teacher.id,
      questionId: seed.questionIds[0]!,
      accessCode: `P${randomUUID().slice(0, 5).toUpperCase()}`,
      defaultPoints: () => 1,
      now: server.clock.now(),
    });
    const ownedPoll = await service.createPollEvaluation(server.app.db, {
      classroomId: null,
      title: "Owned poll",
      createdBy: teacher.id,
      questionId: seed.questionIds[0]!,
      accessCode: `Q${randomUUID().slice(0, 5).toUpperCase()}`,
      defaultPoints: () => 1,
      now: server.clock.now(),
    });
    const admin = await server.signIn("admin");
    const targets = [
      [seed.evaluationId, seed.itemIds[0]!],
      [classroomPoll.evaluation.id, classroomPoll.item.id],
      [ownedPoll.evaluation.id, ownedPoll.item.id],
    ] as const;
    for (const who of [teacher, admin]) {
      for (const [id, itemId] of targets) {
        for (const [method, url, body] of templateRoutes(id, itemId, seed.courseId)) {
          if (url.startsWith("/app/api/courses/")) continue;
          const res = await call(who, method, url, body);
          expect([method, url, res.statusCode]).toEqual([method, url, 404]);
        }
        for (const [method, url, body] of [
          ["DELETE", `/app/api/templates/${id}`, undefined],
          ["POST", `/app/api/templates/${id}/instances`, { classroomId: seed.classroomId }],
        ] as const) {
          const res = await call(who, method, url, body);
          expect([method, url, res.statusCode]).toEqual([method, url, 404]);
        }
      }
    }
    // Nothing moved: the exam still has its two items and its title.
    const exam = (await service.byId(server.app.db, seed.evaluationId))!;
    expect(exam.title).toBe("Test évaluation");
    expect(await service.itemRows(server.app.db, seed.evaluationId)).toHaveLength(2);
  });
});
