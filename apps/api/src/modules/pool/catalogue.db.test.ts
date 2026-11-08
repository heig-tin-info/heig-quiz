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

import {
  PoolDetail,
  PoolSummary,
  PoolUnpublishImpact,
  type Notification,
  type SimilarQuestions,
} from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";
import { conceptKey } from "@quiz/domain";

import { publish, subscribe as onBus, type BusMessage } from "../../events.js";
import {
  auditLog,
  coursePools,
  courses,
  courseStaff,
  notifications,
  poolMembers,
  poolSubscriptions,
  pools,
  questions,
  concepts,
  llmCalls,
  questionConcepts,
  attempts,
} from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { seedLive, publishQuestion, type Seeded } from "../../test/live.js";
import { listNotifications } from "../notifications/service.js";
import * as service from "./service.js";
import { newPool, type Actor } from "../../test/pools.js";
import { loadConfig } from "../../config.js";
import { type LlmProvider } from "../llm/provider.js";
import { LlmGateway, writeSettings } from "../llm/service.js";
import { conceptLabelsOf, refreshDomain, runNightDomains } from "./domain.js";
import { type Db } from "../../db/client.js";
import { seedDrillCard, seedRevisionRound } from "../../test/drill.js";
import { writeGrading } from "../grading/service.js";
import { poolQuestionStats } from "../stats/service.js";
import * as poolService from "./service.js";

let server: TestServer;
let restore: () => void;
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
    const own = await newPool(server, owner, "Mine");
    const open = await newPool(server, owner, "Open to all", { isPublic: true });
    const shared = await newPool(server, owner, "Shared with me");
    expect((await call(owner, "POST", `/app/api/pools/${shared}/members`, { userId: other.id, role: "contributor" })).statusCode).toBe(201);
    const linkedEdit = await newPool(server, owner, "Linked edit");
    const linkedRead = await newPool(server, owner, "Linked read", { isPublic: true });
    const subscribed = await newPool(server, owner, "Followed", { isPublic: true });
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
    const mine = await newPool(server, owner, "Followed live", { isPublic: true });
    const stray = await newPool(server, owner, "Not followed live", { isPublic: true });
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
    const id = await newPool(server, owner, "Public", { isPublic: true });
    expect((await call(other, "PUT", `/app/api/pools/${id}/subscription`)).statusCode).toBe(204);
    // Idempotent.
    expect((await call(other, "PUT", `/app/api/pools/${id}/subscription`)).statusCode).toBe(204);
    expect(await db_rows(id)).toBe(1);

    const detail = PoolDetail.parse((await call(other, "GET", `/app/api/pools/${id}`)).json());
    expect(detail).toMatchObject({ role: "reader", subscription: "subscribed", subscribers: null });
    const summary = (await shelf(other)).find((p) => p.id === id)!;
    expect(summary).toMatchObject({ role: "reader", subscription: "subscribed", subscriberCount: 1, memberCount: 0, visibility: "public" });
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
    const id = await newPool(server, owner, "Followed by name", { isPublic: true });
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
    const hidden = await newPool(server, owner, "Hidden");
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
    const id = await newPool(server, owner, "Read me", { isPublic: true });
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
    const id = await newPool(server, owner, "Edit me");
    const course = await courseOf([{ id: owner.id }, { id: other.id, role: "assistant" }]);
    expect((await put(owner, course, [{ poolId: id, mode: "edit" }])).statusCode).toBe(200);
    expect(PoolDetail.parse((await call(other, "GET", `/app/api/pools/${id}`)).json()).role).toBe("contributor");
  });

  it("keeps a link's mode, and the stronger of two modes wins", async () => {
    const id = await newPool(server, owner, "Both", { isPublic: true });
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
    const open = await newPool(server, owner, "Open", { isPublic: true });
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
    const hidden = await newPool(server, owner, "Private but readable");
    const course = await courseOf([{ id: other.id }]);
    expect((await call(owner, "POST", `/app/api/pools/${hidden}/members`, { userId: other.id, role: "reader" })).statusCode).toBe(201);
    const refused = await put(other, course, [{ poolId: hidden, mode: "read" }]);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "pool_not_public", poolIds: [hidden] });
    // A pool out of reach is simply not linked.
    const secret = await newPool(server, owner, "Secret");
    expect((await put(other, course, [{ poolId: secret, mode: "read" }])).json()).toEqual([]);
    // Public, but only read: an edit link is refused (ADR-013).
    const open = await newPool(server, owner, "Public only read", { isPublic: true });
    expect((await put(other, course, [{ poolId: open, mode: "edit" }])).statusCode).toBe(403);
  });

  it("keeps a read link read when a question is moved into the pool", async () => {
    const target = await newPool(server, owner, "Move target", { isPublic: true });
    const course = await courseOf([{ id: other.id }]);
    await server.app.db.insert(coursePools).values({ courseId: course, poolId: target, mode: "read" });
    const source = await newPool(server, owner, "Move source");
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
    const id = await newPool(server, owner, "Quiet", { isPublic: true });
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
    const id = await newPool(server, owner, "Soon gone", { isPublic: true });
    await call(third, "PUT", `/app/api/pools/${id}/subscription`);
    expect((await call(owner, "DELETE", `/app/api/pools/${id}`)).statusCode).toBe(204);
    const bell = (await bells(third)).find((n) => n.payload.kind === "pool_unpublished" && n.payload.state === "deleted");
    expect(bell?.payload).toMatchObject({ poolName: "Soon gone", courseName: null });
    expect(await server.app.db.select().from(notifications).where(eq(notifications.id, bell!.id))).toHaveLength(1);
  });
});

