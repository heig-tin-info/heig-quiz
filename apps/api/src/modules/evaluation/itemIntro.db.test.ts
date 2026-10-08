/**
 * The text before an item (ADR-084, F-EVAL-34), over HTTP against the real
 * migrations.
 *
 * What is asserted: the intro is written through the item routes, a blank
 * text clears it and an oversized one is refused; it is frozen with the item
 * list; a duplicate, *Save as template*, *Instantiate* and a pull carry it;
 * a change of it moves a template's revision and is `changed` in a pull's
 * summary; it reaches the student with the attempt and the teacher's preview
 * — and never the grading table, the dashboard, the results nor the feedback.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AttemptEntry,
  EvaluationDetail,
  EvaluationPreview,
  EvaluationTemplate,
  ITEM_INTRO_MAX,
  TemplateInstance,
  TemplatePullPreview,
} from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState } from "./service.js";

let server: TestServer;
let restore: () => void;
type Caller = { id: string; headers: Record<string, string> };
let teacher: Caller;
let student: Caller;

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

type Method = "GET" | "POST" | "PATCH" | "PUT";
const call = (who: Caller, method: Method, url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url,
    headers: who.headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
const db = () => server.app.db;

/** A marker no other payload can contain by chance. */
const INTRO = "Read chapters 8 and 9 of the handout — INTRO-MARKER-455.";

const seed = () => seedLive(db(), { teacherId: teacher.id, studentIds: [student.id], questions: 2 });

const setIntro = (evaluationId: string, itemId: string, intro: unknown) =>
  call(teacher, "PATCH", `/app/api/evaluations/${evaluationId}/items/${itemId}`, { intro });

const detailOf = async (evaluationId: string) =>
  EvaluationDetail.parse((await call(teacher, "GET", `/app/api/evaluations/${evaluationId}`)).json());

describe("writing an intro", () => {
  it("is stored through the item patch, cleared by null or a blank text, capped", async () => {
    const { evaluationId, itemIds } = await seed();
    expect((await setIntro(evaluationId, itemIds[1]!, INTRO)).statusCode).toBe(200);
    let detail = await detailOf(evaluationId);
    expect(detail.items.map((i) => i.intro)).toEqual([null, INTRO]);

    expect((await setIntro(evaluationId, itemIds[1]!, "   \n ")).statusCode).toBe(200);
    detail = await detailOf(evaluationId);
    expect(detail.items[1]!.intro).toBeNull();

    await setIntro(evaluationId, itemIds[1]!, INTRO);
    expect((await setIntro(evaluationId, itemIds[1]!, null)).statusCode).toBe(200);
    expect((await detailOf(evaluationId)).items[1]!.intro).toBeNull();

    expect((await setIntro(evaluationId, itemIds[0]!, "x".repeat(ITEM_INTRO_MAX + 1))).statusCode).toBe(400);
    expect((await setIntro(evaluationId, itemIds[0]!, "x".repeat(ITEM_INTRO_MAX))).statusCode).toBe(200);
  });

  it("is frozen with the item list once the evaluation is opened", async () => {
    const { evaluationId, itemIds } = await seed();
    await applyState(db(), await reload(db(), evaluationId), "lobby", server.clock.now());
    const refused = await setIntro(evaluationId, itemIds[0]!, INTRO);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "items_frozen" });
  });

  it("travels with a duplicate", async () => {
    const { evaluationId, itemIds } = await seed();
    await setIntro(evaluationId, itemIds[0]!, INTRO);
    const copy = await call(teacher, "POST", `/app/api/evaluations/${evaluationId}/duplicate`, { title: "Copy" });
    expect(copy.statusCode).toBeLessThan(300);
    const { id } = copy.json() as { id: string };
    expect((await detailOf(id)).items.map((i) => i.intro)).toEqual([INTRO, null]);
  });
});

