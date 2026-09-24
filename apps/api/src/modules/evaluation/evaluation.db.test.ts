/**
 * The `evaluation` module against the real migrations (PLAN-MVP §8, WP5).
 *
 * What is asserted here is the part a screenshot cannot show: the state
 * machine including the moves it REFUSES, the version freeze of F-EVAL-03,
 * and the two doors that close as soon as a student has an attempt.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { TestClock } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { attempts, evaluationItems, evaluations, questions } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { testServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import * as service from "./service.js";

let db: Db;
let restore: () => void;
const clock = new TestClock();

const points = (type: string, version: { config: unknown; configVersion: number }) =>
  typeOf(type).defaultPoints(loadConfig(type, version));

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = (await testDb()) as unknown as Db;
});
afterAll(() => restore());

/** Gives the evaluation an attempt, which is what freezes its structure. */
async function addAttempt(evaluationId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(attempts).values({ id, evaluationId, userId, seed: 1 });
  return id;
}

describe("state machine (§5.1)", () => {
  it("walks draft → scheduled → lobby → running ⇄ paused → closed", async () => {
    const seed = await seedLive(db);
    let row = await reload(db, seed.evaluationId);

    row = await service.transition(db, row, "scheduled", clock.now());
    expect(row.state).toBe("scheduled");
    row = await service.transition(db, row, "lobby", clock.now());
    expect(row.state).toBe("lobby");
    row = await service.applyState(db, row, "running", clock.now());
    expect(row.state).toBe("running");
    expect(row.startedAt).not.toBeNull();
    row = await service.applyState(db, row, "paused", clock.now());
    expect(row.pausedAt).not.toBeNull();
    row = await service.applyState(db, row, "running", clock.now());
    // Resuming clears the pause instant: nothing downstream has to remember
    // which of two "paused_at" values was the current one.
    expect(row.pausedAt).toBeNull();
    row = await service.applyState(db, row, "closed", clock.now());
    expect(row.closedAt).not.toBeNull();
  });

  it("refuses the illegal transitions", async () => {
    const seed = await seedLive(db);
    const draft = await reload(db, seed.evaluationId);
    // draft → paused, draft → closed, closed → running: not in the table.
    expect(service.isLegalTransition("draft", "paused")).toBe(false);
    expect(service.isLegalTransition("closed", "running")).toBe(false);
    expect(service.isLegalTransition("released", "draft")).toBe(false);
    await expect(service.transition(db, draft, "paused" as never, clock.now())).rejects.toThrow(
      service.IllegalTransition,
    );
  });

  it("refuses to schedule an evaluation with no question", async () => {
    const seed = await seedLive(db, { questions: 0 });
    const row = await reload(db, seed.evaluationId);
    await expect(service.transition(db, row, "scheduled", clock.now())).rejects.toMatchObject({
      code: "illegal_transition",
    });
  });

  it("refuses to schedule an exam whose timing says nothing (F-EVAL-04)", async () => {
    const seed = await seedLive(db, { durationS: null });
    const row = await reload(db, seed.evaluationId);
    await expect(service.transition(db, row, "scheduled", clock.now())).rejects.toMatchObject({
      code: "illegal_transition",
    });
    // The same evaluation with a common end instead of a duration passes.
    await db
      .update(evaluations)
      .set({
        settings: { ...service.settingsOf(row), timing: "deadline" },
        opensAt: clock.now(),
        closesAt: new Date(clock.now().getTime() + 3_600_000),
      })
      .where(eq(evaluations.id, row.id));
    const fixed = await reload(db, seed.evaluationId);
    expect((await service.transition(db, fixed, "scheduled", clock.now())).state).toBe("scheduled");
  });

  it("refuses to pause anything but an exam", async () => {
    const seed = await seedLive(db, { mode: "exercise" });
    const row = await service.applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
    expect(() =>
      service.guardTransition(row, "paused", { itemCount: 2, attemptCount: 0 }),
    ).toThrow(service.IllegalTransition);
  });

  it("reopens a closed evaluation only while no attempt exists", async () => {
    const seed = await seedLive(db);
    let row = await service.applyState(db, await reload(db, seed.evaluationId), "closed", clock.now());
    row = await service.transition(db, row, "draft", clock.now());
    expect(row.state).toBe("draft");

    await addAttempt(seed.evaluationId, seed.studentIds[0]!);
    const closed = await service.applyState(db, await reload(db, seed.evaluationId), "closed", clock.now());
    await expect(service.transition(db, closed, "draft", clock.now())).rejects.toMatchObject({
      code: "illegal_transition",
    });
  });

  it("refuses every operation on a poll (decision D7)", async () => {
    const seed = await seedLive(db);
    await db.update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, seed.evaluationId));
    const row = await reload(db, seed.evaluationId);
    await expect(service.transition(db, row, "scheduled", clock.now())).rejects.toMatchObject({
      code: "not_implemented",
      status: 501,
    });
  });
});

