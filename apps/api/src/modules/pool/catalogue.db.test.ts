/**
 * Subscriptions, read-only course links and unpublishing (issue #680, lot 2;
 * ADR-095), on a real application over PGlite: "My pools" is owned + member +
 * linked-course staff + subscribed, a subscriber reads without a seat, a read
 * link gives its staff `reader` and never `contributor`, the stronger mode
 * wins, and unpublishing counts, drops, tells and revokes.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PoolDetail, PoolSummary, PoolUnpublishImpact, type Notification } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { publish } from "../../events.js";

import { auditLog, coursePools, courses, courseStaff, notifications, poolSubscriptions, pools, questions } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { listNotifications } from "../notifications/service.js";
import * as service from "./service.js";

let server: TestServer;
let restore: () => void;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let owner: Actor;
let other: Actor;
let third: Actor;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const call = (who: Actor, method: Method, url: string, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
  other = await server.signIn("teacher");
  third = await server.signIn("teacher");
});
afterAll(async () => {
  await server.close();
  restore();
});

async function newPool(name: string, extra: Record<string, unknown> = {}, who = owner): Promise<string> {
  const res = await call(who, "POST", "/app/api/pools", { name, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

async function courseOf(staff: { id: string; role?: "owner" | "assistant" }[]): Promise<string> {
  const db = server.app.db;
  const courseId = randomUUID();
  await db.insert(courses).values({ id: courseId, name: `Course ${courseId.slice(0, 4)}`, code: `C${courseId.slice(0, 8)}` });
  await db.insert(courseStaff).values(staff.map((s) => ({ courseId, userId: s.id, role: s.role ?? "owner" })));
  return courseId;
}

const put = (who: Actor, courseId: string, links: { poolId: string; mode: "edit" | "read" }[]) =>
  call(who, "PUT", `/app/api/courses/${courseId}/pools`, { pools: links });

const shelf = async (who: Actor) =>
  PoolSummary.array().parse((await call(who, "GET", "/app/api/pools")).json());
const shelfIds = async (who: Actor) => (await shelf(who)).map((p) => p.id);

const bells = async (who: Actor) =>
  (await listNotifications(server.app.db, who.id, 50)).items as Notification[];

const audits = async (pool: string) =>
  (await server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectType, "pool"), eq(auditLog.subjectId, pool)))).map(
    (r) => r.action,
  );

describe("My pools", () => {
  it("is owned + member + linked-course staff + subscribed, and leaves out a public pool with none of those", async () => {
    const own = await newPool("Mine");
    const open = await newPool("Open to all", { isPublic: true });
    const shared = await newPool("Shared with me");
    expect((await call(owner, "POST", `/app/api/pools/${shared}/members`, { userId: other.id, role: "contributor" })).statusCode).toBe(201);
    const linkedEdit = await newPool("Linked edit");
    const linkedRead = await newPool("Linked read", { isPublic: true });
    const subscribed = await newPool("Followed", { isPublic: true });
    const course = await courseOf([{ id: other.id }]);
    await server.app.db.insert(coursePools).values([
      { courseId: course, poolId: linkedEdit, mode: "edit" },
      { courseId: course, poolId: linkedRead, mode: "read" },
    ]);
    expect((await call(other, "PUT", `/app/api/pools/${subscribed}/subscription`)).statusCode).toBe(204);

    const mine = await shelfIds(other);
    expect(mine).toEqual(expect.arrayContaining([shared, linkedEdit, linkedRead, subscribed]));
    expect(mine).not.toContain(open);
    expect(mine).not.toContain(own);
    // ...but the public pool is still READ through poolAccess.
    expect((await call(other, "GET", `/app/api/pools/${open}`)).statusCode).toBe(200);
    expect(await shelfIds(owner)).toEqual(expect.arrayContaining([own, open, shared, linkedEdit, linkedRead, subscribed]));
  });
});

describe("realtime topics", () => {
  it("reaches the pools of My pools only, not every public pool", async () => {
    const mine = await newPool("Followed live", { isPublic: true });
    const stray = await newPool("Not followed live", { isPublic: true });
    await call(third, "PUT", `/app/api/pools/${mine}/subscription`);
    const res = await server.app.inject({ method: "GET", url: "/app/api/events", headers: third.headers, payloadAsStream: true });
    expect(res.statusCode).toBe(200);
    let received = "";
    const stream = res.stream();
    stream.on("data", (chunk: Buffer) => (received += chunk.toString()));
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    await settle();
    const before = received;
    publish("pool", [`pool:${stray}`]);
    await settle();
    expect(received).toBe(before);
    publish("pool", [`pool:${mine}`]);
    await settle();
    expect(received.length).toBeGreaterThan(before.length);
    expect(received.slice(before.length)).toContain("pool");
    stream.destroy();
  });
});

describe("subscriptions", () => {
  it("lets a teacher read a public pool without a seat, and does not make them a member", async () => {
    const id = await newPool("Public", { isPublic: true });
    expect((await call(other, "PUT", `/app/api/pools/${id}/subscription`)).statusCode).toBe(204);
    // Idempotent.
    expect((await call(other, "PUT", `/app/api/pools/${id}/subscription`)).statusCode).toBe(204);
    expect(await db_rows(id)).toBe(1);

    const detail = PoolDetail.parse((await call(other, "GET", `/app/api/pools/${id}`)).json());
    expect(detail).toMatchObject({ role: "reader", subscription: "subscribed", subscribers: null });
    const summary = (await shelf(other)).find((p) => p.id === id)!;
    expect(summary).toMatchObject({ role: "reader", subscribed: true, subscriberCount: 1, memberCount: 0, visibility: "public" });
    // Not on the roster, and the owner's detail counts them.
    const members = (await call(owner, "GET", `/app/api/pools/${id}/members`)).json<{ members: { userId: string }[] }>();
    expect(members.members.map((m) => m.userId)).toEqual([owner.id]);
    expect(PoolDetail.parse((await call(owner, "GET", `/app/api/pools/${id}`)).json())).toMatchObject({
      subscription: "none",
      subscribers: 1,
    });
    expect(await audits(id)).toContain("pool.subscribe");

    expect((await call(other, "DELETE", `/app/api/pools/${id}/subscription`)).statusCode).toBe(204);
    expect(await shelfIds(other)).not.toContain(id);
    expect(await audits(id)).toContain("pool.unsubscribe");
  });

  it("lists the subscribers by name to the owner and the members, to nobody else", async () => {
    const id = await newPool("Followed by name", { isPublic: true });
    await call(other, "PUT", `/app/api/pools/${id}/subscription`);
    expect((await call(owner, "POST", `/app/api/pools/${id}/members`, { userId: third.id, role: "contributor" })).statusCode).toBe(201);

    for (const who of [owner, third]) {
      const res = await call(who, "GET", `/app/api/pools/${id}/subscribers`);
      expect(res.statusCode).toBe(200);
      const body = res.json<{ subscribers: Record<string, unknown>[] }>();
      expect(body.subscribers).toHaveLength(1);
      // Names only: no id, no address, no avatar.
      expect(Object.keys(body.subscribers[0]!)).toEqual(["name"]);
    }
    // The subscriber themselves is not a member: refused, though the pool is plainly theirs to read.
    expect((await call(other, "GET", `/app/api/pools/${id}/subscribers`)).statusCode).toBe(403);
    // A member cannot be subscribed, nor can an owner: they have the pool.
    expect((await call(third, "PUT", `/app/api/pools/${id}/subscription`)).statusCode).toBe(409);
    expect((await call(owner, "PUT", `/app/api/pools/${id}/subscription`)).statusCode).toBe(409);
    // The owner has no way to remove a subscriber.
    expect((await call(owner, "DELETE", `/app/api/pools/${id}/members/${other.id}`)).statusCode).toBe(404);
  });

  it("refuses a pool that is not public, and answers a pool out of reach with a 404", async () => {
    const hidden = await newPool("Hidden");
    expect((await call(other, "PUT", `/app/api/pools/${hidden}/subscription`)).statusCode).toBe(404);
    // A named reader of a private pool may read it, but there is nothing to subscribe to.
    expect((await call(owner, "POST", `/app/api/pools/${hidden}/members`, { userId: other.id, role: "reader" })).statusCode).toBe(201);
    expect((await call(other, "PUT", `/app/api/pools/${hidden}/subscription`)).statusCode).toBe(409);
  });
});

async function db_rows(poolId: string): Promise<number> {
  return (await server.app.db.select().from(poolSubscriptions).where(eq(poolSubscriptions.poolId, poolId))).length;
}

describe("read-only course links", () => {
  it("gives the staff of a read-linked course `reader`, never `contributor`", async () => {
    const id = await newPool("Read me", { isPublic: true });
    const course = await courseOf([{ id: other.id }, { id: third.id, role: "assistant" }]);
    // Any course owner may read-link a public pool they reach, without subscribing.
    const linked = await put(other, course, [{ poolId: id, mode: "read" }]);
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject([{ id, mode: "read" }]);
    expect(await db_rows(id)).toBe(0);

    for (const who of [other, third]) {
      const detail = PoolDetail.parse((await call(who, "GET", `/app/api/pools/${id}`)).json());
      expect(detail.role).toBe("reader");
      const write = await call(who, "POST", `/app/api/pools/${id}/categories`, { name: "Nope" });
      expect(write.statusCode).toBe(403);
    }
    // The staff reach it on their shelf, as a reader.
    expect((await shelf(third)).find((p) => p.id === id)).toMatchObject({ role: "reader", heldRole: "reader" });
    const audit = (await server.app.db.select().from(auditLog).where(eq(auditLog.subjectId, course))).find(
      (r) => r.action === "course.pools_update",
    );
    expect(audit?.payload).toMatchObject({ links: [{ poolId: id, mode: "read" }] });
  });

  it("contrasts with an edit link, which makes the staff contributors", async () => {
    const id = await newPool("Edit me");
    const course = await courseOf([{ id: owner.id }, { id: other.id, role: "assistant" }]);
    expect((await put(owner, course, [{ poolId: id, mode: "edit" }])).statusCode).toBe(200);
    expect(PoolDetail.parse((await call(other, "GET", `/app/api/pools/${id}`)).json()).role).toBe("contributor");
  });

  it("keeps a link's mode, and the stronger of two modes wins", async () => {
    const id = await newPool("Both", { isPublic: true });
    const course = await courseOf([{ id: owner.id }]);
    // The same pool twice in one body: edit wins.
    const twice = await put(owner, course, [
      { poolId: id, mode: "read" },
      { poolId: id, mode: "edit" },
    ]);
    expect(twice.json()).toMatchObject([{ id, mode: "edit" }]);
    // Sent again as read: the existing edit link is kept.
    expect((await put(owner, course, [{ poolId: id, mode: "read" }])).json()).toMatchObject([{ id, mode: "edit" }]);

    // A read link is upgraded by asking for edit, which needs contributor on the pool.
    const open = await newPool("Open", { isPublic: true });
    const mine = await courseOf([{ id: other.id }]);
    expect((await put(other, mine, [{ poolId: open, mode: "read" }])).statusCode).toBe(200);
    const upgrade = await put(other, mine, [{ poolId: open, mode: "edit" }]);
    expect(upgrade.statusCode).toBe(403);
    expect(upgrade.json()).toMatchObject({ error: "pool_link_forbidden", poolIds: [open] });
    const [row] = await server.app.db.select().from(coursePools).where(eq(coursePools.courseId, mine));
    expect(row?.mode).toBe("read");
    // Still read after an unrelated re-send of the set.
    expect((await put(other, mine, [{ poolId: open, mode: "read" }])).json()).toMatchObject([{ id: open, mode: "read" }]);
  });

  it("refuses a read link to a pool that is not public, and a new edit link to a pool one only reads", async () => {
    const hidden = await newPool("Private but readable");
    const course = await courseOf([{ id: other.id }]);
    expect((await call(owner, "POST", `/app/api/pools/${hidden}/members`, { userId: other.id, role: "reader" })).statusCode).toBe(201);
    const refused = await put(other, course, [{ poolId: hidden, mode: "read" }]);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "pool_not_public", poolIds: [hidden] });
    // A pool out of reach is simply not linked.
    const secret = await newPool("Secret");
    expect((await put(other, course, [{ poolId: secret, mode: "read" }])).json()).toEqual([]);
    // Public, but only read: an edit link is refused (ADR-013).
    const open = await newPool("Public only read", { isPublic: true });
    expect((await put(other, course, [{ poolId: open, mode: "edit" }])).statusCode).toBe(403);
  });

  it("keeps a read link read when a question is moved into the pool", async () => {
    const target = await newPool("Move target", { isPublic: true }, owner);
    const course = await courseOf([{ id: other.id }]);
    await server.app.db.insert(coursePools).values({ courseId: course, poolId: target, mode: "read" });
    const source = await newPool("Move source", {}, owner);
    const question = (await call(owner, "POST", `/app/api/pools/${source}/questions`, { type: "short", internalName: "to-move" })).json<{ meta: { id: string } }>().meta.id;
    const [record] = await server.app.db.select().from(questions).where(eq(questions.id, question));
    await service.moveQuestions(server.app.db, { questions: [record!], targetPoolId: target, categoryId: null, linkCourseIds: [course] });
    const [link] = await server.app.db.select().from(coursePools).where(and(eq(coursePools.courseId, course), eq(coursePools.poolId, target)));
    expect(link?.mode).toBe("read");
  });
});

describe("unpublishing", () => {
  it("counts what breaks, then drops the read links and subscriptions, tells and revokes", async () => {
    // A course of `other` holds an exam template drawn from the owner's pool, read-linked.
    const seed = await seedLive(server.app.db, { teacherId: other.id });
    await server.app.db.update(pools).set({ ownerId: owner.id, isPublic: true }).where(eq(pools.id, seed.poolId));
    await server.app.db.update(coursePools).set({ mode: "read" }).where(eq(coursePools.poolId, seed.poolId));
    const made = await call(other, "POST", `/app/api/evaluations/${seed.evaluationId}/template`, { title: "Kept for next year" });
    expect(made.statusCode).toBe(201);
    expect((await call(third, "PUT", `/app/api/pools/${seed.poolId}/subscription`)).statusCode).toBe(204);

    // Only the owner asks.
    expect((await call(third, "GET", `/app/api/pools/${seed.poolId}/unpublish-impact`)).statusCode).toBe(403);
    const impact = PoolUnpublishImpact.parse((await call(owner, "GET", `/app/api/pools/${seed.poolId}/unpublish-impact`)).json());
    expect(impact).toEqual({ subscribers: 1, readCourses: 1, templates: 1 });

    const res = await call(owner, "PATCH", `/app/api/pools/${seed.poolId}`, { isPublic: false });
    expect(res.statusCode).toBe(200);

    // Links and subscriptions are gone; the pool is out of reach of both.
    expect(await server.app.db.select().from(coursePools).where(eq(coursePools.poolId, seed.poolId))).toEqual([]);
    expect(await db_rows(seed.poolId)).toBe(0);
    expect((await call(third, "GET", `/app/api/pools/${seed.poolId}`)).statusCode).toBe(404);
    expect((await call(other, "GET", `/app/api/pools/${seed.poolId}`)).statusCode).toBe(404);
    expect(await audits(seed.poolId)).toContain("pool.unpublish");

    // The subscriber and the course owner are told, each in their own words, without a pool id.
    const subscriberBell = (await bells(third)).find((n) => n.payload.kind === "pool_unpublished")!;
    expect(subscriberBell.payload).toMatchObject({ state: "unpublished", poolName: expect.any(String), courseName: null });
    const ownerBell = (await bells(other)).find((n) => n.payload.kind === "pool_unpublished")!;
    expect(ownerBell.payload).toMatchObject({ state: "course", courseName: expect.any(String) });
    expect(JSON.stringify([subscriberBell.payload, ownerBell.payload])).not.toContain(seed.poolId);

    // The template stays but can no longer be instantiated into the course.
    const template = made.json<{ id: string }>();
    const instance = await call(other, "POST", `/app/api/templates/${template.id}/instances`, { classroomId: seed.classroomId });
    expect(instance.statusCode).toBe(422);
    expect(instance.json().error).toBe("template_pool_unlinked");
  });

  it("asks nothing of a pool nobody follows, and an edit link survives", async () => {
    const id = await newPool("Quiet", { isPublic: true });
    const course = await courseOf([{ id: other.id }]);
    await server.app.db.insert(coursePools).values({ courseId: course, poolId: id, mode: "edit" });
    expect(PoolUnpublishImpact.parse((await call(owner, "GET", `/app/api/pools/${id}/unpublish-impact`)).json())).toEqual({
      subscribers: 0,
      readCourses: 0,
      templates: 0,
    });
    expect((await call(owner, "PATCH", `/app/api/pools/${id}`, { isPublic: false })).statusCode).toBe(200);
    expect(await server.app.db.select().from(coursePools).where(eq(coursePools.poolId, id))).toHaveLength(1);
  });

  it("tells the subscribers of a public pool that is deleted", async () => {
    const id = await newPool("Soon gone", { isPublic: true });
    await call(third, "PUT", `/app/api/pools/${id}/subscription`);
    expect((await call(owner, "DELETE", `/app/api/pools/${id}`)).statusCode).toBe(204);
    const bell = (await bells(third)).find((n) => n.payload.kind === "pool_unpublished" && n.payload.state === "deleted");
    expect(bell?.payload).toMatchObject({ poolName: "Soon gone", courseName: null });
    expect(await server.app.db.select().from(notifications).where(eq(notifications.id, bell!.id))).toHaveLength(1);
  });
});
