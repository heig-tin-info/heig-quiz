/**
 * Pulling a template revision into an instance (F-EVAL-26, ADR-031 PR B),
 * over HTTP against the real migrations.
 *
 * What is asserted: a pull replaces the QUESTIONS and nothing else, and
 * records the revision; it is refused wherever the item list is frozen —
 * opened, or with any attempt, a teacher's own included — without touching
 * an answer; a scheduled evaluation cannot be emptied by it; the course's
 * linked pools and the deprecated versions are read as by *Instantiate*; the
 * template must still be the instance's, of the instance's own course; and
 * the route is sealed like every evaluation route (invariant 6).
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  Evaluation,
  EvaluationDetail,
  EvaluationSummary,
  EvaluationTemplate,
  TemplateInstance,
  TemplatePoolUnlinked,
  TemplatePullPreview,
  TemplatePullResult,
  TransitionRefusal,
} from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import {
  answers,
  attempts,
  auditLog,
  coursePools,
  evaluationItems,
  evaluations,
  pools,
  questions,
} from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { seedLive, type Seeded } from "../../test/live.js";
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

type Method = "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
const call = (who: Caller, method: Method, url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url,
    headers: who.headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
const db = () => server.app.db;

interface World {
  teacher: Caller;
  seed: Seeded;
  templateId: string;
  instanceId: string;
}

/**
 * The seeded exam saved as a template (rev. 1), an instance of it in the same
 * classroom — given dates, a code, an IP list and settings of its own — and
 * the template then moved to rev. 2 by a change of points.
 */
async function world(): Promise<World> {
  const teacher = await server.signIn("teacher");
  const seed = await seedLive(db(), { teacherId: teacher.id, questions: 3 });
  const saved = await call(teacher, "POST", `/app/api/evaluations/${seed.evaluationId}/template`, {
    title: "Exam template",
  });
  const templateId = EvaluationTemplate.parse(saved.json()).id;
  const made = TemplateInstance.parse(
    (
      await call(teacher, "POST", `/app/api/templates/${templateId}/instances`, {
        classroomId: seed.classroomId,
        title: "Exam, class A",
      })
    ).json(),
  );
  const instanceId = made.evaluation.id;
  const patched = await call(teacher, "PATCH", `/app/api/evaluations/${instanceId}`, {
    opensAt: "2026-11-02T08:00:00.000Z",
    accessCode: "ROOM12",
    ipAllowlist: ["10.1."],
    durationS: 3600,
    settings: { shuffleItems: true, requireFullscreen: true },
  });
  expect(patched.statusCode).toBe(200);
  await moveTemplate(teacher, templateId);
  return { teacher, seed, templateId, instanceId };
}

