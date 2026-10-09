/**
 * A course's catalog of conditions (F-ORG-16, ADR-079 §5), over the REAL
 * application: every staff member reads it, only the course's owners write
 * it (an assistant gets 403 `owner_required`, ADR-079 §5 amended
 * 2026-10-09), anyone else gets the 404 of a missing course; entries are
 * archived, never deleted; the list is every entry, the active ones first;
 * the order is the active entries, whole; and no
 * student payload — waiting room, ready screen, attempt — ever carries an
 * entry that was not picked, nor an archived one.
 */
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AttemptEntry, CourseCondition } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { auditLog, courseConditions, courseStaff } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState } from "../evaluation/service.js";

type Caller = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let owner: Caller;
let assistant: Caller;
let outsider: Caller;
let student: Caller;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-10-07T08:00:00.000Z");
  owner = await server.signIn("teacher");
  assistant = await server.signIn("teacher");
  outsider = await server.signIn("teacher");
  student = await server.signIn("student");
});
afterAll(async () => {
  await server.close();
  restore();
});

const db = () => server.app.db;
const send = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, caller: Caller, payload?: Payload) =>
  server.app.inject({ method, url, headers: caller.headers, ...(payload === undefined ? {} : { payload }) });

/** A course of `owner`, with `assistant` on its staff and `student` in its classroom. */
async function seed() {
  const seeded = await seedLive(db(), {
    teacherId: owner.id,
    studentIds: [student.id],
    settings: { lobby: "manual" },
  });
  await db().insert(courseStaff).values({ courseId: seeded.courseId, userId: assistant.id, role: "assistant" });
  return seeded;
}

const base = (courseId: string) => `/app/api/courses/${courseId}/conditions`;
const create = async (courseId: string, caller: Caller, kind: string, text: string) => {
  const res = await send("POST", base(courseId), caller, { kind, text });
  expect(res.statusCode).toBe(201);
  return res.json() as CourseCondition;
};
const list = async (courseId: string) => (await send("GET", base(courseId), owner)).json() as CourseCondition[];
const activeIds = async (courseId: string) =>
  (await list(courseId)).filter((r) => r.archivedAt === null).map((r) => r.id);

