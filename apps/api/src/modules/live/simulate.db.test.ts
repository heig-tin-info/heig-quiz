/**
 * `POST /app/api/attempts/:id/simulate` over the REAL application (ADR-019).
 *
 * The route is GENERIC: it drives any question type that declares
 * `interactiveRequest`, and this file never mentions ngspice, a netlist or a
 * stimulus. What it owns is the contract — the statuses, the bodies, the
 * budget and the journal — against the real migrations, the real guards and
 * the real session cookies.
 *
 * The type under it is `fakeSimulatable` (`test/fakeType.ts`), registered as
 * `circuit` through `registerForTests`; `fakeShort` stands for a type with no
 * button of its own.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";
import { RunnerBusy, RunnerUnavailable } from "@quiz/core/server";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { attemptEvents, questions } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort, fakeSimulatable } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { addItems, applyState, itemRows } from "../evaluation/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import { createQuestion, publishQuestion, putDraft } from "../pool/service.js";
import { UnavailableRunner } from "../runner/unavailable.js";
import * as service from "./service.js";

let server: TestServer;
const restores: (() => void)[] = [];
let student: { id: string; headers: Record<string, string> };
let outsider: { id: string; headers: Record<string, string> };
let teacher: { id: string; headers: Record<string, string> };

/** The default runner of the test app, put back after a test swapped it. */
let defaultRunner: unknown;

interface Recorder {
  requests: RunnerRequest[];
  runner: unknown;
}

const OUTCOME: RunnerOutcome = {
  compile: { ok: true, stdout: "", stderr: "", ms: 0 },
  cases: [
    {
      exitCode: 0,
      stdout: " time v(out)\n0 0\n1e-5 0.5\n",
      stderr: "",
      ms: 12,
      timedOut: false,
      oom: false,
      truncated: false,
    },
  ],
};

/** A runner that answers a fixed outcome and remembers what it was handed. */
function recorder(outcome: RunnerOutcome = OUTCOME): Recorder {
  const requests: RunnerRequest[] = [];
  return {
    requests,
    runner: {
      run: async (request: RunnerRequest) => {
        requests.push(request);
        return outcome;
      },
      health: async () => ({ ok: true, languages: ["spice"], queued: 0, avgMs: 1 }),
    },
  };
}

/** A runner that always throws the error it was built with. */
function throwing(error: Error): unknown {
  return {
    run: async () => {
      throw error;
    },
    health: async () => ({ ok: false, languages: [], queued: 0, avgMs: null }),
  };
}

let seed: Awaited<ReturnType<typeof seedLive>>;
let circuitItemId: string;
let shortItemId: string;
let attemptId: string;
let otherAttemptId: string;

beforeAll(async () => {
  restores.push(registerForTests(fakeShort), registerForTests(fakeSimulatable));
  server = await testServer();
  defaultRunner = (server.app as unknown as { runner: unknown }).runner;
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  outsider = await server.signIn("student");

  const db = server.app.db as unknown as Db;
  // One `short` question from the fixture (a type with no Simulate button),
  // plus one `circuit` question added through the real pool pipeline.
  seed = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: [student.id, outsider.id],
    questions: 1,
  });
  shortItemId = seed.itemIds[0]!;

  const questionId = await createQuestion(db, {
    poolId: seed.poolId,
    type: "circuit",
    internalName: "rc-lowpass",
    createdBy: teacher.id,
  });
  const [question] = await db.select().from(questions).where(eq(questions.id, questionId));
  await putDraft(db, question!, {
    config: {
      prompt: "Build a low-pass",
      simulationsPerMinute: 2,
      reference: "the-reference-netlist",
      stimuli: [
        { name: "s0", hidden: false },
        { name: "s1", hidden: true },
      ],
    },
  });
  await publishQuestion(db, question!, { userId: teacher.id });

  const running = await applyState(db, await reload(db, seed.evaluationId), "running", server.clock.now());
  await addItems(
    db,
    running,
    [questionId],
    (type, version) =>
      typeOf(type).defaultPoints(
        loadConfig(type, { config: version.config, configVersion: version.configVersion }),
      ),
    { attemptCount: 0 },
  );
  const items = await itemRows(db, running.id);
  circuitItemId = items.find((i) => i.id !== shortItemId)!.id;

  // The attempts are created through the real service, so the ids are in hand
  // and the HTTP assertions below are about the route and nothing else.
  const started = await reload(db, seed.evaluationId);
  const ids: string[] = [];
  for (const who of [student, outsider]) {
    const participant = (await service.participantOf(db, started, who.id))!;
    const created = await service.ensureAttempt(db, started, participant, server.clock.now());
    const begun = await service.beginAttempt(db, started, created, participant, server.clock.now());
    ids.push(begun.id);
  }
  attemptId = ids[0]!;
  otherAttemptId = ids[1]!;
});