describe("the rule is stated, not trusted from the rows (ADR-095, invariant 6)", () => {
  it("opens nothing to a subscription or a read link that survived on a private pool", async () => {
    const stray = await newPool(server, owner, "Was public once", { isPublic: true });
    const course = await courseOf([{ id: other.id }]);
    // What a race between an unpublication and a write could leave behind: rows inserted by hand.
    await server.app.db.update(pools).set({ isPublic: false }).where(eq(pools.id, stray));
    await server.app.db.insert(poolSubscriptions).values({ poolId: stray, userId: third.id });
    await server.app.db.insert(coursePools).values({ courseId: course, poolId: stray, mode: "read" });

    // The course page does not list the orphan link either.
    const courseView = await call(other, "GET", `/app/api/courses/${course}`);
    expect(courseView.statusCode).toBe(200);
    expect(JSON.stringify(courseView.json())).not.toContain(stray);
    for (const who of [third, other]) {
      expect((await call(who, "GET", `/app/api/pools/${stray}`)).statusCode).toBe(404);
      expect(await shelfIds(who)).not.toContain(stray);
    }
    // No `pool:` topic either: the stream hears nothing about the pool.
    const res = await server.app.inject({ method: "GET", url: "/app/api/events", headers: third.headers, payloadAsStream: true });
    let received = "";
    const stream = res.stream();
    stream.on("data", (chunk: Buffer) => (received += chunk.toString()));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const before = received;
    publish("pool", [`pool:${stray}`]);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(received).toBe(before);
    stream.destroy();
  });

  it("does not subscribe to a pool that is not public", async () => {
    const closed = await newPool(server, owner, "Closed");
    expect((await call(other, "PUT", `/app/api/pools/${closed}/subscription`)).statusCode).toBe(404);
    expect(await server.app.db.select().from(poolSubscriptions).where(eq(poolSubscriptions.poolId, closed))).toEqual([]);
  });

  it("does not offer Subscribe to a reader member, and refuses it with already_member", async () => {
    const open = await newPool(server, owner, "Open with a reader", { isPublic: true });
    // A reader seat that predates the publication (the invitation offers none on a public pool).
    await server.app.db.insert(poolMembers).values({ poolId: open, userId: other.id, role: "reader" });
    const summary = (await shelf(other)).find((p) => p.id === open)!;
    expect(summary.subscription).toBe("none");
    expect((await call(other, "PUT", `/app/api/pools/${open}/subscription`)).json().error).toBe("already_member");
  });

  it("keeps a read link when the teacher unsubscribes", async () => {
    const open = await newPool(server, owner, "Follow and link", { isPublic: true });
    const course = await courseOf([{ id: third.id }]);
    expect((await put(third, course, [{ poolId: open, mode: "read" }])).statusCode).toBe(200);
    await call(third, "PUT", `/app/api/pools/${open}/subscription`);
    await call(third, "DELETE", `/app/api/pools/${open}/subscription`);
    expect(await server.app.db.select().from(coursePools).where(and(eq(coursePools.poolId, open), eq(coursePools.courseId, course)))).toHaveLength(1);
    expect(await shelfIds(third)).toContain(open);
  });

  it("closes the streams of the subscriber and of the read-linked staff when the pool is unpublished", async () => {
    const open = await newPool(server, owner, "Closing time", { isPublic: true });
    const course = await courseOf([{ id: other.id }]);
    await put(other, course, [{ poolId: open, mode: "read" }]);
    await call(third, "PUT", `/app/api/pools/${open}/subscription`);
    const closed: string[] = [];
    const off = onBus((m: BusMessage) => {
      if (m.kind === "close") closed.push(...m.topics);
    });
    try {
      expect((await call(owner, "PATCH", `/app/api/pools/${open}`, { isPublic: false })).statusCode).toBe(200);
    } finally {
      off();
    }
    expect(closed).toEqual(expect.arrayContaining([`user:${third.id}`, `user:${other.id}`]));
  });
});

describe("a read link is written only to a public pool, whatever was read before", () => {
  it("refuses to save a list that still holds a read link whose pool was unpublished meanwhile", async () => {
    const open = await newPool(server, owner, "Unpublished meanwhile", { isPublic: true });
    const course = await courseOf([{ id: other.id }]);
    expect((await put(other, course, [{ poolId: open, mode: "read" }])).statusCode).toBe(200);
    // The owner unpublishes; a stale list (the link as it stood) is saved afterwards.
    expect((await call(owner, "PATCH", `/app/api/pools/${open}`, { isPublic: false })).statusCode).toBe(200);
    expect(await server.app.db.select().from(coursePools).where(eq(coursePools.poolId, open))).toEqual([]);
    const stale = await put(other, course, [{ poolId: open, mode: "read" }]);
    // The pool is out of the course owner's reach now: it is simply not linked (the in-transaction lock covers the race window).
    expect(stale.statusCode).toBe(200);
    expect(await server.app.db.select().from(coursePools).where(eq(coursePools.poolId, open))).toEqual([]);
  });

  it("drops what an unpublication meets even when the pool was loaded as already private", async () => {
    const open = await newPool(server, owner, "Stale unpublish", { isPublic: true });
    await call(third, "PUT", `/app/api/pools/${open}/subscription`);
    // The row says private (a concurrent request), a subscription survives: the next unpublish still sweeps.
    await server.app.db.update(pools).set({ isPublic: false }).where(eq(pools.id, open));
    await server.app.db.insert(poolSubscriptions).values({ poolId: open, userId: other.id }).onConflictDoNothing();
    expect((await call(owner, "PATCH", `/app/api/pools/${open}`, { isPublic: false })).statusCode).toBe(200);
    expect(await server.app.db.select().from(poolSubscriptions).where(eq(poolSubscriptions.poolId, open))).toEqual([]);
  });
});