describe("the catalog's routes", () => {
  it("are read by every staff member, written by the owners only, and a 404 for anyone else", async () => {
    const { courseId } = await seed();
    const made = await create(courseId, owner, "allowed", "  A calculator  ");
    expect(made).toMatchObject({ kind: "allowed", text: "A calculator", archivedAt: null });

    const patched = await send("PATCH", `${base(courseId)}/${made.id}`, owner, { kind: "forbidden" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ kind: "forbidden", text: "A calculator" });
    expect((await send("PUT", `${base(courseId)}/order`, owner, { ids: [made.id] })).statusCode).toBe(204);
    expect((await send("POST", `${base(courseId)}/${made.id}/archive`, owner)).statusCode).toBe(200);
    expect((await send("POST", `${base(courseId)}/${made.id}/unarchive`, owner)).statusCode).toBe(200);

    // An assistant reads the catalog (they tick its entries in an evaluation)…
    const read = await send("GET", base(courseId), assistant);
    expect(read.statusCode).toBe(200);
    expect((read.json() as CourseCondition[]).map((r) => r.id)).toEqual([made.id]);
    // …and writes none of it.
    for (const [method, url, payload] of [
      ["POST", base(courseId), { kind: "info", text: "x" }],
      ["PATCH", `${base(courseId)}/${made.id}`, { text: "y" }],
      ["PUT", `${base(courseId)}/order`, { ids: [made.id] }],
      ["POST", `${base(courseId)}/${made.id}/archive`, undefined],
      ["POST", `${base(courseId)}/${made.id}/unarchive`, undefined],
    ] as const) {
      const res = await send(method, url, assistant, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json(), `${method} ${url}`).toMatchObject({ error: "owner_required" });
    }
    expect(await list(courseId)).toMatchObject([{ id: made.id, kind: "forbidden", text: "A calculator", archivedAt: null }]);

    for (const [method, url, payload] of [
      ["GET", base(courseId), undefined],
      ["POST", base(courseId), { kind: "info", text: "x" }],
      ["PATCH", `${base(courseId)}/${made.id}`, { text: "y" }],
      ["PUT", `${base(courseId)}/order`, { ids: [made.id] }],
      ["POST", `${base(courseId)}/${made.id}/archive`, undefined],
    ] as const) {
      const res = await send(method, url, outsider, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // A malformed body from off the staff learns nothing either.
    expect((await send("POST", base(courseId), outsider, { kind: "nope" })).statusCode).toBe(404);
  });

  it("refuse a blank or overlong text, and an entry of another course", async () => {
    const { courseId } = await seed();
    const other = await seed();
    expect((await send("POST", base(courseId), owner, { kind: "info", text: "   " })).statusCode).toBe(400);
    expect((await send("POST", base(courseId), owner, { kind: "info", text: "x".repeat(201) })).statusCode).toBe(400);
    expect((await send("PATCH", `${base(courseId)}/${(await create(courseId, owner, "info", "a")).id}`, owner, {})).statusCode).toBe(400);
    const foreign = await create(other.courseId, owner, "info", "Elsewhere");
    expect((await send("PATCH", `${base(courseId)}/${foreign.id}`, owner, { text: "z" })).statusCode).toBe(404);
    expect((await send("POST", `${base(courseId)}/${foreign.id}/archive`, owner)).statusCode).toBe(404);
  });

  it("list every entry, the active ones first in their order, and never delete", async () => {
    const { courseId } = await seed();
    const a = await create(courseId, owner, "allowed", "Notes");
    const b = await create(courseId, owner, "forbidden", "Phones");
    const c = await create(courseId, owner, "provided", "Formula sheet");

    expect((await send("PUT", `${base(courseId)}/order`, owner, { ids: [c.id, a.id, b.id] })).statusCode).toBe(204);
    expect(await activeIds(courseId)).toEqual([c.id, a.id, b.id]);
    // Not exactly the active entries: nothing moves.
    expect((await send("PUT", `${base(courseId)}/order`, owner, { ids: [a.id, b.id] })).json()).toMatchObject({
      error: "stale_order",
    });
    expect((await send("PUT", `${base(courseId)}/order`, owner, { ids: [a.id, a.id, b.id] })).statusCode).toBe(409);

    await send("POST", `${base(courseId)}/${a.id}/archive`, owner);
    expect(await activeIds(courseId)).toEqual([c.id, b.id]);
    const all = await list(courseId);
    expect(all.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(all[2]!.archivedAt).not.toBeNull();

    // Brought back, it goes last.
    await send("POST", `${base(courseId)}/${a.id}/unarchive`, owner);
    expect(await activeIds(courseId)).toEqual([c.id, b.id, a.id]);
    expect(await db().select().from(courseConditions).where(eq(courseConditions.courseId, courseId))).toHaveLength(3);
  });

  it("traces every write that changes a wording or the catalog's content", async () => {
    const { courseId } = await seed();
    const made = await create(courseId, owner, "allowed", "Dictionary");
    await send("PATCH", `${base(courseId)}/${made.id}`, owner, { text: "Bilingual dictionary" });
    await send("POST", `${base(courseId)}/${made.id}/archive`, owner);
    await send("POST", `${base(courseId)}/${made.id}/archive`, owner); // idempotent, untraced
    await send("POST", `${base(courseId)}/${made.id}/unarchive`, owner);
    const rows = await db()
      .select({ action: auditLog.action, payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.subjectType, "course"), eq(auditLog.subjectId, courseId)))
      .orderBy(desc(auditLog.id));
    expect(rows.map((r) => r.action).reverse()).toEqual([
      "course.condition_create",
      "course.condition_update",
      "course.condition_archive",
      "course.condition_unarchive",
    ]);
    expect(rows.find((r) => r.action === "course.condition_update")?.payload).toMatchObject({
      conditionId: made.id,
      from: { kind: "allowed", text: "Dictionary" },
      to: { kind: "allowed", text: "Bilingual dictionary" },
    });
  });
});

describe("the student views", () => {
  it("never carry the catalog: neither an entry not ticked nor an archived one", async () => {
    const enter = async (evaluationId: string) =>
      (await send("POST", `/app/api/evaluations/${evaluationId}/attempt`, student, {})).json() as AttemptEntry;

    const payloads: AttemptEntry[] = [];
    for (const target of ["lobby", "attempt", "ready"] as const) {
      const { courseId, evaluationId } = await seed();
      const ticked = await create(courseId, owner, "allowed", "Ticked: one A4 sheet");
      await create(courseId, owner, "forbidden", "Unticked: a smartwatch");
      const archived = await create(courseId, owner, "info", "Archived: bring your card");
      await send("POST", `${base(courseId)}/${archived.id}/archive`, owner);
      const patched = await send("PATCH", `/app/api/evaluations/${evaluationId}`, owner, {
        settings: { conditions: [{ kind: ticked.kind, text: ticked.text, catalogId: ticked.id }] },
      });
      expect(patched.statusCode).toBe(200);
      // The entry is edited after it was picked: the evaluation keeps its snapshot.
      await send("PATCH", `${base(courseId)}/${ticked.id}`, owner, { text: "Edited later: two sheets" });

      const evaluation = async () => reload(db(), evaluationId);
      if (target === "lobby" || target === "attempt") {
        await applyState(db(), await evaluation(), "lobby", server.clock.now());
        const lobby = await enter(evaluationId);
        expect(lobby.kind).toBe("lobby");
        if (target === "lobby") payloads.push(lobby);
        else {
          await applyState(db(), await evaluation(), "running", server.clock.now());
          const attempt = await enter(evaluationId);
          expect(attempt.kind).toBe("attempt");
          payloads.push(attempt);
        }
      } else {
        await applyState(db(), await evaluation(), "running", server.clock.now());
        const ready = await enter(evaluationId);
        expect(ready.kind).toBe("ready");
        payloads.push(ready);
      }
    }

    for (const payload of payloads) {
      const body = JSON.stringify(payload);
      expect(body).toContain("Ticked: one A4 sheet");
      for (const hidden of ["Unticked: a smartwatch", "Archived: bring your card", "Edited later", "catalogId"]) {
        expect(body, `${payload.kind} carries "${hidden}"`).not.toContain(hidden);
      }
    }
  });
});
