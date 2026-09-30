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
 * Each call carries an empty body: the scope is refused before the body is
 * read (`teacherRoute`, `modules/http.ts`), which `evaluation.db.test.ts`
 * checks refusal by refusal. What this sweep cannot see — an item of
 * ANOTHER evaluation, a pool linked to someone else's course, a grading of
 * another attempt — stays with the tests of each module.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { fakeShort } from "../test/fakeType.js";
import { routesOf, testServer, type Method, type TestServer } from "../test/http.js";
import { seedLive, type Seeded } from "../test/live.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

/** The routes a student enrolled in the classroom legitimately reaches. */
const STUDENT_ROUTES = new Set([
  "POST /app/api/evaluations/:id/attempt",
  "POST /app/api/evaluations/:id/retake",
]);

const FAMILY = /^\/app\/api\/(courses|classrooms|evaluations|pools|questions)\/:id(\/|$)/;

let server: TestServer;
let restore: () => void;
let seed: Seeded;
let owner: Who;
let stranger: Who;
let outsider: Who;
let enrolled: Who;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  owner = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  outsider = await server.signIn("student");
  enrolled = await server.signIn("student");
  seed = await seedLive(server.app.db, { teacherId: owner.id, studentIds: [enrolled.id] });
});

afterAll(async () => {
  await server.close();
  restore();
});

/** The id of the object each family names, as the owner holds it. */
const idOf = (family: string): string =>
  ({
    courses: seed.courseId,
    classrooms: seed.classroomId,
    evaluations: seed.evaluationId,
    pools: seed.poolId,
    questions: seed.questionIds[0]!,
  })[family]!;

/** The swept routes, each with its URL on the owner's object and on a missing one. */
function sweptRoutes() {
  return routesOf(server.app.printRoutes({ commonPrefix: false })).flatMap(({ method, path }) => {
    const family = FAMILY.exec(path)?.[1];
    if (!family) return [];
    // A real item of the evaluation, so an item route is refused for the
    // evaluation's scope and not for an unknown item; any other inner id is
    // unknown, and the scope is refused before it is looked up.
    const url = (id: string) =>
      path.replace(":id", id).replace(":itemId", seed.itemIds[0]!).replace(/:\w+/g, randomUUID());
    return [{ method, path, name: `${method} ${path}`, real: url(idOf(family)), missing: url(randomUUID()) }];
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
  it("sweeps the routes of every family, on objects the owner reaches", async () => {
    const routes = sweptRoutes();
    for (const family of ["courses", "classrooms", "evaluations", "pools", "questions"]) {
      expect(routes.filter((r) => r.path.startsWith(`/app/api/${family}/`)).length, family).toBeGreaterThan(3);
      const detail = await call("GET", `/app/api/${family}/${idOf(family)}`, owner);
      expect(detail.statusCode, family).toBe(200);
    }
  });

  it("answers a teacher off the staff the 404 of a missing object", async () => {
    for (const { method, name, real, missing } of sweptRoutes()) {
      const offStaff = await seen(method, real, stranger);
      expect(offStaff, name).toEqual({ status: 404, body: JSON.stringify({ error: "not_found" }) });
      expect(offStaff, name).toEqual(await seen(method, missing, stranger));
    }
  });

  it("answers a student what a missing object gets, enrolled or not", async () => {
    for (const { method, name, real, missing } of sweptRoutes()) {
      const asOutsider = await seen(method, real, outsider);
      expect([403, 404], name).toContain(asOutsider.status);
      expect(asOutsider, name).toEqual(await seen(method, missing, outsider));
      if (STUDENT_ROUTES.has(name)) continue;
      expect(await seen(method, real, enrolled), name).toEqual(asOutsider);
    }
  });
});