/**
 * The public pool catalogue (issue #680, lot 2; ADR-095) on a real
 * application over PGlite, with a fake LLM provider: public pools only
 * whatever Super Powers, the search over name, description, domain and the
 * concept labels of published questions (normalised, no extension), the
 * ranking, and the bilingual domain inferred from concept labels alone — on
 * publication and by the night.
 */
describe("searching the catalogue", () => {
  const SECRET = "test-llm-master-key-0123456789abcdef";

  let reply: { fr: string; en: string } = { fr: "Résistance des matériaux", en: "Strength of materials" };
  let prompts: string[] = [];
  const fake: LlmProvider = {
    id: "anthropic",
    converse: () => Promise.reject(new Error("no conversation here")),
    async complete(req) {
      prompts.push(`${req.system}\n${req.prompt}`);
      return { value: reply, model: "claude-sonnet-5-5", inputTokens: 200, outputTokens: 30 } as never;
    },
  };

  let server: TestServer;
  let owner: Actor;
  let reader: Actor;
  type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  const call = (who: Actor, method: Method, url: string, payload?: Payload) =>
    server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });

  beforeAll(async () => {
    const env = { LLM_KEY_SECRET: SECRET };
    server = await testServer(env);
    server.app.llmGateway = new LlmGateway({
      db: server.app.db,
      clock: server.clock,
      config: loadConfig({ NODE_ENV: "test", ...env }),
      provider: fake,
    });
    owner = await server.signIn("teacher");
    reader = await server.signIn("teacher");
    await writeSettings(server.app.db, { LLM_KEY_SECRET: SECRET }, { apiKey: "sk-ant-api03-test-0123456789" }, owner.id, server.clock.now());
  });
  afterAll(() => server.close());

  const mcq = (prompt: string) => ({
    configVersion: 2,
    prompt,
    choices: [
      { text: "4", correct: true },
      { text: "5", correct: false },
    ],
    mode: "single",
    policy: "inherit",
    shuffleChoices: true,
  });

  /** A question of the pool, published or left as a draft. */
  async function question(pool: string, name: string, publish = true): Promise<string> {
    const id = (await call(owner, "POST", `/app/api/pools/${pool}/questions`, { type: "mcq", internalName: `${name}-${randomUUID().slice(0, 4)}` })).json<{
      meta: { id: string };
    }>().meta.id;
    expect((await call(owner, "PUT", `/app/api/questions/${id}/draft`, { config: mcq(`SECRET-STATEMENT ${name}`), explanation: "" })).statusCode).toBe(200);
    if (publish) expect((await call(owner, "POST", `/app/api/questions/${id}/publish`, {})).statusCode).toBe(201);
    return id;
  }

  /** A concept of the vocabulary, attached to a question. */
  async function tag(questionId: string, labelFr: string | null, labelEn: string | null): Promise<void> {
    const id = randomUUID();
    await server.app.db.insert(concepts).values({
      id,
      status: "validated",
      labelFr,
      labelEn,
      keyFr: labelFr ? `${conceptKey(labelFr)}-${id.slice(0, 4)}` : null,
      keyEn: labelEn ? `${conceptKey(labelEn)}-${id.slice(0, 4)}` : null,
    });
    await server.app.db.insert(questionConcepts).values({ questionId, conceptId: id });
  }

  const search = async (who: Actor, q: string) =>
    PoolSummary.array().parse((await call(who, "GET", `/app/api/pools/catalogue?q=${encodeURIComponent(q)}`)).json());
  const names = async (who: Actor, q: string) => (await search(who, q)).map((p) => p.name);

  describe("the catalogue lists public pools only", () => {
    it("leaves out private and shared pools, even for an admin under Super Powers", async () => {
      const open = await newPool(server, owner, "Cat open", { isPublic: true });
      const hidden = await newPool(server, owner, "Cat hidden");
      const shared = await newPool(server, owner, "Cat shared");
      await call(owner, "POST", `/app/api/pools/${shared}/members`, { userId: reader.id, role: "contributor" });

      const everyone = (await search(reader, "")).map((p) => p.id);
      expect(everyone).toContain(open);
      expect(everyone).not.toContain(hidden);
      // Even a pool the reader sits on: the catalogue is public pools.
      expect(everyone).not.toContain(shared);

      const admin = await server.signInWithSuperPowers();
      const seen = (await search(admin, "")).map((p) => p.id);
      expect(seen).toContain(open);
      expect(seen).not.toContain(hidden);
    });

    it("answers a student with 403 and rejects an absurd query", async () => {
      const student = await server.signIn("student");
      expect((await call(student, "GET", "/app/api/pools/catalogue")).statusCode).toBe(403);
      expect((await call(owner, "GET", `/app/api/pools/catalogue?q=${"x".repeat(300)}`)).statusCode).toBe(400);
    });
  });

  describe("the search", () => {
    it("finds a pool by name, description, domain and concept labels, accents and plurals aside", async () => {
      await newPool(server, owner, "Thermodynamique appliquée", { isPublic: true });
      const byDescription = await newPool(server, owner, "Pool B", { isPublic: true });
      expect((await call(owner, "PATCH", `/app/api/pools/${byDescription}`, { description: "Cycles frigorifiques et pompes à chaleur" })).statusCode).toBe(200);
      const byDomain = await newPool(server, owner, "Pool C", { isPublic: true });
      await server.app.db.update(pools).set({ domainFr: "Électrochimie", domainEn: "Electrochemistry" }).where(eq(pools.id, byDomain));
      const byConcept = await newPool(server, owner, "Pool D", { isPublic: true });
      await tag(await question(byConcept, "q"), "Intégrale de Riemann", "Riemann integral");

      expect(await names(reader, "THERMODYNAMIQUE")).toContain("Thermodynamique appliquée");
      expect(await names(reader, "thermodynamique appliquee")).toContain("Thermodynamique appliquée");
      expect(await names(reader, "pompes chaleur")).toContain("Pool B");
      expect(await names(reader, "electrochimie")).toContain("Pool C");
      expect(await names(reader, "electrochemistry")).toContain("Pool C");
      // The concept's French label, plural query; and its English label.
      expect(await names(reader, "intégrales")).toContain("Pool D");
      expect(await names(reader, "riemann integral")).toContain("Pool D");
      // Every word must be found, anywhere.
      expect(await names(reader, "riemann electrochimie")).toEqual([]);
      expect(await names(reader, "zzzz")).toEqual([]);
    });

    it("folds the ligatures in the stored text as in the query: Cœur, cœur, coeur", async () => {
      await newPool(server, owner, "Cœur et Œuvre", { isPublic: true });
      await newPool(server, owner, "Straße", { isPublic: true });
      await newPool(server, owner, "Cæsar", { isPublic: true });
      for (const q of ["cœur", "coeur", "COEUR", "œuvre"]) expect(await names(reader, q)).toContain("Cœur et Œuvre");
      expect(await names(reader, "strasse")).toEqual(["Straße"]);
      expect(await names(reader, "caesar")).toEqual(["Cæsar"]);
    });

    it("folds Central-European letters like the TypeScript fold: Dvořák, Škoda", async () => {
      await newPool(server, owner, "Dvořák et Škoda", { isPublic: true });
      for (const q of ["dvorak", "DVOŘÁK", "skoda", "škoda"]) expect(await names(reader, q)).toContain("Dvořák et Škoda");
    });

    it("reads published, non-deleted questions only", async () => {
      const pool = await newPool(server, owner, "Pool E", { isPublic: true });
      await tag(await question(pool, "draft", false), "Concept brouillon", "Draft concept");
      const gone = await question(pool, "gone");
      await tag(gone, "Concept supprimé", "Deleted concept");
      expect((await call(owner, "DELETE", `/app/api/questions/${gone}`)).statusCode).toBeLessThan(300);

      expect(await names(reader, "brouillon")).toEqual([]);
      expect(await names(reader, "supprimé")).toEqual([]);
      await tag(await question(pool, "kept"), "Concept conservé", null);
      expect(await names(reader, "conservé")).toEqual(["Pool E"]);
    });

    it("treats a wildcard as text and a short query whole", async () => {
      await newPool(server, owner, "Rate 100% sure", { isPublic: true });
      expect(await names(reader, "100%")).toEqual(["Rate 100% sure"]);
      expect(await names(reader, "%")).toEqual(["Rate 100% sure"]);
    });
  });

  describe("the ranking", () => {
    it("puts the most followed first: subscribers plus members, then name", async () => {
      const quiet = await newPool(server, owner, "Rank quiet", { isPublic: true });
      const liked = await newPool(server, owner, "Rank liked", { isPublic: true });
      const shared = await newPool(server, owner, "Rank shared", { isPublic: true });
      await call(reader, "PUT", `/app/api/pools/${liked}/subscription`);
      await call(owner, "POST", `/app/api/pools/${shared}/members`, { userId: reader.id, role: "contributor" });
      const third = await server.signIn("teacher");
      await call(third, "PUT", `/app/api/pools/${liked}/subscription`);

      const ranked = (await search(reader, "rank")).map((p) => p.id);
      expect(ranked).toEqual([liked, shared, quiet]);
      const likedRow = (await search(reader, "rank liked"))[0]!;
      expect(likedRow).toMatchObject({ subscriberCount: 2, memberCount: 0, subscription: "subscribed", visibility: "public" });
    });
  });

  describe("the domain", () => {
    it("is inferred from the concept labels alone, in both languages, and only redone when they change", async () => {
      const pool = await newPool(server, owner, "Secret pool name for the domain", { isPublic: true });
      const first = await question(pool, "first");
      await tag(first, "Contrainte normale", "Normal stress");
      await tag(first, "Moment fléchissant", null);
      prompts = [];
      reply = { fr: "« Résistance des matériaux »", en: "Strength of materials" };

      expect(await refreshDomain(server.app.db, server.app.llmGateway, pool, await conceptLabelsOf(server.app.db, pool), { userId: owner.id, now: server.clock.now() })).toBe("updated");
      expect(prompts).toHaveLength(1);
      // What leaves: the concept labels; never the pool's name, a statement or an internal name.
      expect(prompts[0]).toContain("Contrainte normale / Normal stress");
      expect(prompts[0]).toContain("Moment fléchissant / ?");
      expect(prompts[0]).not.toContain("Secret pool name");
      expect(prompts[0]).not.toContain("SECRET-STATEMENT");
      expect(prompts[0]).not.toContain(first);
      const [row] = await server.app.db.select().from(pools).where(eq(pools.id, pool));
      expect(row).toMatchObject({ domainFr: "Résistance des matériaux", domainEn: "Strength of materials" });

      // The catalogue finds it by the domain, and carries it on the card.
      expect(await names(reader, "resistance materiaux")).toContain("Secret pool name for the domain");
      expect((await search(reader, "resistance materiaux"))[0]).toMatchObject({ domainFr: "Résistance des matériaux", domainEn: "Strength of materials" });

      // Unchanged concepts: the night asks nothing again; a new concept makes it ask once more.
      server.clock.set("2026-07-05T00:30:00Z");
      const about = (word: string) => prompts.filter((p) => p.includes(word)).length;
      await runNightDomains(server.app.db, server.app.llmGateway, server.clock.now());
      expect(about("Contrainte normale")).toBe(1);
      await tag(await question(pool, "second"), "Flexion", "Bending");
      await runNightDomains(server.app.db, server.app.llmGateway, server.clock.now());
      expect(about("Flexion")).toBe(1);
      expect(about("Contrainte normale")).toBe(2);
    });

    it("is inferred when the pool is published, in the background", async () => {
      const pool = await newPool(server, owner, "Published later");
      await tag(await question(pool, "p"), "Oxydation", "Oxidation");
      reply = { fr: "Chimie", en: "Chemistry" };
      prompts = [];
      expect((await call(owner, "PATCH", `/app/api/pools/${pool}`, { isPublic: true })).statusCode).toBe(200);
      for (let i = 0; i < 100 && prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(prompts).toHaveLength(1);
      for (let i = 0; i < 100; i++) {
        const [row] = await server.app.db.select().from(pools).where(eq(pools.id, pool));
        if (row?.domainFr === "Chimie") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const [row] = await server.app.db.select().from(pools).where(eq(pools.id, pool));
      expect(row).toMatchObject({ domainFr: "Chimie", domainEn: "Chemistry" });
      // Made on behalf of the owner who published, under the purpose `domain`.
      const calls = await server.app.db.select().from(llmCalls).where(eq(llmCalls.purpose, "domain"));
      expect(calls.some((c) => c.userId === owner.id)).toBe(true);
    });

    it("is cleared, without a call, when the pool has no concept to read", async () => {
      const pool = await newPool(server, owner, "No concept", { isPublic: true });
      await server.app.db.update(pools).set({ domainFr: "Ancien", domainEn: "Old", domainKey: "x" }).where(eq(pools.id, pool));
      prompts = [];
      expect(await refreshDomain(server.app.db, server.app.llmGateway, pool, [], { userId: null, now: server.clock.now() })).toBe("empty");
      expect(prompts).toEqual([]);
      const [row] = await server.app.db.select().from(pools).where(eq(pools.id, pool));
      expect(row).toMatchObject({ domainFr: "", domainEn: "", domainKey: "" });
    });

    it("is redone by the night for the public pools whose concepts changed, and only at night", async () => {
      const pool = await newPool(server, owner, "Night pool", { isPublic: true });
      await tag(await question(pool, "n"), "Optique géométrique", "Geometric optics");
      const private_ = await newPool(server, owner, "Night private");
      await tag(await question(private_, "n"), "Jamais envoyé", "Never sent");
      reply = { fr: "Optique", en: "Optics" };

      server.clock.set("2026-07-01T12:00:00Z");
      expect(await runNightDomains(server.app.db, server.app.llmGateway, server.clock.now())).toMatch(/outside the night/);

      prompts = [];
      server.clock.set("2026-07-02T00:30:00Z");
      expect(await runNightDomains(server.app.db, server.app.llmGateway, server.clock.now())).toMatch(/inferred/);
      expect(prompts.some((p) => p.includes("Optique géométrique"))).toBe(true);
      expect(prompts.some((p) => p.includes("Jamais envoyé"))).toBe(false);
      const [row] = await server.app.db.select().from(pools).where(eq(pools.id, pool));
      expect(row).toMatchObject({ domainFr: "Optique", domainEn: "Optics" });
      // Made by no person, under the purpose `domain`.
      expect((await server.app.db.select().from(llmCalls).where(eq(llmCalls.purpose, "domain"))).some((c) => c.userId === null)).toBe(true);

      // The next night finds nothing to redo.
      prompts = [];
      server.clock.set("2026-07-03T00:30:00Z");
      await runNightDomains(server.app.db, server.app.llmGateway, server.clock.now());
      expect(prompts.some((p) => p.includes("Optique géométrique"))).toBe(false);
    });

    it("stops before its share of the cap", async () => {
      await writeSettings(server.app.db, { LLM_KEY_SECRET: SECRET }, { dailyCapUsd: 0.001 }, owner.id, server.clock.now());
      const pool = await newPool(server, owner, "Cap pool", { isPublic: true });
      await tag(await question(pool, "c"), "Plafond", "Cap");
      server.clock.set("2026-07-04T00:30:00Z");
      prompts = [];
      expect(await runNightDomains(server.app.db, server.app.llmGateway, server.clock.now())).toMatch(/share of the cap is spent/);
      expect(prompts).toEqual([]);
      await writeSettings(server.app.db, { LLM_KEY_SECRET: SECRET }, { dailyCapUsd: 20 }, owner.id, server.clock.now());
    });
  });
});

