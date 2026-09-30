/**
 * The drill's hooks are wired where the application is built (ADR-041 §1),
 * never by the side effect of an import. This file does not import
 * `test/db.ts`, whose helper registers them too: the only registration it
 * can see is `buildApp`'s — and a release over HTTP proves it by the cards
 * it creates. (The hand-in's hook is proven the same way by
 * `routes.db.test.ts`, which does not import `test/db.ts` either.)
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { drillCards } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, setAllowDrill } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { setClassroomDrill } from "../org/service.js";

let server: TestServer;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("buildApp", () => {
  it("wires the drill on the release: releasing an exam over HTTP creates its cards", async () => {
    const db = server.app.db;
    const now = server.clock.now();
    const teacher = await server.signIn("teacher");
    const seed = await seedLive(db, { teacherId: teacher.id, students: 1, questions: 2 });
    await setClassroomDrill(db, seed.classroomId, true, now);
    let evaluation = await setAllowDrill(db, await reload(db, seed.evaluationId), true, now);
    evaluation = await applyState(db, evaluation, "running", now);
    const participant = (await live.participantOf(db, evaluation, seed.studentIds[0]!))!;
    const created = await live.ensureAttempt(db, evaluation, participant, now);
    await live.beginAttempt(db, evaluation, created, participant, now);
    await live.closeEvaluation(db, evaluation, now);

    const released = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${seed.evaluationId}/release`,
      headers: teacher.headers,
      payload: { confirm: true },
    });
    expect(released.statusCode, released.body).toBe(200);
    expect(await db.select().from(drillCards).where(eq(drillCards.evaluationId, seed.evaluationId))).toHaveLength(2);
  });
});
