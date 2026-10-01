/**
 * Invariant 6 over EVERY staff route of an object, in one sweep: the routes
 * under `/courses/:id`, `/classrooms/:id`, `/evaluations/:id`, `/pools/:id`
 * and `/questions/:id`, as Fastify's route tree lists them — so a route
 * added tomorrow is swept without anybody remembering to.
 *
 * - A teacher off the staff gets the 404 of a missing object: the same
 *   status and the same body as for an id that does not exist.
 * - A student gets, on a real object, exactly what they get on a missing
 *   one: the role's 403 on a staff route, a 404 where a student branch
 *   exists — never a sign that the object is there.
 * - Enrolled in the classroom, a student gets the same, except on the
 *   routes a student of that classroom sits through (`STUDENT_ROUTES`).
 *
 * Every inner id of a swept URL is real (`world()`), and the same URLs never
 * answer their owner a 404: no route passes for an id nobody holds.
 *
 * Each call carries an empty body: the scope is refused before the body is
 * read (`teacherRoute`, `modules/http.ts`), which `evaluation.db.test.ts`
 * checks refusal by refusal. What this sweep cannot see — an item of
 * ANOTHER evaluation, a pool linked to someone else's course, a grading of
 * another attempt — stays with the tests of each module.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { attempts, courseStaff, enrollments, evaluations, poolMembers, poolTags } from "../db/schema.js";
import { fakeShort } from "../test/fakeType.js";
import { routesOf, testServer, type Method, type TestServer } from "../test/http.js";
import { seedLive } from "../test/live.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

/** The routes a student enrolled in the classroom legitimately reaches. */
const STUDENT_ROUTES = new Set([
  "POST /app/api/evaluations/:id/attempt",
  "POST /app/api/evaluations/:id/retake",
]);

/**
 * Routes whose owner is not the course's teacher, so the owner check below
 * asks someone else, or nobody:
 * - the student routes: the enrolled student;
 * - acting as a student (ADR-034): an admin with Super Powers (ADR-054);
 * - the `.seb` download: a student seated in an exam that requires SEB, in
 *   a state `seb.db.test.ts` builds — here every caller gets the 404, and
 *   the sweeps below only hold that a real evaluation answers like a
 *   missing one.
 */
const IMPERSONATION = "POST /app/api/classrooms/:id/roster/:eid/impersonation";
const SEB_DOWNLOAD = "GET /app/api/evaluations/:id/seb";

const FAMILY = /^\/app\/api\/(courses|classrooms|evaluations|pools|questions)\/:id(\/|$)/;

let server: TestServer;
let restore: () => void;
let owner: Who;
let stranger: Who;
let outsider: Who;
let enrolled: Who;
/** The world the refusals are swept on: nothing in it is written, every call being refused. */
let shared: World;

/**
 * The owner's objects, and a REAL value for every inner parameter of a
 * swept path: a route refused off the staff is then refused for its scope,
 * never for an inner id nobody holds.
 */
interface World {
  /** The object each family names; the poll routes act on a poll (`polls`). */
  ids: Record<Family | "polls", string>;
  params: Record<string, string>;
}

const FAMILIES = ["courses", "classrooms", "evaluations", "pools", "questions"] as const;
type Family = (typeof FAMILIES)[number];

async function world(): Promise<World> {
  const db = server.app.db;
  const seed = await seedLive(db, { teacherId: owner.id, studentIds: [enrolled.id] });
  // A colleague on the course's staff and on the pool: the `:uid` of a staff
  // seat, the `:userId` of a pool member.
  const colleague = await server.signIn("teacher");
  await db.insert(courseStaff).values({ courseId: seed.courseId, userId: colleague.id });
  await db.insert(poolMembers).values({ poolId: seed.poolId, userId: colleague.id, role: "reader" });
  await db.insert(poolTags).values({ poolId: seed.poolId, tag: "malloc" });
  const [entry] = await db.select().from(enrollments).where(eq(enrollments.classroomId, seed.classroomId));
  // A poll of the owner's, for the poll routes (an exam turned poll,
  // as `evaluation.db.test.ts` makes one: a poll is refused items).
  const poll = await seedLive(db, { teacherId: owner.id, studentIds: [enrolled.id], questions: 1 });
  await db.update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, poll.evaluationId));
  const attemptId = randomUUID();
  await db.insert(attempts).values({ id: attemptId, evaluationId: seed.evaluationId, userId: enrolled.id, seed: 1 });
  return {
    ids: {
      courses: seed.courseId,
      classrooms: seed.classroomId,
      evaluations: seed.evaluationId,
      pools: seed.poolId,
      questions: seed.questionIds[0]!,
      polls: poll.evaluationId,
    },
    params: {
      itemId: seed.itemIds[0]!,
      uid: colleague.id,
      userId: colleague.id,
      eid: entry!.id,
      attemptId,
      tag: "malloc",
      number: "1",
    },
  };
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  outsider = await server.signIn("student");
  enrolled = await server.signIn("student");
  shared = await world();
});