/**
 * Favourite stars (F-POOL-10, ADR-040): `PUT`/`DELETE /questions/star`,
 * `DELETE /pools/:id/stars`, and the `starred` flag and filter of the list.
 */
describe("stars", () => {
  let server: TestServer;
  let restoreShort: () => void;
  let owner: Actor;
  let reader: Actor;
  let stranger: Actor;
  let poolId: string;
  let otherPoolId: string;

  async function question(pool: string, name: string): Promise<string> {
    const res = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${pool}/questions`,
      headers: owner.headers,
      payload: { type: "short", internalName: name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().meta.id as string;
  }

  const star = (who: Actor, questionIds: string[], method: "PUT" | "DELETE" = "PUT") =>
    server.app.inject({
      method,
      url: "/app/api/questions/star",
      headers: who.headers,
      payload: { questionIds },
    });

  /** The ids the caller sees starred in a pool, through the list's own filter. */
  async function starredIn(who: Actor, pool: string): Promise<string[]> {
    const res = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${pool}/questions?starred=1&limit=200`,
      headers: who.headers,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { id: string; starred: boolean }[];
    expect(items.every((q) => q.starred)).toBe(true);
    return items.map((q) => q.id).sort();
  }

  /** The `starred` flag of every row of a pool, for the caller. */
  async function flags(who: Actor, pool: string): Promise<Record<string, boolean>> {
    const res = await server.app.inject({
      method: "GET",
      url: `/app/api/pools/${pool}/questions?limit=200`,
      headers: who.headers,
    });
    expect(res.statusCode).toBe(200);
    return Object.fromEntries(
      (res.json().items as { id: string; starred: boolean }[]).map((q) => [q.id, q.starred]),
    );
  }

  beforeAll(async () => {
    restoreShort = registerForTests(fakeShort);
    server = await testServer();
    owner = await server.signIn("teacher");
    reader = await server.signIn("teacher");
    stranger = await server.signIn("teacher");
    poolId = await newPool(server, owner, "Stars");
    otherPoolId = await newPool(server, owner, "Stars, elsewhere");
    const invited = await server.app.inject({
      method: "POST",
      url: `/app/api/pools/${poolId}/members`,
      headers: owner.headers,
      payload: { userId: reader.id, role: "reader" },
    });
    expect(invited.statusCode).toBeLessThan(300);
  });

  afterAll(async () => {
    await server.close();
    restoreShort();
  });

  describe("question stars", () => {
    it("stars and unstars idempotently, and the row says so", async () => {
      const a = await question(poolId, "star-a");
      const b = await question(poolId, "star-b");
      expect((await star(owner, [a, a, b])).statusCode).toBe(204);
      expect((await star(owner, [a])).statusCode).toBe(204);
      expect(await starredIn(owner, poolId)).toEqual([a, b].sort());
      expect(await flags(owner, poolId)).toMatchObject({ [a]: true, [b]: true });

      expect((await star(owner, [b], "DELETE")).statusCode).toBe(204);
      expect((await star(owner, [b], "DELETE")).statusCode).toBe(204);
      expect(await starredIn(owner, poolId)).toEqual([a]);
      expect((await flags(owner, poolId))[b]).toBe(false);
      await star(owner, [a], "DELETE");
    });

    it("lets a reader star, and neither sees the other's stars", async () => {
      const q = await question(poolId, "star-shared");
      const other = await question(poolId, "star-shared-2");
      expect((await star(reader, [q])).statusCode).toBe(204);
      expect((await star(owner, [other])).statusCode).toBe(204);
      expect(await starredIn(reader, poolId)).toEqual([q]);
      expect(await starredIn(owner, poolId)).toEqual([other]);
      expect((await flags(owner, poolId))[q]).toBe(false);
      expect((await flags(reader, poolId))[other]).toBe(false);
    });

    it("clears only the caller's stars, only in that pool, and counts them", async () => {
      const here = await question(poolId, "star-clear-here");
      const there = await question(otherPoolId, "star-clear-there");
      await star(owner, [here, there]);
      const before = await starredIn(reader, poolId);

      const res = await server.app.inject({
        method: "DELETE",
        url: `/app/api/pools/${poolId}/stars`,
        headers: owner.headers,
      });
      expect(res.statusCode).toBe(200);
      // `here` and `star-shared-2` from the test above.
      expect(res.json()).toEqual({ cleared: 2 });
      expect(await starredIn(owner, poolId)).toEqual([]);
      expect(await starredIn(owner, otherPoolId)).toEqual([there]);
      expect(await starredIn(reader, poolId)).toEqual(before);
    });

    it("keeps the star of a moved question, and a copy starts without one", async () => {
      const q = await question(poolId, "star-moved");
      await star(owner, [q]);
      const moved = await server.app.inject({
        method: "POST",
        url: "/app/api/questions/move",
        headers: owner.headers,
        payload: { questionIds: [q], targetPoolId: otherPoolId },
      });
      expect(moved.statusCode).toBe(200);
      expect(await starredIn(owner, otherPoolId)).toContain(q);
      expect(await starredIn(owner, poolId)).not.toContain(q);

      const copied = await server.app.inject({
        method: "POST",
        url: `/app/api/questions/${q}/copy`,
        headers: owner.headers,
        payload: { targetPoolId: poolId },
      });
      expect(copied.statusCode).toBe(201);
      const copyId = copied.json().meta.id as string;
      expect((await flags(owner, poolId))[copyId]).toBe(false);
    });

    it("hides the star of a soft-deleted question, and brings it back with it", async () => {
      const q = await question(poolId, "star-deleted");
      await star(owner, [q]);
      const gone = await server.app.inject({
        method: "DELETE",
        url: `/app/api/questions/${q}`,
        headers: owner.headers,
      });
      expect(gone.statusCode).toBeLessThan(300);
      expect(await starredIn(owner, poolId)).not.toContain(q);
      const all = await server.app.inject({
        method: "GET",
        url: `/app/api/pools/${poolId}/questions?includeDeleted=1&limit=200`,
        headers: owner.headers,
      });
      const row = (all.json().items as { id: string; starred: boolean }[]).find((r) => r.id === q);
      expect(row?.starred).toBe(false);
      const cleared = await server.app.inject({
        method: "DELETE",
        url: `/app/api/pools/${poolId}/stars`,
        headers: owner.headers,
      });
      expect(cleared.json()).toEqual({ cleared: 0 });
    });

    it("answers 404 to an outsider, for the whole batch", async () => {
      const q = await question(poolId, "star-guarded");
      expect((await star(stranger, [q])).statusCode).toBe(404);
      expect((await star(stranger, [q], "DELETE")).statusCode).toBe(404);
      // One reachable id beside an unreachable one: nothing is starred at all.
      const theirPool = await newPool(server, stranger, "Stranger's");
      const own = await server.app.inject({
        method: "POST",
        url: `/app/api/pools/${theirPool}/questions`,
        headers: stranger.headers,
        payload: { type: "short", internalName: "theirs" },
      });
      const theirs = own.json().meta.id as string;
      const mixed = await star(stranger, [theirs, q]);
      expect(mixed.statusCode).toBe(404);
      expect(mixed.json()).toEqual({ error: "not_found" });
      expect(await starredIn(stranger, theirPool)).toEqual([]);
      const clear = await server.app.inject({
        method: "DELETE",
        url: `/app/api/pools/${poolId}/stars`,
        headers: stranger.headers,
      });
      expect(clear.statusCode).toBe(404);
      expect(clear.json()).toEqual({ error: "not_found" });
    });

    it("refuses a malformed batch", async () => {
      expect((await star(owner, [])).statusCode).toBe(400);
      expect((await star(owner, ["not-a-uuid"])).statusCode).toBe(400);
      const tooMany = Array.from({ length: 201 }, () => crypto.randomUUID());
      expect((await star(owner, tooMany)).statusCode).toBe(400);
    });
  });
});

