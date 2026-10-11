/**
 * Audit L11: `POST /app/api/attempts/:id/simulate` over the REAL `circuit`
 * type, searched for the reference deck (docs/spec/05 §5.7).
 *
 * `simulate.db.test.ts` proves the route generic with a fake type; this file
 * proves what the real type hands back. The runner is a fake that runs
 * nothing: every deck "fails" and quotes ITSELF in its log, which is what
 * ngspice does with the line it refused. The reference's deck carries a
 * marker designator, so a raw reference case would spell the key out.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";

import { questions } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { addItems, applyState, itemRows } from "../evaluation/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import { createQuestion, publishQuestion, putDraft } from "../pool/service.js";
import * as service from "./service.js";

/** A designator no student deck holds: found in a response, it can only be the key. */
const MARKER = "Rleakmarker";

const part = (id: string, name: string, value: string) => ({
  id,
  kind: "R",
  x: 400,
  y: 200,
  m: [1, 0, 0, 1],
  name,
  value,
});

const answer = { schematic: { components: [part("c1", "R1", "1k")], wires: [] } };

/** Every deck fails and quotes itself, as ngspice quotes the line it refused. */
function quotingRunner() {
  const requests: RunnerRequest[] = [];
  return {
    requests,
    runner: {
      run: async (request: RunnerRequest): Promise<RunnerOutcome> => {
        requests.push(request);
        return {
          compile: { ok: true, stdout: "", stderr: "", ms: 0 },
          cases: request.cases.map((c) => ({
            exitCode: 1,
            stdout: "",
            stderr: `Error on line 3 :\n${request.files.find((f) => f.name === c.args[0])?.content ?? ""}`,
            ms: 3,
            timedOut: false,
            oom: false,
            truncated: false,
          })),
        };
      },
      health: async () => ({ ok: true, languages: ["spice"], queued: 0, avgMs: 1 }),
    },
  };
}

let server: TestServer;
let student: { id: string; headers: Record<string, string> };
let attemptId: string;
let itemId: string;

beforeAll(async () => {
  server = await testServer();
  const teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  const db = server.app.db;
  const seed = await seedLive(db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });

  // One circuit question that overlays the expected curve, through the real
  // pool pipeline and the real type's schema. Without the overlay no
  // reference deck runs at all, which the precondition below shows.
  const { id } = await createQuestion(db, {
    poolId: seed.poolId,
    type: "circuit",
    internalName: "leak",
    createdBy: teacher.id,
  });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  await putDraft(db, question!, {
    config: {
      ...typeOf("circuit").emptyDraft(),
      prompt: "Build a divider",
      stimuli: [
        {
          name: "step",
          source: { kind: "step", from: 0, to: 1, atMs: 1 },
          load: { kind: "open" },
          visible: true,
        },
      ],
      reference: { components: [part("c1", MARKER, "4.7k")], wires: [] },
      showExpected: true,
    },
  });
  await publishQuestion(db, question!, { userId: teacher.id });

  await addItems(
    db,
    await reload(db, seed.evaluationId),
    [id],
    (type, version) => typeOf(type).defaultPoints(loadConfig(type, version)),
    { attemptCount: 0 },
  );
  const running = await applyState(db, await reload(db, seed.evaluationId), "running", server.clock.now());
  itemId = (await itemRows(db, running.id)).find((i) => i.questionId === id)!.id;

  const participant = (await service.participantOf(db, running, student.id))!;
  const created = await service.ensureAttempt(db, running, participant, server.clock.now());
  attemptId = (await service.beginAttempt(db, running, created, participant, server.clock.now())).id;
});

afterAll(async () => {
  await server.close();
});

describe("POST /attempts/:id/simulate on a circuit (audit L11)", () => {
  it("never returns the reference deck, even when it fails", async () => {
    const fake = quotingRunner();
    (server.app as unknown as { runner: unknown }).runner = fake.runner;

    const res = await server.app.inject({
      method: "POST",
      url: `/app/api/attempts/${attemptId}/simulate`,
      headers: student.headers,
      payload: { itemId, answer },
    });
    expect(res.statusCode).toBe(200);

    // The precondition: the reference deck did run, and its failure log
    // quoted the marker.
    const request = fake.requests[0]!;
    expect(request.cases.map((c) => c.name)).toEqual(["s0", "r0"]);
    expect(JSON.stringify(request)).toContain(MARKER);

    // The whole serialized response, not one field of it.
    expect(res.body).not.toContain(MARKER);
    const body = res.json();
    // The student's own deck comes back whole: its log is theirs.
    expect(body.cases).toHaveLength(1);
    expect(body.cases[0].stderr).toContain("R1");
    // A failed reference is no curve, and nothing else.
    expect(body.reference).toEqual([null]);
  });
});
