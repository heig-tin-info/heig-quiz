/**
 * The images a PDF may draw for a NON-staff reader (ADR-125 §2): exactly the
 * ones the asset route would serve them (`mayReadAsset`) — an image of a
 * question they are taking — of an allowed type; an id that is not a UUID
 * never reaches the database.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { assets, questions } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { addItems, applyState, byId } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { storeAsset } from "./assets.js";
import * as poolService from "./service.js";

/** Three PNGs of distinct bytes (the store is content-addressed): only the header is read. */
const png = (n: number) =>
  Buffer.concat([
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
    Buffer.from([n]),
  ]);

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

describe("readableAssets, for a student", () => {
  it("loads an image of the question they are taking, and leaves out the others", async () => {
    const db = server.app.db;
    const owner = await server.signIn("teacher");
    const student = await server.signIn("student");
    const seed = await seedLive(db, { teacherId: owner.id, studentIds: [student.id], questions: 0 });
    const store = async (n: number) =>
      (
        await storeAsset(db, server.assetsDir, {
          bytes: png(n),
          facts: { mime: "image/png", width: 1, height: 1 },
          ownerId: owner.id,
          poolId: seed.poolId,
        })
      ).row;
    const [shown, unrelated, svg] = [await store(1), await store(2), await store(3)];
    // In the statement too, but of a type no student is served.
    await db.update(assets).set({ mime: "image/svg+xml" }).where(eq(assets.id, svg.id));

    const { id: questionId } = await poolService.createQuestion(db, {
      poolId: seed.poolId,
      type: "short",
      internalName: "with-images",
      createdBy: owner.id,
    });
    const [question] = await db.select().from(questions).where(eq(questions.id, questionId));
    await poolService.putDraft(db, question!, {
      config: { statement: `![](asset:${shown.id}) ![](asset:${svg.id})`, answer: "yes" },
    });
    await poolService.publishQuestion(db, question!, { userId: owner.id });
    await addItems(db, (await byId(db, seed.evaluationId))!, [questionId], () => 1, { attemptCount: 0 });

    const reader = { id: student.id, role: "student" };
    const ids = [shown.id, unrelated.id, svg.id, "not-a-uuid"];
    const read = () => poolService.readableAssets(db, server.assetsDir, ids, reader);

    // No attempt yet: nothing is theirs.
    expect(await read()).toEqual([]);

    const now = server.clock.now();
    const evaluation = await applyState(db, (await byId(db, seed.evaluationId))!, "running", now);
    const participant = (await live.participantOf(db, evaluation, student.id))!;
    const created = await live.ensureAttempt(db, evaluation, participant, now);
    await live.beginAttempt(db, evaluation, created, participant, now);

    // The shown image only: not the unrelated one, not the SVG, and the
    // malformed id dropped before the query (a UUID column would refuse it).
    expect(await read()).toEqual([{ id: shown.id, bytes: png(1) }]);
    // A teacher reads every allowed one.
    expect((await poolService.readableAssets(db, server.assetsDir, ids, { id: owner.id, role: "teacher" })).map((a) => a.id)).toEqual([
      shown.id,
      unrelated.id,
    ]);
  });
});
