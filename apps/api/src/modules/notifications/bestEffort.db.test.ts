/**
 * The notifications a user's action raises are BEST-EFFORT (ADR-030 §h,
 * #198 step 5): when `notifyMany` fails, the publication and the grading it
 * would have announced are still written, and nothing is thrown at the
 * caller.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { attempts, gradings, poolMembers, questions, users } from "../../db/schema.js";
import { seedCodeEvaluation } from "../../test/codeFixture.js";
import { testApp, testDb } from "../../test/db.js";
import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { seedLive } from "../../test/live.js";
import { runEvaluationGrading } from "../grading/jobs.js";
import * as poolService from "../pool/service.js";
import { notifyMany } from "./service.js";

vi.mock("./service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service.js")>()),
  notifyMany: vi.fn(async () => {
    throw new Error("the outbox is down");
  }),
}));

let db: Db;
const restores: (() => void)[] = [];
const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

beforeAll(async () => {
  restores.push(registerForTests(fakeShort), registerForTests(fakeRunnableCode));
  db = await testDb();
});
afterAll(() => {
  for (const restore of restores.reverse()) restore();
  quiet.mockRestore();
});

describe("a failing notification", () => {
  it("never fails a publication: the version is written and returned", async () => {
    const seed = await seedLive(db, { students: 0, questions: 0 });
    const colleague = randomUUID();
    await db.insert(users).values({ id: colleague, oidcSub: `s-${colleague}`, email: `c-${colleague.slice(0, 8)}@heig.test`, role: "teacher" });
    await db.insert(poolMembers).values({ poolId: seed.poolId, userId: colleague, role: "owner" });
    const { id } = await poolService.createQuestion(db, {
      poolId: seed.poolId,
      type: "short",
      internalName: "best-effort",
      createdBy: seed.teacherId,
    });
    const [question] = await db.select().from(questions).where(eq(questions.id, id));
    await poolService.putDraft(db, question!, { config: { statement: "S", answer: "a" } });

    vi.mocked(notifyMany).mockClear();
    const version = await poolService.publishQuestion(db, question!, { userId: seed.teacherId });
    expect(notifyMany).toHaveBeenCalledTimes(1);
    expect(version.number).toBe(1);
    expect((await poolService.listVersions(db, id)).map((v) => v.number)).toContain(1);
  });

  it("never fails a grading pass: its gradings are written", async () => {
    const app = await testApp(db);
    const fixture = await seedCodeEvaluation(db, app.clock.now());
    vi.mocked(notifyMany).mockClear();
    await expect(
      runEvaluationGrading(app, { evaluationId: fixture.evaluationId, announce: true }),
    ).resolves.toBeUndefined();
    const rows = await db
      .select({ state: gradings.state })
      .from(gradings)
      .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
      .where(eq(attempts.evaluationId, fixture.evaluationId));
    expect(notifyMany).toHaveBeenCalledTimes(1);
    // The stub runner leaves a proposal: exactly what grading_ready would announce.
    expect(rows).toEqual([{ state: "proposed" }]);
  });
});
