/**
 * The integrity journal as the staff read it (ADR-088 §7), over the real
 * application: the dashboard row's count, the inspector's incidents, the
 * evaluation's list in time order, and the 404 of a teacher off the staff.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AttemptInspect, DashboardView, EvaluationIncidents, type EvaluationSettings } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { enterStarted, reload, seedLive } from "../../test/live.js";
import { applyState } from "../evaluation/service.js";
import * as live from "./service.js";

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };

const T0 = Date.parse("2026-10-09T09:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000);

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set(at(0).toISOString());
  teacher = await server.signIn("teacher");
});
afterAll(async () => {
  await server.close();
  restore();
});

const get = (url: string, headers = teacher.headers) => server.app.inject({ method: "GET", url, headers });

/** A running exam with two students; the first one's attempt journals `rows`. */
async function sitting(
  rows: { s: number; kind: "focus" | "visibility"; details: unknown }[],
  settings: Partial<EvaluationSettings> = { logVisibility: true },
) {
  const db = server.app.db;
  server.clock.set(at(0).toISOString());
  const seed = await seedLive(db, { teacherId: teacher.id, students: 2, settings: { timing: "manual", lobby: "skip", ...settings } });
  const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", at(0));
  const attemptOf = async (userId: string) => {
    const participant = (await live.participantOf(db, evaluation, userId))!;
    return (await enterStarted(db, { evaluation, participant, now: at(0) })).attempt;
  };
  const first = await attemptOf(seed.studentIds[0]!);
  const second = await attemptOf(seed.studentIds[1]!);
  for (const row of rows) await live.logAttemptEvent(db, first.id, row.kind, row.details, at(row.s));
  // The second student leaves once, later than the first one's first absence.
  await live.logAttemptEvent(db, second.id, "focus", { focused: false }, at(30));
  await live.logAttemptEvent(db, second.id, "focus", { focused: true }, at(33));
  server.clock.set(at(300).toISOString());
  return { seed, first, second };
}

const JOURNAL = [
  // 10 s away, the blur and the hidden tab overlapping: one absence.
  { s: 10, kind: "focus" as const, details: { focused: false } },
  { s: 11, kind: "visibility" as const, details: { state: "hidden" } },
  { s: 20, kind: "visibility" as const, details: { state: "visible" } },
  { s: 21, kind: "focus" as const, details: { focused: true } },
  // A slip under a second: dropped.
  { s: 60, kind: "focus" as const, details: { focused: false } },
  { s: 60.4, kind: "focus" as const, details: { focused: true } },
  // Still away.
  { s: 120, kind: "visibility" as const, details: { state: "hidden" } },
];

describe("the integrity incidents (ADR-088 §7)", () => {
  it("counts them on the dashboard row, lists them in the inspector and across the evaluation", async () => {
    const { seed, first, second } = await sitting(JOURNAL);

    const dashboard = DashboardView.parse((await get(`/app/api/evaluations/${seed.evaluationId}/dashboard`)).json());
    const count = (attemptId: string) => dashboard.rows.find((r) => r.attemptId === attemptId)?.incidents;
    expect(count(first.id)).toBe(2);
    expect(count(second.id)).toBe(1);
    expect(dashboard.evaluation.journalOn).toBe(true);

    const inspect = AttemptInspect.parse(
      (await get(`/app/api/evaluations/${seed.evaluationId}/attempts/${first.id}`)).json(),
    );
    expect(inspect.incidents).toEqual([
      { kind: "left", at: at(10).toISOString(), durationMs: 10_000 },
      { kind: "left", at: at(120).toISOString(), durationMs: null },
    ]);

    const list = EvaluationIncidents.parse((await get(`/app/api/evaluations/${seed.evaluationId}/incidents`)).json());
    expect(list.incidents.map((e) => [e.attemptId, e.incident.at])).toEqual([
      [first.id, at(10).toISOString()],
      [second.id, at(30).toISOString()],
      [first.id, at(120).toISOString()],
    ]);
    expect(list.incidents[0]!.displayName).not.toBe("");
    expect(list.incidents[0]!.userId).toBe(seed.studentIds[0]);
    expect(list.incidents[0]!.pseudonym).toBe(inspect.attempt.pseudonym);
  });

  it("ends an absence at the attempt's close, and ignores what follows it", async () => {
    const { seed, first } = await sitting(JOURNAL);
    // The teacher closes the manual exam while the first student is away.
    const db = server.app.db;
    await live.closeEvaluation(db, await reload(db, seed.evaluationId), at(200), "teacher", server.app);
    await live.logAttemptEvent(db, first.id, "focus", { focused: false }, at(250));
    await live.logAttemptEvent(db, first.id, "focus", { focused: true }, at(260));
    server.clock.set(at(400).toISOString());

    const inspect = AttemptInspect.parse(
      (await get(`/app/api/evaluations/${seed.evaluationId}/attempts/${first.id}`)).json(),
    );
    expect(inspect.incidents).toEqual([
      { kind: "left", at: at(10).toISOString(), durationMs: 10_000 },
      { kind: "left", at: at(120).toISOString(), durationMs: 80_000 },
    ]);
  });

  it("says the journal is off on the dashboard when the evaluation does not keep it", async () => {
    const { seed } = await sitting([], { logVisibility: false });
    const dashboard = DashboardView.parse((await get(`/app/api/evaluations/${seed.evaluationId}/dashboard`)).json());
    expect(dashboard.evaluation.journalOn).toBe(false);
    const list = EvaluationIncidents.parse((await get(`/app/api/evaluations/${seed.evaluationId}/incidents`)).json());
    // The second student's rows were written by the service directly, as a
    // journal that predates the switch would be: still read, still listed.
    expect(list.incidents).toHaveLength(1);
  });

  it("answers a teacher off the staff the 404 of a missing evaluation", async () => {
    const { seed, first } = await sitting(JOURNAL);
    const stranger = await server.signIn("teacher");
    expect((await get(`/app/api/evaluations/${seed.evaluationId}/incidents`, stranger.headers)).statusCode).toBe(404);
    expect(
      (await get(`/app/api/evaluations/${seed.evaluationId}/attempts/${first.id}`, stranger.headers)).statusCode,
    ).toBe(404);
    const student = await server.signIn("student");
    expect((await get(`/app/api/evaluations/${seed.evaluationId}/incidents`, student.headers)).statusCode).not.toBe(200);
  });
});
