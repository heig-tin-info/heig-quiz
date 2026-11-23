/**
 * Sections (ADR-143): a text before an item that applies to the following
 * questions too, over HTTP against the real migrations.
 *
 * What is asserted: the scope is written through the item routes, refused on
 * an item without a text, reset when the text goes, held by a check in the
 * database, and frozen with the item list; removing a section's first item
 * moves its text to the next one when that one is in the section and has
 * none, on an evaluation and on a template alike; every copy carries the
 * scope and a pull shows a change of it; the attempt and the preview place a
 * section's text on the first of its items in the student's order, keep the
 * section's items together, and name the section of each.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type AttemptItem,
  EvaluationDetail,
  EvaluationPreview,
  EvaluationTemplate,
  TemplateInstance,
  TemplatePullPreview,
} from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { evaluationItems } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { previewView } from "../live/views.js";
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

type Method = "GET" | "POST" | "PATCH" | "DELETE";
const call = (who: Caller, method: Method, url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url,
    headers: who.headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
const db = () => server.app.db;

const SECTION = "## Part 2 — SECTION-MARKER-143";
const OWN = "Read the listing first — OWN-MARKER-143.";

const seed = (questions = 4, shuffleItems = false) =>
  seedLive(db(), {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions,
    settings: { shuffleItems },
  });

const patch = (evaluationId: string, itemId: string, body: unknown) =>
  call(teacher, "PATCH", `/app/api/evaluations/${evaluationId}/items/${itemId}`, body);

const detailOf = async (evaluationId: string) =>
  EvaluationDetail.parse((await call(teacher, "GET", `/app/api/evaluations/${evaluationId}`)).json());

const texts = (items: readonly { intro: string | null; introScope: string }[]) =>
  items.map((i) => (i.intro === null ? null : `${i.introScope}:${i.intro}`));

describe("writing a scope", () => {
  it("is stored with a text, refused without one, and reset when the text goes", async () => {
    const { evaluationId, itemIds } = await seed(2);
    expect((await patch(evaluationId, itemIds[1]!, { intro: SECTION, introScope: "following" })).statusCode).toBe(200);
    expect(texts((await detailOf(evaluationId)).items)).toEqual([null, `following:${SECTION}`]);

    for (const body of [
      { introScope: "following" },
      { intro: null, introScope: "following" },
      { intro: "   ", introScope: "following" },
    ]) {
      const refused = await patch(evaluationId, itemIds[0]!, body);
      expect(refused.statusCode, JSON.stringify(body)).toBe(422);
      expect(refused.json()).toMatchObject({ error: "intro_scope_without_text" });
    }

    // Back to its own item, then off with the text: the scope follows it.
    expect((await patch(evaluationId, itemIds[1]!, { introScope: "item" })).statusCode).toBe(200);
    await patch(evaluationId, itemIds[1]!, { introScope: "following" });
    expect((await patch(evaluationId, itemIds[1]!, { intro: null })).statusCode).toBe(200);
    expect((await detailOf(evaluationId)).items[1]).toMatchObject({ intro: null, introScope: "item" });
    expect((await patch(evaluationId, itemIds[1]!, { intro: OWN })).statusCode).toBe(200);
    expect((await detailOf(evaluationId)).items[1]).toMatchObject({ intro: OWN, introScope: "item" });
  });

  it("is held by the database: no section without a text", async () => {
    const { itemIds } = await seed(1);
    await expect(
      db().update(evaluationItems).set({ introScope: "following" }).where(eq(evaluationItems.id, itemIds[0]!)),
    ).rejects.toThrow();
  });

  it("is frozen with the item list once the evaluation is opened", async () => {
    const { evaluationId, itemIds } = await seed(2);
    await patch(evaluationId, itemIds[0]!, { intro: SECTION });
    await applyState(db(), await reload(db(), evaluationId), "lobby", server.clock.now());
    const refused = await patch(evaluationId, itemIds[0]!, { introScope: "following" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "items_frozen" });
  });
});

describe("removing a section's first item", () => {
  it("moves its text to the next item of the section when that item has none", async () => {
    const { evaluationId, itemIds } = await seed(3);
    await patch(evaluationId, itemIds[1]!, { intro: SECTION, introScope: "following" });
    expect((await call(teacher, "DELETE", `/app/api/evaluations/${evaluationId}/items/${itemIds[1]}`)).statusCode).toBe(
      204,
    );
    const { items } = await detailOf(evaluationId);
    expect(items.map((i) => [i.id, i.position])).toEqual([
      [itemIds[0], 0],
      [itemIds[2], 1],
    ]);
    expect(texts(items)).toEqual([null, `following:${SECTION}`]);
  });

  it("deletes it with the item when the next one has its own text, or there is none", async () => {
    const { evaluationId, itemIds } = await seed(3);
    await patch(evaluationId, itemIds[0]!, { intro: SECTION, introScope: "following" });
    await patch(evaluationId, itemIds[1]!, { intro: OWN });
    await patch(evaluationId, itemIds[2]!, { intro: SECTION, introScope: "following" });
    await call(teacher, "DELETE", `/app/api/evaluations/${evaluationId}/items/${itemIds[0]}`);
    await call(teacher, "DELETE", `/app/api/evaluations/${evaluationId}/items/${itemIds[2]}`);
    const { items } = await detailOf(evaluationId);
    expect(items.map((i) => [i.id, i.position])).toEqual([[itemIds[1], 0]]);
    expect(texts(items)).toEqual([`item:${OWN}`]);
  });

  it("does the same on a template, as one revision", async () => {
    const s = await seed(2);
    await patch(s.evaluationId, s.itemIds[0]!, { intro: SECTION, introScope: "following" });
    const templateId = EvaluationTemplate.parse(
      (await call(teacher, "POST", `/app/api/evaluations/${s.evaluationId}/template`, { title: "T" })).json(),
    ).id;
    const before = (await call(teacher, "GET", `/app/api/templates/${templateId}`)).json() as {
      template: { revision: number };
      items: { id: string }[];
    };
    const removed = await call(teacher, "DELETE", `/app/api/templates/${templateId}/items/${before.items[0]!.id}`);
    expect(removed.statusCode).toBe(200);
    const after = removed.json() as {
      template: { revision: number };
      items: { id: string; position: number; intro: string | null; introScope: string }[];
    };
    expect(after.template.revision).toBe(before.template.revision + 1);
    expect(after.items.map((i) => [i.id, i.position])).toEqual([[before.items[1]!.id, 0]]);
    expect(texts(after.items)).toEqual([`following:${SECTION}`]);
  });
});

describe("copies", () => {
  it("a duplicate, Save as template, Instantiate and a pull carry the scope; a pull shows its change", async () => {
    const s = await seed(2);
    await patch(s.evaluationId, s.itemIds[0]!, { intro: SECTION, introScope: "following" });
    const duplicate = (
      await call(teacher, "POST", `/app/api/evaluations/${s.evaluationId}/duplicate`, { title: "Copy" })
    ).json() as { id: string };
    expect(texts((await detailOf(duplicate.id)).items)).toEqual([`following:${SECTION}`, null]);

    const templateId = EvaluationTemplate.parse(
      (await call(teacher, "POST", `/app/api/evaluations/${s.evaluationId}/template`, { title: "T" })).json(),
    ).id;
    const template = (await call(teacher, "GET", `/app/api/templates/${templateId}`)).json() as {
      template: { revision: number };
      items: { id: string; intro: string | null; introScope: string }[];
    };
    expect(texts(template.items)).toEqual([`following:${SECTION}`, null]);
    const instanceId = TemplateInstance.parse(
      (
        await call(teacher, "POST", `/app/api/templates/${templateId}/instances`, {
          classroomId: s.classroomId,
          title: "Instance",
        })
      ).json(),
    ).evaluation.id;
    expect(texts((await detailOf(instanceId)).items)).toEqual([`following:${SECTION}`, null]);

    // The scope alone, changed on the template: a new revision, a `changed` item.
    const edited = await call(teacher, "PATCH", `/app/api/templates/${templateId}/items/${template.items[0]!.id}`, {
      introScope: "item",
    });
    expect((edited.json() as { template: { revision: number } }).template.revision).toBe(
      template.template.revision + 1,
    );
    const preview = TemplatePullPreview.parse(
      (await call(teacher, "GET", `/app/api/evaluations/${instanceId}/pull-template`)).json(),
    );
    expect(preview.changed.map((c) => [c.from.introScope, c.to.introScope])).toEqual([["following", "item"]]);
    await call(teacher, "POST", `/app/api/evaluations/${instanceId}/pull-template`, { revision: preview.to });
    expect(texts((await detailOf(instanceId)).items)).toEqual([`item:${SECTION}`, null]);
  });
});

describe("the student's order and where the texts are shown", () => {
  /** One leading item, then a section of four whose third item has a text of its own. */
  async function sectioned(shuffleItems: boolean) {
    const s = await seed(5, shuffleItems);
    await patch(s.evaluationId, s.itemIds[1]!, { intro: SECTION, introScope: "following" });
    await patch(s.evaluationId, s.itemIds[3]!, { intro: OWN });
    return s;
  }
  const view = async (evaluationId: string, seedValue: number) =>
    (await previewView(db(), await reload(db(), evaluationId), server.clock.now(), seedValue)).items;
  const shown = (items: readonly AttemptItem[]) => items.map((i) => [i.id, i.intro, i.section]);

  it("without shuffle, keeps each text on its item and names the section", async () => {
    const s = await sectioned(false);
    const [lead, head, second, third, fourth] = s.itemIds;
    expect(shown(await view(s.evaluationId, 3))).toEqual([
      [lead, null, null],
      [head, SECTION, head],
      [second, null, head],
      [third, OWN, head],
      [fourth, null, head],
    ]);
  });

  it("with shuffle, keeps the section together and shows its text before the first of its items drawn", async () => {
    const s = await sectioned(true);
    const head = s.itemIds[1]!;
    let movedHead = false;
    for (let seedValue = 0; seedValue < 12; seedValue++) {
      const items = await view(s.evaluationId, seedValue);
      // The leading item stays first; the section's four follow, in some order.
      expect(items[0]!.id).toBe(s.itemIds[0]);
      expect(items[0]!.section).toBeNull();
      expect(items.slice(1).map((i) => i.section)).toEqual([head, head, head, head]);
      const first = items[1]!;
      expect(first.intro?.startsWith(SECTION)).toBe(true);
      if (first.id !== head) movedHead = true;
      // The section's text is shown once; the own text stays with its item.
      expect(items.filter((i) => i.intro?.includes("SECTION-MARKER-143"))).toHaveLength(1);
      expect(items.filter((i) => i.intro?.includes("OWN-MARKER-143")).map((i) => i.id)).toEqual([s.itemIds[3]]);
    }
    expect(movedHead).toBe(true);
  });

  it("serves the same placement to the teacher's preview and to the student's attempt", async () => {
    const s = await sectioned(true);
    const preview = EvaluationPreview.parse(
      (await call(teacher, "POST", `/app/api/evaluations/${s.evaluationId}/preview`, {})).json(),
    );
    expect(preview.view.items.filter((i) => i.intro?.includes("SECTION-MARKER-143"))).toHaveLength(1);
    await applyState(db(), await reload(db(), s.evaluationId), "running", server.clock.now());
    const entered = (await call(student, "POST", `/app/api/evaluations/${s.evaluationId}/attempt/start`, {})).json() as {
      kind: string;
      view: { items: AttemptItem[] };
    };
    expect(entered.kind).toBe("attempt");
    const items = entered.view.items;
    expect(items.slice(1).every((i) => i.section === s.itemIds[1])).toBe(true);
    expect(items[1]!.intro?.startsWith(SECTION)).toBe(true);
  });
});