/** One content write to the template: the points of its first item, +1. */
async function moveTemplate(teacher: Caller, templateId: string): Promise<number> {
  const detail = (await call(teacher, "GET", `/app/api/templates/${templateId}`)).json() as {
    items: { id: string; points: number }[];
  };
  const first = detail.items[0]!;
  const res = await call(teacher, "PATCH", `/app/api/templates/${templateId}/items/${first.id}`, {
    points: first.points + 1,
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { template: { revision: number } }).template.revision;
}

const preview = async (w: World) => {
  const res = await call(w.teacher, "GET", `/app/api/evaluations/${w.instanceId}/pull-template`);
  expect(res.statusCode).toBe(200);
  return TemplatePullPreview.parse(res.json());
};
const pull = (w: World, revision = 2, who: Caller = w.teacher) =>
  call(who, "POST", `/app/api/evaluations/${w.instanceId}/pull-template`, { revision });

/** The item list of an evaluation, as the questions it plays. */
const itemsOf = async (evaluationId: string) =>
  (
    await db()
      .select()
      .from(evaluationItems)
      .where(eq(evaluationItems.evaluationId, evaluationId))
      .orderBy(evaluationItems.position)
  ).map((i) => ({
    position: i.position,
    questionVersionId: i.questionVersionId,
    points: i.points,
    milestone: i.milestone,
  }));

async function addAttempt(evaluationId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await db().insert(attempts).values({ id, evaluationId, userId, seed: 1 });
  return id;
}

describe("pulling a revision (F-EVAL-26)", () => {
  it("replaces the questions only, and records the revision", async () => {
    const w = await world();
    // A local change of the instance's questions, which the pull will replace.
    const [local] = await itemsOf(w.instanceId);
    await db()
      .update(evaluationItems)
      .set({ milestone: true })
      .where(and(eq(evaluationItems.evaluationId, w.instanceId), eq(evaluationItems.position, local!.position)));
    const before = (await service.byId(db(), w.instanceId))!;

    const res = await pull(w);
    expect(res.statusCode).toBe(200);
    const result = TemplatePullResult.parse(res.json());
    expect(result.deprecatedItems).toEqual([]);
    expect(await itemsOf(w.instanceId)).toEqual(await itemsOf(w.templateId));
    expect(result.detail.evaluation.originRevision).toBe(2);
    expect(result.detail.templateRevision).toBe(2);

    // Everything but the questions and the revision is the instance's own.
    const after = (await service.byId(db(), w.instanceId))!;
    const kept = (row: typeof after) => ({
      title: row.title,
      state: row.state,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      accessCode: row.accessCode,
      ipAllowlist: row.ipAllowlist,
      settings: row.settings,
      gradingScale: row.gradingScale,
      feedbackPolicy: row.feedbackPolicy,
      mcqPolicy: row.mcqPolicy,
      durationS: row.durationS,
      classroomId: row.classroomId,
    });
    expect(kept(after)).toEqual(kept(before));
    expect(after).toMatchObject({ originTemplateId: w.templateId, originRevision: 2 });

    const [entry] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, w.instanceId), eq(auditLog.action, "template.pull")));
    expect(entry?.payload).toEqual({ templateId: w.templateId, from: 1, to: 2 });
  });

  it("shows the two-way summary before, and nothing once pulled", async () => {
    const w = await world();
    // A local removal on the instance: the pull adds it back.
    const detail = EvaluationDetail.parse(
      (await call(w.teacher, "GET", `/app/api/evaluations/${w.instanceId}`)).json(),
    );
    expect(detail.templateRevision).toBe(2);
    expect(detail.evaluation.originRevision).toBe(1);
    const dropped = detail.items[2]!;
    expect(
      (await call(w.teacher, "DELETE", `/app/api/evaluations/${w.instanceId}/items/${dropped.id}`)).statusCode,
    ).toBe(204);

    const before = await preview(w);
    expect(before).toMatchObject({ templateId: w.templateId, from: 1, to: 2, reordered: false });
    expect(before.added.map((i) => i.questionId)).toEqual([dropped.questionId]);
    expect(before.removed).toEqual([]);
    expect(before.changed).toHaveLength(1);
    expect(before.changed[0]!.to.points).toBe(before.changed[0]!.from.points + 1);
    expect(before.unlinkedItems).toEqual([]);

    expect((await pull(w)).statusCode).toBe(200);
    const after = await preview(w);
    expect(after).toMatchObject({ from: 2, to: 2, added: [], removed: [], changed: [], reordered: false });
  });

  it("lists the instance as behind its template on the classroom's list, and not once pulled", async () => {
    const w = await world();
    const row = async () =>
      EvaluationSummary.array()
        .parse((await call(w.teacher, "GET", `/app/api/classrooms/${w.seed.classroomId}/evaluations`)).json())
        .find((r) => r.id === w.instanceId)!;
    expect(await row()).toMatchObject({ originRevision: 1, templateRevision: 2 });
    expect((await pull(w)).statusCode).toBe(200);
    expect(await row()).toMatchObject({ originRevision: 2, templateRevision: 2 });
    // The evaluation the template was saved from is linked to it at rev. 1
    // (F-EVAL-18), and behind it like any instance.
    const source = EvaluationSummary.array()
      .parse((await call(w.teacher, "GET", `/app/api/classrooms/${w.seed.classroomId}/evaluations`)).json())
      .find((r) => r.id === w.seed.evaluationId)!;
    expect(source).toMatchObject({ originRevision: 1, templateRevision: 2 });
  });

  it("records only the revision when the template moved in its settings alone", async () => {
    const w = await world();
    expect((await pull(w)).statusCode).toBe(200);
    const res = await call(w.teacher, "PATCH", `/app/api/templates/${w.templateId}`, { durationS: 900 });
    expect((res.json() as { template: { revision: number } }).template.revision).toBe(3);
    const summary = await preview(w);
    expect(summary).toMatchObject({ from: 2, to: 3, added: [], removed: [], changed: [], reordered: false });
    const items = await itemsOf(w.instanceId);
    expect((await pull(w, 3)).statusCode).toBe(200);
    expect(await itemsOf(w.instanceId)).toEqual(items);
    // The template's duration is the template's: the instance keeps its own.
    expect((await service.byId(db(), w.instanceId))!).toMatchObject({ originRevision: 3, durationS: 3600 });
  });

  it("refuses a revision other than the one confirmed (409 template_moved)", async () => {
    const w = await world();
    await moveTemplate(w.teacher, w.templateId);
    const res = await pull(w, 2);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "template_moved", revision: 3 });
    expect((await service.byId(db(), w.instanceId))!.originRevision).toBe(1);
  });

  it("pulls into a scheduled evaluation, which stays scheduled", async () => {
    const w = await world();
    const moved = await call(w.teacher, "POST", `/app/api/evaluations/${w.instanceId}/state`, { to: "scheduled" });
    expect(moved.statusCode).toBe(200);
    const res = await pull(w);
    expect(res.statusCode).toBe(200);
    expect(TemplatePullResult.parse(res.json()).detail.evaluation.state).toBe("scheduled");
  });

  it("refuses to empty a scheduled evaluation (409 no_items)", async () => {
    const w = await world();
    expect(
      (await call(w.teacher, "POST", `/app/api/evaluations/${w.instanceId}/state`, { to: "scheduled" })).statusCode,
    ).toBe(200);
    const template = (await call(w.teacher, "GET", `/app/api/templates/${w.templateId}`)).json() as {
      items: { id: string }[];
    };
    let revision = 2;
    for (const item of template.items) {
      const res = await call(w.teacher, "DELETE", `/app/api/templates/${w.templateId}/items/${item.id}`);
      revision = (res.json() as { template: { revision: number } }).template.revision;
    }
    const before = await itemsOf(w.instanceId);
    const res = await pull(w, revision);
    expect(res.statusCode).toBe(409);
    expect(TransitionRefusal.parse(res.json()).reason).toBe("no_items");
    expect(await itemsOf(w.instanceId)).toEqual(before);
    // A draft may be emptied: it is not ready for anything yet, and says so.
    expect(
      (await call(w.teacher, "POST", `/app/api/evaluations/${w.instanceId}/state`, { to: "draft" })).statusCode,
    ).toBe(200);
    expect((await pull(w, revision)).statusCode).toBe(200);
    expect(await itemsOf(w.instanceId)).toEqual([]);
  });

  it.each(["lobby", "running", "closed"] as const)(
    "refuses once the evaluation was opened (%s, 409 items_frozen)",
    async (state) => {
      const w = await world();
      await db().update(evaluations).set({ state }).where(eq(evaluations.id, w.instanceId));
      const before = await itemsOf(w.instanceId);
      const res = await pull(w);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "items_frozen" });
      expect(await itemsOf(w.instanceId)).toEqual(before);
    },
  );

  it.each([
    ["a student's", (w: World) => w.seed.studentIds[0]!],
    ["the teacher's own test (ADR-018)", (w: World) => w.teacher.id],
  ] as const)("refuses with %s attempt, and deletes no answer (409 locked)", async (_who, userOf) => {
    const w = await world();
    const attemptId = await addAttempt(w.instanceId, userOf(w));
    const [first] = await db()
      .select()
      .from(evaluationItems)
      .where(eq(evaluationItems.evaluationId, w.instanceId))
      .limit(1);
    await db().insert(answers).values({ id: randomUUID(), attemptId, itemId: first!.id, payload: { text: "x" } });

    const res = await pull(w);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "locked" });
    expect(await db().select().from(answers).where(eq(answers.attemptId, attemptId))).toHaveLength(1);
    expect((await service.byId(db(), w.instanceId))!.originRevision).toBe(1);
  });

  it("blocks on a pool no longer linked to the course, naming the items (422)", async () => {
    const w = await world();
    // A question of a second pool, added to the template, then that pool unlinked.
    const otherPool = randomUUID();
    await db().insert(pools).values({ id: otherPool, name: "Other", ownerId: w.teacher.id });
    await db().insert(coursePools).values({ courseId: w.seed.courseId, poolId: otherPool });
    const { id: questionId } = await poolService.createQuestion(db(), {
      poolId: otherPool,
      type: "short",
      internalName: "elsewhere",
      createdBy: w.teacher.id,
    });
    const [question] = await db().select().from(questions).where(eq(questions.id, questionId));
    await poolService.putDraft(db(), question!, { config: { statement: "S", answer: "a" } });
    await poolService.publishQuestion(db(), question!, { userId: w.teacher.id });
    const added = await call(w.teacher, "POST", `/app/api/templates/${w.templateId}/items`, {
      questionIds: [questionId],
    });
    const revision = (added.json() as { template: { revision: number } }).template.revision;
    await db()
      .delete(coursePools)
      .where(and(eq(coursePools.courseId, w.seed.courseId), eq(coursePools.poolId, otherPool)));

    expect((await preview(w)).unlinkedItems.map((i) => i.questionId)).toEqual([questionId]);
    const before = await itemsOf(w.instanceId);
    const res = await pull(w, revision);
    expect(res.statusCode).toBe(422);
    expect(TemplatePoolUnlinked.parse(res.json()).items.map((i) => i.internalName)).toEqual(["elsewhere"]);
    expect(await itemsOf(w.instanceId)).toEqual(before);
  });

  it("warns on a deprecated version, and pulls all the same", async () => {
    const w = await world();
    await poolService.deprecateVersion(db(), w.seed.questionIds[1]!, 1, "wrong key");
    expect((await preview(w)).deprecatedItems.map((i) => i.questionId)).toEqual([w.seed.questionIds[1]]);
    const res = await pull(w);
    expect(res.statusCode).toBe(200);
    expect(TemplatePullResult.parse(res.json()).deprecatedItems.map((i) => i.questionId)).toEqual([
      w.seed.questionIds[1],
    ]);
  });

  it("refuses an evaluation whose template was deleted, or that has none (409 no_template)", async () => {
    const w = await world();
    expect((await call(w.teacher, "DELETE", `/app/api/templates/${w.templateId}`)).statusCode).toBe(204);
    for (const res of [
      await pull(w),
      await call(w.teacher, "GET", `/app/api/evaluations/${w.instanceId}/pull-template`),
      await call(w.teacher, "POST", `/app/api/evaluations/${w.seed.evaluationId}/pull-template`, { revision: 1 }),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "no_template" });
    }
    const detail = EvaluationDetail.parse(
      (await call(w.teacher, "GET", `/app/api/evaluations/${w.instanceId}`)).json(),
    );
    expect(detail.templateRevision).toBeNull();
    expect(detail.evaluation.originRevision).toBe(1);
    expect((await service.byId(db(), w.instanceId))!.originTemplateId).toBeNull();
  });

  it("reads a template of another course as no template at all", async () => {
    const w = await world();
    const other = await seedLive(db(), { teacherId: w.teacher.id });
    const foreign = EvaluationTemplate.parse(
      (
        await call(w.teacher, "POST", `/app/api/evaluations/${other.evaluationId}/template`, { title: "Foreign" })
      ).json(),
    );
    // Only a direct write could make this origin: no route ever records one.
    await db().update(evaluations).set({ originTemplateId: foreign.id }).where(eq(evaluations.id, w.instanceId));
    const res = await pull(w, 1);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "no_template" });
    expect(
      EvaluationDetail.parse((await call(w.teacher, "GET", `/app/api/evaluations/${w.instanceId}`)).json())
        .templateRevision,
    ).toBeNull();
  });

  it("answers a teacher off the course, and a template id, with the 404 of a missing evaluation", async () => {
    const w = await world();
    const outsider = await server.signIn("teacher");
    await seedLive(db(), { teacherId: outsider.id });
    for (const [method, url, body] of [
      ["GET", `/app/api/evaluations/${w.instanceId}/pull-template`, undefined],
      ["POST", `/app/api/evaluations/${w.instanceId}/pull-template`, { revision: 2 }],
    ] as const) {
      const hit = await call(outsider, method, url, body);
      const miss = await call(outsider, method, url.replace(w.instanceId, randomUUID()), body);
      expect([method, hit.statusCode]).toEqual([method, 404]);
      expect(hit.json()).toEqual(miss.json());
      // The template itself is not an evaluation: its id is no way in either.
      const asTemplate = await call(w.teacher, method, url.replace(w.instanceId, w.templateId), body);
      expect(asTemplate.statusCode).toBe(404);
    }
    expect((await service.byId(db(), w.instanceId))!.originRevision).toBe(1);
  });

  it("keeps a duplicate of an instance without an origin", async () => {
    const w = await world();
    const res = await call(w.teacher, "POST", `/app/api/evaluations/${w.instanceId}/duplicate`, { title: "Copy" });
    expect(res.statusCode).toBe(201);
    const copy = Evaluation.parse(res.json());
    expect(copy.originRevision).toBeNull();
    expect((await service.byId(db(), copy.id))!.originTemplateId).toBeNull();
  });
});