/**
 * `GET /courses/:id/similar-questions` (ADR-022, addendum of 2026-10-01): the
 * published questions closest to a statement, over a real application.
 *
 * The world: a course with an exam on its linked pool (seedLive), the
 * teacher's own unlinked pool, a colleague's PUBLIC pool and a colleague's
 * PRIVATE one, and a draft that was never published. The ranking, the three
 * scopes, the flags — and what must never appear: a pool the caller cannot
 * reach, a draft, statistics under ten answers.
 */
describe("similar questions", () => {
  let server: TestServer;
  let db: Db;
  let restore: () => void;
  let teacher: Actor;
  let colleague: Actor;
  let seed: Seeded;
  const ids = {} as Record<"linkedStrong" | "linkedWeak" | "own" | "public" | "private" | "draft", string>;

  const STARTED = new Date("2026-09-01T08:00:00.000Z");

  /** A new published version of `id` saying `statement`. */
  async function republish(id: string, statement: string) {
    const [question] = await db.select().from(questions).where(eq(questions.id, id));
    await poolService.putDraft(db, question!, { config: { statement, answer: "x" } });
    await poolService.publishQuestion(db, question!, { userId: seed.teacherId });
  }

  const short = (statement: string) => ({ type: "short", config: { statement, answer: "x" } });

  /** Every student sits the exam once; the first `graded[i]` are validated on item `i`. */
  async function sit(graded: readonly number[]) {
    for (const [rank, userId] of seed.studentIds.entries()) {
      const attemptId = randomUUID();
      await db.insert(attempts).values({
        id: attemptId,
        evaluationId: seed.evaluationId,
        userId,
        seed: 1,
        state: "submitted",
        attemptNumber: 1,
        startedAt: STARTED,
        // An attempt of before the dwell was measured: counted without an answer row (ADR-039).
        displayTracked: false,
      });
      for (const [index, count] of graded.entries()) {
        if (rank < count) await validate(attemptId, seed.itemIds[index]!);
      }
    }
  }

  async function validate(attemptId: string, itemId: string) {
    await writeGrading(db, {
      attemptId,
      itemId,
      answerId: null,
      points: 1,
      maxPoints: 1,
      source: "manual",
      state: "validated",
      now: STARTED,
    });
  }

  async function similar(who: Actor, query: Record<string, string>, courseId = seed.courseId) {
    return server.app.inject({
      method: "GET",
      url: `/app/api/courses/${courseId}/similar-questions?${new URLSearchParams(query)}`,
      headers: who.headers,
    });
  }

  async function hits(query: Record<string, string>) {
    const res = await similar(teacher, query);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<SimilarQuestions>().items;
  }

  const TEXT = "Quelle est la complexité du tri rapide quand le pivot est mal choisi ?";

  beforeAll(async () => {
    restore = registerForTests(fakeShort);
    server = await testServer();
    db = server.app.db;
    teacher = await server.signIn("teacher");
    colleague = await server.signIn("teacher");
    seed = await seedLive(db, { teacherId: teacher.id, students: 10, questions: 2 });

    // The course's linked pool: a strong match and a weak one.
    ids.linkedStrong = seed.questionIds[0]!;
    ids.linkedWeak = seed.questionIds[1]!;
    await republish(ids.linkedStrong, "Complexité du tri rapide avec un mauvais pivot");
    await republish(ids.linkedWeak, "Écrire un tri par insertion");
    // Ten counted exam answers on the first, three on the second.
    await sit([10, 3]);

    const own = await newPool(server, teacher, "Mes algorithmes");
    ids.own = await publishQuestion(db, own, teacher.id, "own", short("Le tri rapide est-il stable ?"));
    const open = await newPool(server, colleague, "Algorithmes publics", { isPublic: true });
    ids.public = await publishQuestion(db, open, colleague.id, "pub", short("Complexité moyenne du tri rapide"));
    const closed = await newPool(server, colleague, "Privé");
    ids.private = await publishQuestion(db, closed, colleague.id, "priv", short(TEXT));
    // A draft, in the linked pool, word for word the search: never a hit.
    const draft = await poolService.createQuestion(db, {
      poolId: seed.poolId,
      type: "short",
      internalName: "draft",
      createdBy: teacher.id,
    });
    const [draftRow] = await db.select().from(questions).where(eq(questions.id, draft.id));
    await poolService.putDraft(db, draftRow!, { config: { statement: TEXT, answer: "x" } });
    ids.draft = draft.id;
  });

  afterAll(async () => {
    await server.close();
    restore();
  });

  describe("GET /courses/:id/similar-questions", () => {
    it("puts the course's pools first, then every reachable pool, each by shared words", async () => {
      // Four words shared, then one, in the course's pools; three, then two, elsewhere.
      const items = await hits({ text: TEXT });
      expect(items.map((h) => h.questionId)).toEqual([ids.linkedStrong, ids.linkedWeak, ids.public, ids.own]);
    });

    it("never returns a pool the caller cannot reach, nor a draft", async () => {
      const found = (await hits({ text: TEXT, limit: "50" })).map((h) => h.questionId);
      expect(found).not.toContain(ids.private);
      expect(found).not.toContain(ids.draft);
    });

    it("flags each hit: linked, can link, its pool, its excerpt, its latest version", async () => {
      const byId = new Map((await hits({ text: TEXT })).map((h) => [h.questionId, h]));
      expect(byId.get(ids.linkedStrong)).toMatchObject({
        pool: { id: seed.poolId, name: "Pool" },
        type: "short",
        internalName: "q0",
        excerpt: "Complexité du tri rapide avec un mauvais pivot",
        latestNumber: 2,
        linked: true,
        canLink: true,
      });
      expect(byId.get(ids.own)).toMatchObject({ linked: false, canLink: true });
      // A colleague's public pool can be linked read-only (ADR-095), whatever the caller's role in it.
      expect(byId.get(ids.public)).toMatchObject({ linked: false, canLink: true, pool: { name: "Algorithmes publics" } });
    });

    it("gives the pool screen's statistics, withheld under ten answers", async () => {
      const byId = new Map((await hits({ text: TEXT })).map((h) => [h.questionId, h]));
      expect(byId.get(ids.linkedStrong)!.stats).toEqual({ n: 10, p: 1, r: null });
      expect(byId.get(ids.linkedWeak)!.stats).toBeNull();
      expect(byId.get(ids.own)!.stats).toBeNull();
      // Narrowed to the hits, the pool screen's figures are the same.
      const whole = await poolQuestionStats(db, seed.poolId);
      const narrowed = await poolQuestionStats(db, seed.poolId, [ids.linkedStrong]);
      expect(narrowed.items).toEqual(whole.items.filter((i) => i.questionId === ids.linkedStrong));
    });

    it("gives no statistics for a question listed by its time in targeted revision alone (ADR-039 §6b)", async () => {
      for (const userId of seed.studentIds) {
        const cardId = await seedDrillCard(db, seed, userId, ids.linkedWeak);
        await seedRevisionRound(db, seed, userId, cardId, [{ servedAt: STARTED, timeMs: 30_000 }]);
      }
      const byId = new Map((await hits({ text: TEXT })).map((h) => [h.questionId, h]));
      expect(byId.get(ids.linkedWeak)!.stats).toBeNull();
    });

    it("filters by type, cuts at limit, and finds nothing in stop words", async () => {
      expect(await hits({ text: TEXT, type: "code" })).toEqual([]);
      expect(await hits({ text: TEXT, limit: "1" })).toHaveLength(1);
      expect(await hits({ text: "Quelle est la ? Which of the following" })).toEqual([]);
    });

    it("answers 404 off the course's staff, and 400 without a text", async () => {
      expect((await similar(colleague, { text: TEXT })).statusCode).toBe(404);
      expect((await similar(teacher, { text: TEXT }, randomUUID())).statusCode).toBe(404);
      expect((await similar(teacher, {})).statusCode).toBe(400);
    });
  });
});