afterAll(async () => {
  await server.close();
  restore();
});

/** The swept routes, with their URL in a world: on its object, or on a missing one. */
function sweptRoutes() {
  return routesOf(server.app.printRoutes({ commonPrefix: false })).flatMap(({ method, path }) => {
    const found = FAMILY.exec(path)?.[1] as Family | undefined;
    // A wildcard route (the journal's pages, assets, revisions) prints without
    // the segment before its `*`, so no URL can be rebuilt from it: the
    // journal's own tests sweep those (`writes.db.test.ts`, "who may write").
    if (!found || path.includes("*")) return [];
    // A poll route on an exam is a 404 for its mode, whoever asks.
    const family = path.startsWith("/app/api/evaluations/:id/poll") ? "polls" : found;
    const url = (w: World, id: string) =>
      path.replace(/:(\w+)/g, (_, name: string) => {
        if (name === "id") return id;
        const value = w.params[name];
        // A new inner parameter needs a real value in `world()`.
        if (value === undefined) throw new Error(`${method} ${path}: no value for :${name}`);
        return value;
      });
    return [
      {
        method,
        path,
        name: `${method} ${path}`,
        real: (w: World) => url(w, w.ids[family]),
        missing: (w: World) => url(w, randomUUID()),
      },
    ];
  });
}

const call = (method: Method, url: string, who: Who) =>
  server.app.inject({ method, url, headers: who.headers, ...(method === "GET" ? {} : { payload: {} }) });

/** What a caller learns from a reply: its status and its body. */
const seen = async (method: Method, url: string, who: Who) => {
  const res = await call(method, url, who);
  return { status: res.statusCode, body: res.body };
};

describe("every staff route of an object (invariant 6)", () => {
  it("sweeps the routes of every family, each of which its owner reaches", async () => {
    const routes = sweptRoutes();
    for (const family of FAMILIES) {
      expect(routes.filter((r) => r.path.startsWith(`/app/api/${family}/`)).length, family).toBeGreaterThan(3);
    }
    // No route passes the sweeps below only because an id is unknown: with
    // the same ids, the owner is never answered a 404. A write gets a world
    // of its own, so that no delete takes a later route's object away.
    const admin = await server.signInWithSuperPowers();
    const unreached: string[] = [];
    for (const { method, name, real } of routes) {
      if (name === SEB_DOWNLOAD) continue;
      const w = method === "GET" ? shared : await world();
      const who = STUDENT_ROUTES.has(name) ? enrolled : name === IMPERSONATION ? admin : owner;
      const res = await call(method, real(w), who);
      if (res.statusCode === 404) unreached.push(`${name} ${res.body}`);
    }
    expect(unreached).toEqual([]);
  });

  it("answers a teacher off the staff the 404 of a missing object", async () => {
    for (const { method, name, real, missing } of sweptRoutes()) {
      const offStaff = await seen(method, real(shared), stranger);
      expect(offStaff, name).toEqual({ status: 404, body: JSON.stringify({ error: "not_found" }) });
      expect(offStaff, name).toEqual(await seen(method, missing(shared), stranger));
    }
  });

  it("answers a student what a missing object gets, enrolled or not", async () => {
    for (const { method, name, real, missing } of sweptRoutes()) {
      const asOutsider = await seen(method, real(shared), outsider);
      expect([403, 404], name).toContain(asOutsider.status);
      expect(asOutsider, name).toEqual(await seen(method, missing(shared), outsider));
      if (STUDENT_ROUTES.has(name)) continue;
      expect(await seen(method, real(shared), enrolled), name).toEqual(asOutsider);
    }
  });
});