describe("concurrency", () => {
  /*
   * PGlite is one connection: its transactions run one after the other, so
   * this test proves that the interleaving completes with a consistent
   * result, not that PostgreSQL's row locks never deadlock. That half is the
   * lock ORDER (template, then instance), which `pullTemplate` shares with
   * `deleteTemplate` and `editTemplate`, and which ADR-031 records.
   */
  it("lets a pull and an edit of the template both complete", async () => {
    const w = await world();
    const [pulled, edited] = await Promise.all([pull(w), moveTemplate(w.teacher, w.templateId)]);
    expect(edited).toBe(3);
    const instance = (await service.byId(db(), w.instanceId))!;
    if (pulled.statusCode === 200) {
      expect(instance.originRevision).toBe(2);
    } else {
      // The edit came first: the confirmed revision is gone, nothing moved.
      expect(pulled.json()).toMatchObject({ error: "template_moved", revision: 3 });
      expect(instance.originRevision).toBe(1);
    }
  });
});

describe("the ticker (F-EVAL-23)", () => {
  it("still opens a scheduled evaluation that was pulled, with the pulled questions", async () => {
    const w = await world();
    expect(
      (await call(w.teacher, "POST", `/app/api/evaluations/${w.instanceId}/state`, { to: "scheduled" })).statusCode,
    ).toBe(200);
    expect((await pull(w)).statusCode).toBe(200);
    const { autoOpenScheduled } = await import("../live/ticker.js");
    const moved = await autoOpenScheduled(db(), new Date("2026-11-02T08:00:01.000Z"));
    expect(moved.map((r) => r.id)).toContain(w.instanceId);
    expect(await itemsOf(w.instanceId)).toEqual(await itemsOf(w.templateId));
  });
});