afterAll(async () => {
  await server.close();
  for (const restore of restores) restore();
});

beforeEach(async () => {
  (server.app as unknown as { runner: unknown }).runner = defaultRunner;
  // The budget is counted from the journal, so each test starts with an empty
  // one rather than with a clock the previous test moved.
  await (server.app.db as unknown as Db)
    .delete(attemptEvents)
    .where(eq(attemptEvents.attemptId, attemptId));
});

const simulate = (
  id: string,
  payload: unknown,
  headers: Record<string, string> = student.headers,
) => server.app.inject({ method: "POST", url: `/app/api/attempts/${id}/simulate`, headers, payload });

const answer = { schematic: "R1 in out 1k" };

describe("POST /attempts/:id/simulate", () => {
  it("runs the request the TYPE built and hands the outcome back raw", async () => {
    const fake = recorder();
    (server.app as unknown as { runner: unknown }).runner = fake.runner;

    const res = await simulate(attemptId, { itemId: circuitItemId, answer });

    expect(res.statusCode).toBe(200);
    // The whole `RunnerOutcome`, untouched: the client half of the type reads
    // it, the live module does not interpret it.
    expect(res.json()).toEqual(OUTCOME);

    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    // The student is waiting: never the grading queue, whatever the type put
    // in the request it built.
    expect(request.priority).toBe("interactive");
    expect(request.language).toBe("spice");
    // The file names are the TYPE's, built from the stored config
    // (invariant 14), and only the visible stimulus travels.
    expect(request.files.map((f) => f.name)).toEqual(["s0.cir"]);
    expect(request.cases).toEqual([{ name: "s0", args: ["s0.cir"], stdin: "" }]);
    expect(JSON.stringify(request)).not.toContain("the-reference-netlist");
  });

  it("journals one `run` event per simulation, and nothing of the student's", async () => {
    const fake = recorder();
    (server.app as unknown as { runner: unknown }).runner = fake.runner;
    await simulate(attemptId, { itemId: circuitItemId, answer });

    const rows = await (server.app.db as unknown as Db)
      .select()
      .from(attemptEvents)
      .where(eq(attemptEvents.attemptId, attemptId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("run");
    expect(rows[0]!.details).toMatchObject({ itemId: circuitItemId, kind: "simulate" });
    // The schematic is the student's; the journal keeps ids, not payloads.
    expect(JSON.stringify(rows[0]!.details)).not.toContain("R1 in out");
  });

  it("spends the budget the type publishes, then answers 429 with a Retry-After", async () => {
    const fake = recorder();
    (server.app as unknown as { runner: unknown }).runner = fake.runner;

    // `simulationsPerMinute: 2` in the published config.
    expect((await simulate(attemptId, { itemId: circuitItemId, answer })).statusCode).toBe(200);
    expect((await simulate(attemptId, { itemId: circuitItemId, answer })).statusCode).toBe(200);

    const refused = await simulate(attemptId, { itemId: circuitItemId, answer });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe("rate_limited");
    expect(refused.headers["retry-after"]).toBe("60");
    expect(fake.requests).toHaveLength(2);

    // A minute later the window has slid: it is a rate, not a quota.
    server.clock.advance(61_000);
    expect((await simulate(attemptId, { itemId: circuitItemId, answer })).statusCode).toBe(200);
  });

  it("refuses an answer the TYPE's own schema rejects (invariant 7)", async () => {
    const fake = recorder();
    (server.app as unknown as { runner: unknown }).runner = fake.runner;

    const res = await simulate(attemptId, { itemId: circuitItemId, answer: { schematic: 42 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("answer_invalid");
    // Nothing ran: the schema is checked before the runner is touched.
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a body that is not a `SimulateBody` at all", async () => {
    const res = await simulate(attemptId, { itemId: "not-a-uuid", answer });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation");
  });

  it("says `nothing_to_run` when the type has nothing to run for this answer", async () => {
    const fake = recorder();
    (server.app as unknown as { runner: unknown }).runner = fake.runner;

    const res = await simulate(attemptId, { itemId: circuitItemId, answer: { schematic: "  " } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("nothing_to_run");
    expect(fake.requests).toHaveLength(0);
  });

  it("says `not_runnable` for a type with no button of its own", async () => {
    const res = await simulate(attemptId, { itemId: shortItemId, answer: "whatever" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("not_runnable");
  });

  it("answers 404 for an item of another evaluation, and for a made-up one", async () => {
    const res = await simulate(attemptId, { itemId: randomUUID(), answer });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  /** Invariant 6: another student's attempt is indistinguishable from a missing one. */
  it("answers 404, not 403, on someone else's attempt", async () => {
    const fake = recorder();
    (server.app as unknown as { runner: unknown }).runner = fake.runner;

    const res = await simulate(otherAttemptId, { itemId: circuitItemId, answer });
    expect(res.statusCode).toBe(404);
    expect(fake.requests).toHaveLength(0);

    // And a teacher is not a student of this attempt either.
    expect((await simulate(attemptId, { itemId: circuitItemId, answer }, teacher.headers)).statusCode)
      .toBe(404);
  });

  /**
   * Decision D14: no runner is a CONFIGURATION, not a failure. Each case gets
   * its own test because a refused simulation still spends a slot of the
   * budget — the journal entry is written before the call, exactly as `/run`
   * writes it, so a runner that is down cannot be used to buy extra runs.
   */
  it.each([
    ["not configured", () => new UnavailableRunner("not_configured"), "not_configured"],
    ["busy", () => throwing(new RunnerBusy(null)), "busy"],
    ["unreachable", () => throwing(new RunnerUnavailable("timeout")), "timeout"],
  ])("answers 503 runner_unavailable when the runner is %s", async (_label, make, reason) => {
    (server.app as unknown as { runner: unknown }).runner = make();
    const res = await simulate(attemptId, { itemId: circuitItemId, answer });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "runner_unavailable", reason });
  });

  /**
   * The server owns the clock (invariant 5): a simulation is work, and it
   * stops with the attempt — exactly where an autosave stops.
   */
  it("answers 410 once the attempt is submitted", async () => {
    const db = server.app.db as unknown as Db;
    const fake = recorder();
    (server.app as unknown as { runner: unknown }).runner = fake.runner;

    const evaluation = await reload(db, seed.evaluationId);
    const attempt = (await service.attemptById(db, attemptId))!;
    await service.submitAttempt(db, evaluation, attempt, server.clock.now());

    const res = await simulate(attemptId, { itemId: circuitItemId, answer });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: "attempt_closed", reason: "submitted" });
    // The server's clock is in the body, never the browser's.
    expect(typeof res.json().serverNow).toBe("string");
    expect(fake.requests).toHaveLength(0);
  });
});