describe("items (F-EVAL-02, F-EVAL-03)", () => {
  it("freezes the published version an item was added on", async () => {
    const seed = await seedLive(db, { questions: 1 });
    const rows = await service.itemRows(db, seed.evaluationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.versionNumber).toBe(1);
    expect(rows[0]!.latestVersionNumber).toBe(1);

    // A second publication does NOT move the item; it only makes it stale.
    const [question] = await db
      .select()
      .from(questions)
      .where(eq(questions.id, seed.questionIds[0]!));
    await poolService.putDraft(db, question!, {
      config: { statement: "Reworded", answer: "answer-q0" },
    });
    await poolService.publishQuestion(db, question!, { userId: seed.teacherId });

    const stale = await service.itemRows(db, seed.evaluationId);
    expect(stale[0]!.versionNumber).toBe(1);
    expect(stale[0]!.latestVersionNumber).toBe(2);
    expect(service.staleOf(stale)).toEqual([stale[0]!.id]);

    const updated = await service.updateVersions(
      db,
      await reload(db, seed.evaluationId),
      undefined,
      { attemptCount: 0 },
    );
    expect(updated[0]!.versionNumber).toBe(2);
    expect(service.staleOf(updated)).toEqual([]);
  });

  it("blocks update-versions once an attempt exists (F-EVAL-03)", async () => {
    const seed = await seedLive(db, { questions: 1 });
    await addAttempt(seed.evaluationId, seed.studentIds[0]!);
    await expect(
      service.updateVersions(db, await reload(db, seed.evaluationId), undefined, {
        attemptCount: 1,
      }),
    ).rejects.toMatchObject({ code: "attempts_exist", status: 409 });
  });

  it("refuses a question that has no published version, and one from another course", async () => {
    const seed = await seedLive(db, { questions: 0 });
    const row = await reload(db, seed.evaluationId);
    const draftOnly = await poolService.createQuestion(db, {
      poolId: seed.poolId,
      type: "short",
      internalName: "never-published",
      createdBy: seed.teacherId,
    });
    await expect(
      service.addItems(db, row, [draftOnly], points, { attemptCount: 0 }),
    ).rejects.toMatchObject({ code: "no_published_version", status: 422 });

    // A question of a pool that is not linked to this course is invisible.
    const other = await seedLive(db, { questions: 1 });
    await expect(
      service.addItems(db, row, [other.questionIds[0]!], points, { attemptCount: 0 }),
    ).rejects.toMatchObject({ code: "question_not_in_course", status: 422 });
  });

  it("reorders in one transaction, without colliding with its own unique index", async () => {
    const seed = await seedLive(db, { questions: 3 });
    const before = await service.itemRows(db, seed.evaluationId);
    const reversed = [...before].reverse().map((i) => i.id);
    const after = await service.reorderItems(
      db,
      await reload(db, seed.evaluationId),
      reversed,
      { attemptCount: 0 },
    );
    expect(after.map((i) => i.id)).toEqual(reversed);
    expect(after.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it("keeps positions dense after a deletion", async () => {
    const seed = await seedLive(db, { questions: 3 });
    const before = await service.itemRows(db, seed.evaluationId);
    const after = await service.deleteItem(
      db,
      await reload(db, seed.evaluationId),
      before[1]!.id,
      { attemptCount: 0 },
    );
    expect(after.map((i) => i.position)).toEqual([0, 1]);
  });

  it("freezes the structure as soon as an attempt exists", async () => {
    const seed = await seedLive(db, { questions: 1 });
    await addAttempt(seed.evaluationId, seed.studentIds[0]!);
    const row = await reload(db, seed.evaluationId);
    const ctx = { attemptCount: 1 };
    await expect(service.addItems(db, row, seed.questionIds, points, ctx)).rejects.toMatchObject({
      code: "locked",
    });
    const items = await service.itemRows(db, seed.evaluationId);
    await expect(
      service.patchItem(db, row, items[0]!.id, { points: 9 }, ctx),
    ).rejects.toMatchObject({ code: "locked" });
    await expect(service.deleteItem(db, row, items[0]!.id, ctx)).rejects.toMatchObject({
      code: "locked",
    });
  });
});

describe("the item list freezes once the evaluation is opened (issue #79)", () => {
  /** An evaluation moved straight to `state`, with nobody having entered. */
  async function opened(state: service.EvaluationRecord["state"], questions = 2) {
    const seed = await seedLive(db, { questions });
    await db.update(evaluations).set({ state }).where(eq(evaluations.id, seed.evaluationId));
    return { seed, row: await reload(db, seed.evaluationId) };
  }

  it("refuses every write to the list from the lobby on, with no attempt at all", async () => {
    for (const state of ["lobby", "running", "paused", "closed", "grading", "released"] as const) {
      const { seed, row } = await opened(state);
      const ctx = { attemptCount: 0 };
      const items = await service.itemRows(db, seed.evaluationId);
      const frozen = { code: "items_frozen", status: 409 };
      await expect(
        service.addItems(db, row, seed.questionIds.slice(0, 1), points, ctx),
        state,
      ).rejects.toMatchObject(frozen);
      await expect(service.deleteItem(db, row, items[0]!.id, ctx), state).rejects.toMatchObject(
        frozen,
      );
      await expect(
        service.patchItem(db, row, items[0]!.id, { points: 9 }, ctx),
        state,
      ).rejects.toMatchObject(frozen);
      await expect(
        service.patchItem(db, row, items[0]!.id, { milestone: true }, ctx),
        state,
      ).rejects.toMatchObject(frozen);
      await expect(
        service.reorderItems(db, row, [...items].reverse().map((i) => i.id), ctx),
        state,
      ).rejects.toMatchObject(frozen);
      await expect(service.updateVersions(db, row, undefined, ctx), state).rejects.toMatchObject(
        frozen,
      );
      // Nothing moved.
      expect(await service.itemRows(db, seed.evaluationId), state).toEqual(items);
    }
  });

  it("keeps the list editable while scheduled", async () => {
    const { seed, row } = await opened("scheduled", 3);
    const items = await service.itemRows(db, seed.evaluationId);
    const after = await service.deleteItem(db, row, items[0]!.id, { attemptCount: 0 });
    expect(after).toHaveLength(2);
  });

  it("thaws when an opened evaluation nobody entered goes back to draft", async () => {
    const { seed, row } = await opened("lobby", 2);
    const draft = await service.transition(db, row, "draft", clock.now());
    const items = await service.itemRows(db, seed.evaluationId);
    const after = await service.deleteItem(db, draft, items[0]!.id, { attemptCount: 0 });
    expect(after).toHaveLength(1);
  });

  it("answers 409 items_frozen on every item route of a running evaluation", async () => {
    const server = await testServer();
    try {
      const teacher = await server.signIn("teacher");
      const mine = await seedLive(server.app.db, { teacherId: teacher.id, questions: 2 });
      await server.app.db
        .update(evaluations)
        .set({ state: "running", startedAt: server.clock.now() })
        .where(eq(evaluations.id, mine.evaluationId));
      const base = `/app/api/evaluations/${mine.evaluationId}`;
      const itemUrl = `${base}/items/${mine.itemIds[0]}`;
      const frozen = {
        error: "items_frozen",
        message: "the evaluation has been opened: its questions are frozen",
      };
      const writes: [string, "POST" | "PATCH" | "PUT" | "DELETE", string, unknown][] = [
        ["add items", "POST", `${base}/items`, { questionIds: mine.questionIds.slice(0, 1) }],
        ["patch item", "PATCH", itemUrl, { points: 3 }],
        ["reorder", "PUT", `${base}/items/order`, { itemIds: [...mine.itemIds].reverse() }],
        ["delete item", "DELETE", itemUrl, undefined],
        ["update versions", "POST", `${base}/items/update-versions`, {}],
      ];
      for (const [name, method, url, payload] of writes) {
        const res = await server.app.inject({
          method,
          url,
          headers: teacher.headers,
          ...(payload === undefined ? {} : { payload }),
        });
        expect(res.statusCode, name).toBe(409);
        expect(res.json(), name).toEqual(frozen);
      }
      const detail = await server.app.inject({ method: "GET", url: base, headers: teacher.headers });
      expect(detail.json().items).toHaveLength(2);
    } finally {
      await server.close();
    }
  });
});

describe("patch and duplicate", () => {
  it("accepts a title but refuses a structural change once an attempt exists", async () => {
    const seed = await seedLive(db);
    await addAttempt(seed.evaluationId, seed.studentIds[0]!);
    const row = await reload(db, seed.evaluationId);
    const renamed = await service.patchEvaluation(db, row, { title: "New" }, { attemptCount: 1 });
    expect(renamed.title).toBe("New");
    await expect(
      service.patchEvaluation(db, renamed, { durationS: 60 }, { attemptCount: 1 }),
    ).rejects.toMatchObject({ code: "locked", status: 409 });
  });

  it("never lets an exam give immediate feedback (F-EVAL-11)", async () => {
    const seed = await seedLive(db);
    const row = await service.patchEvaluation(
      db,
      await reload(db, seed.evaluationId),
      { feedbackPolicy: { when: "immediate" } },
      { attemptCount: 0 },
    );
    expect(service.feedbackOf(row).when).toBe("on_release");
  });

  it("duplicates the items on the SAME frozen versions (F-EVAL-14)", async () => {
    const seed = await seedLive(db, { questions: 2 });
    const source = await reload(db, seed.evaluationId);
    const copy = await service.duplicateEvaluation(db, source, {
      classroomId: seed.classroomId,
      title: "Copy",
      createdBy: seed.teacherId,
    });
    expect(copy.state).toBe("draft");
    const sourceItems = await db
      .select()
      .from(evaluationItems)
      .where(eq(evaluationItems.evaluationId, source.id));
    const copyItems = await db
      .select()
      .from(evaluationItems)
      .where(eq(evaluationItems.evaluationId, copy.id));
    expect(copyItems.map((i) => i.questionVersionId).sort()).toEqual(
      sourceItems.map((i) => i.questionVersionId).sort(),
    );
  });
});

describe("the pool module sees the freeze", () => {
  it("refuses to delete a question an evaluation points at (409 in_use)", async () => {
    const seed = await seedLive(db, { questions: 1 });
    const [question] = await db
      .select()
      .from(questions)
      .where(eq(questions.id, seed.questionIds[0]!));
    await expect(poolService.softDeleteQuestion(db, question!)).rejects.toThrow();
  });
});

describe("duplicate into another classroom, over HTTP (invariant 6)", () => {
  it("answers 404 to a classroom the caller is not staff of", async () => {
    const server = await testServer();
    try {
      const teacher = await server.signIn("teacher");
      const mine = await seedLive(server.app.db, { teacherId: teacher.id });
      // A classroom of a course someone else teaches.
      const theirs = await seedLive(server.app.db);
      const duplicate = (classroomId: string) =>
        server.app.inject({
          method: "POST",
          url: `/app/api/evaluations/${mine.evaluationId}/duplicate`,
          headers: teacher.headers,
          payload: { classroomId, title: "Copy" },
        });
      const denied = await duplicate(theirs.classroomId);
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toEqual({ error: "not_found" });
      // Into a second classroom of their OWN, the same call goes through.
      const other = await seedLive(server.app.db, { teacherId: teacher.id });
      expect((await duplicate(other.classroomId)).statusCode).toBe(201);
    } finally {
      await server.close();
    }
  });
});

/**
 * The order of the refusals, which `teacherRoute` in `modules/http.ts` must
 * keep (audit B-02): session and role (the preHandler) → params (404) →
 * scope (the loader's 404) → body (400) → the module's error map.
 */
describe("the order of the refusals, over HTTP", () => {
  it("refuses session, params, scope, body, then maps the service error", async () => {
    const server = await testServer();
    try {
      const teacher = await server.signIn("teacher");
      const student = await server.signIn("student");
      const stranger = await server.signIn("teacher");
      const mine = await seedLive(server.app.db, { teacherId: teacher.id });
      const itemUrl = `/app/api/evaluations/${mine.evaluationId}/items/${mine.itemIds[0]}`;
      const patch = (url: string, headers: Record<string, string>, payload: unknown) =>
        server.app.inject({ method: "PATCH", url, headers, payload });
      const badBody = { points: "many" };

      expect((await patch("/app/api/evaluations/x/items/y", {}, badBody)).statusCode).toBe(401);
      expect((await patch("/app/api/evaluations/x/items/y", student.headers, badBody)).statusCode).toBe(403);

      const badParams = await patch("/app/api/evaluations/x/items/y", teacher.headers, badBody);
      expect(badParams.statusCode).toBe(404);
      expect(badParams.json()).toEqual({ error: "not_found" });

      // Off the staff, the scope's 404 wins over the malformed body.
      const offStaff = await patch(itemUrl, stranger.headers, badBody);
      expect(offStaff.statusCode).toBe(404);
      expect(offStaff.json()).toEqual({ error: "not_found" });
      const offStaffCreate = await server.app.inject({
        method: "POST",
        url: `/app/api/classrooms/${mine.classroomId}/evaluations`,
        headers: stranger.headers,
        payload: {},
      });
      expect(offStaffCreate.statusCode).toBe(404);

      const malformed = await patch(itemUrl, teacher.headers, badBody);
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().error).toBe("validation");

      // Once an attempt exists, every content write refuses with the service's
      // own 409 — which also proves each route hands the REAL attempt count to
      // the service (a route passing `{ attemptCount: 0 }` would answer 200).
      await server.app.db
        .insert(attempts)
        .values({ id: randomUUID(), evaluationId: mine.evaluationId, userId: mine.studentIds[0]!, seed: 1 });
      const base = `/app/api/evaluations/${mine.evaluationId}`;
      const locked = { error: "locked", message: "an attempt exists: the structure is frozen" };
      const writes: [string, "POST" | "PATCH" | "PUT" | "DELETE", string, unknown, unknown][] = [
        ["patch evaluation", "PATCH", base, { durationS: 600 }, locked],
        ["add items", "POST", `${base}/items`, { questionIds: mine.questionIds.slice(0, 1) }, locked],
        ["patch item", "PATCH", itemUrl, { points: 3 }, locked],
        ["reorder", "PUT", `${base}/items/order`, { itemIds: [...mine.itemIds].reverse() }, locked],
        ["delete item", "DELETE", itemUrl, undefined, locked],
        [
          "update versions",
          "POST",
          `${base}/items/update-versions`,
          {},
          { error: "attempts_exist", message: "versions cannot be updated once an attempt exists" },
        ],
      ];
      for (const [name, method, url, payload, expected] of writes) {
        const res = await server.app.inject({
          method,
          url,
          headers: teacher.headers,
          ...(payload === undefined ? {} : { payload }),
        });
        expect(res.statusCode, name).toBe(409);
        expect(res.json(), name).toEqual(expected);
      }
    } finally {
      await server.close();
    }
  });
});

describe("totalPointsOf (audit B-08)", () => {
  it("sums the items and rounds through round2, half away from zero", () => {
    expect(service.totalPointsOf([])).toBe(0);
    // Binary representation error is absorbed: 0.1 + 0.2 is 0.3.
    expect(service.totalPointsOf([{ points: 0.1 }, { points: 0.2 }])).toBe(0.3);
    expect(service.totalPointsOf([{ points: 1.25 }, { points: 2.5 }, { points: 0.75 }])).toBe(4.5);
    // An exact negative half goes away from zero, where Math.round went up.
    expect(service.totalPointsOf([{ points: -0.125 }])).toBe(-0.13);
  });
});