describe("templates", () => {
  it("carry the intro, move their revision on a change of it, and a pull shows and copies it", async () => {
    const s = await seed();
    await setIntro(s.evaluationId, s.itemIds[0]!, INTRO);
    const saved = await call(teacher, "POST", `/app/api/evaluations/${s.evaluationId}/template`, {
      title: "Template",
    });
    const templateId = EvaluationTemplate.parse(saved.json()).id;
    const template = (await call(teacher, "GET", `/app/api/templates/${templateId}`)).json() as {
      template: { revision: number };
      items: { id: string; intro: string | null }[];
    };
    expect(template.items.map((i) => i.intro)).toEqual([INTRO, null]);

    const made = TemplateInstance.parse(
      (
        await call(teacher, "POST", `/app/api/templates/${templateId}/instances`, {
          classroomId: s.classroomId,
          title: "Instance",
        })
      ).json(),
    );
    const instanceId = made.evaluation.id;
    expect((await detailOf(instanceId)).items.map((i) => i.intro)).toEqual([INTRO, null]);

    // An intro written on the template's second item is a new revision.
    const edited = await call(teacher, "PATCH", `/app/api/templates/${templateId}/items/${template.items[1]!.id}`, {
      intro: "## Part 2",
    });
    expect(edited.statusCode).toBe(200);
    expect((edited.json() as { template: { revision: number } }).template.revision).toBe(
      template.template.revision + 1,
    );
    // Writing the same text again is no change.
    const same = await call(teacher, "PATCH", `/app/api/templates/${templateId}/items/${template.items[1]!.id}`, {
      intro: "## Part 2",
    });
    expect((same.json() as { template: { revision: number } }).template.revision).toBe(
      template.template.revision + 1,
    );

    const preview = TemplatePullPreview.parse(
      (await call(teacher, "GET", `/app/api/evaluations/${instanceId}/pull-template`)).json(),
    );
    expect(preview.changed).toHaveLength(1);
    expect(preview.changed[0]!.from.intro).toBeNull();
    expect(preview.changed[0]!.to.intro).toBe("## Part 2");

    const pulled = await call(teacher, "POST", `/app/api/evaluations/${instanceId}/pull-template`, {
      revision: preview.to,
    });
    expect(pulled.statusCode).toBe(200);
    expect((await detailOf(instanceId)).items.map((i) => i.intro)).toEqual([INTRO, "## Part 2"]);
  });
});

describe("the student and the teacher's surfaces", () => {
  it("does not reach a student in the waiting room: content waits for the start", async () => {
    const s = await seed();
    await setIntro(s.evaluationId, s.itemIds[0]!, INTRO);
    await applyState(db(), await reload(db(), s.evaluationId), "lobby", server.clock.now());
    const res = await call(student, "POST", `/app/api/evaluations/${s.evaluationId}/attempt/start`, {});
    expect(res.statusCode).toBe(200);
    expect(AttemptEntry.parse(res.json()).kind).toBe("lobby");
    expect(res.body).not.toContain("INTRO-MARKER-455");
  });

  it("reaches the attempt and the preview, never grading, dashboard, results nor feedback", async () => {
    const s = await seed();
    await setIntro(s.evaluationId, s.itemIds[0]!, INTRO);

    const preview = EvaluationPreview.parse(
      (await call(teacher, "POST", `/app/api/evaluations/${s.evaluationId}/preview`, {})).json(),
    );
    expect(preview.view.items.find((i) => i.id === s.itemIds[0])!.intro).toBe(INTRO);

    await applyState(db(), await reload(db(), s.evaluationId), "running", server.clock.now());
    const entered = AttemptEntry.parse(
      (await call(student, "POST", `/app/api/evaluations/${s.evaluationId}/attempt/start`, {})).json(),
    );
    if (entered.kind !== "attempt") throw new Error("attempt expected");
    const view = entered.view;
    expect(view.items.find((i) => i.id === s.itemIds[0])!.intro).toBe(INTRO);
    expect(view.items.find((i) => i.id === s.itemIds[1])!.intro).toBeNull();
    for (const item of view.items) {
      const saved = await call(student, "PUT", `/app/api/attempts/${view.attempt.id}/answers/${item.id}`, {
        payload: "anything",
        revision: 1,
        clientTs: server.clock.now().toISOString(),
      });
      expect(saved.statusCode).toBe(200);
    }

    // The teacher's live and grading surfaces are about answers.
    const dashboard = await call(teacher, "GET", `/app/api/evaluations/${s.evaluationId}/dashboard`);
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).not.toContain("INTRO-MARKER-455");

    await call(teacher, "POST", `/app/api/evaluations/${s.evaluationId}/close`);
    const grading = await call(
      teacher,
      "GET",
      `/app/api/evaluations/${s.evaluationId}/grading?itemId=${s.itemIds[0]}`,
    );
    expect(grading.statusCode).toBe(200);
    expect(grading.body).not.toContain("INTRO-MARKER-455");

    await call(teacher, "POST", `/app/api/evaluations/${s.evaluationId}/release`, { confirm: true });
    for (const url of [
      `/app/api/evaluations/${s.evaluationId}/results`,
      `/app/api/evaluations/${s.evaluationId}/results/by-question`,
      `/app/api/evaluations/${s.evaluationId}/results/attempts/${view.attempt.id}`,
    ]) {
      const res = await call(teacher, "GET", url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain("INTRO-MARKER-455");
    }
    for (const url of [`/app/api/attempts/${view.attempt.id}/feedback`, "/app/api/student/results"]) {
      const res = await call(student, "GET", url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain("INTRO-MARKER-455");
    }
  });
});
