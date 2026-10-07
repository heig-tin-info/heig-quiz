/**
 * The conditions of an evaluation (ADR-079, F-EVAL-33), over the REAL
 * application: the list travels through a patch, whole, is refused on a poll,
 * freezes with the rest of the settings, and reaches every student view —
 * waiting room, ready screen, attempt — with its kind and text only, beside
 * the lines the platform derives.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StudentHome, type AttemptEntry, type EvaluationDetail } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { evaluations } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState } from "../evaluation/service.js";
import { pairableEvaluations } from "../kiosk/pairing.js";

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-10-07T08:00:00.000Z");
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
});
afterAll(async () => {
  await server.close();
  restore();
});

const db = () => server.app.db;
const send = (
  method: "GET" | "POST" | "PATCH",
  url: string,
  headers: Record<string, string>,
  payload?: Payload,
) => server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });

const seed = (mode: "exam" | "exercise" | "poll" = "exam") =>
  seedLive(db(), {
    teacherId: teacher.id,
    studentIds: [student.id],
    mode,
    settings: { lobby: "manual", logVisibility: true },
  });

/** A catalog reference, staff only: no student payload may carry it. */
const catalogId = randomUUID();
const conditions = [
  { kind: "allowed", text: "  One A4 sheet of handwritten notes  ", catalogId },
  { kind: "forbidden", text: "Mobile phones" },
];

const patchConditions = (evaluationId: string, list: unknown) =>
  send("PATCH", `/app/api/evaluations/${evaluationId}`, teacher.headers, { settings: { conditions: list } });

const enter = async (evaluationId: string) =>
  (await send("POST", `/app/api/evaluations/${evaluationId}/attempt`, student.headers, {})).json() as AttemptEntry;

describe("the conditions setting", () => {
  it("is stored trimmed and in order, replaced whole, and read back by the staff", async () => {
    const { evaluationId } = await seed();
    expect((await patchConditions(evaluationId, conditions)).statusCode).toBe(200);
    const detail = (await send("GET", `/app/api/evaluations/${evaluationId}`, teacher.headers)).json() as EvaluationDetail;
    expect(detail.evaluation.settings.conditions).toEqual([
      { kind: "allowed", text: "One A4 sheet of handwritten notes", catalogId },
      { kind: "forbidden", text: "Mobile phones" },
    ]);
    expect((await patchConditions(evaluationId, [conditions[1]])).statusCode).toBe(200);
    const after = (await send("GET", `/app/api/evaluations/${evaluationId}`, teacher.headers)).json() as EvaluationDetail;
    expect(after.evaluation.settings.conditions).toEqual([{ kind: "forbidden", text: "Mobile phones" }]);
  });

  it("refuses a blank text, a text over 200 characters and a 21st condition", async () => {
    const { evaluationId } = await seed();
    expect((await patchConditions(evaluationId, [{ kind: "info", text: "   " }])).statusCode).toBe(400);
    expect((await patchConditions(evaluationId, [{ kind: "info", text: "x".repeat(201) }])).statusCode).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => ({ kind: "info", text: `Line ${i}` }));
    expect((await patchConditions(evaluationId, many)).statusCode).toBe(400);
    expect((await patchConditions(evaluationId, many.slice(0, 20))).statusCode).toBe(200);
  });

  it("is refused on a poll, emptying it passing", async () => {
    const { evaluationId } = await seed();
    await db().update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, evaluationId));
    const refused = await patchConditions(evaluationId, conditions);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: "conditions_not_allowed" });
    expect((await patchConditions(evaluationId, [])).statusCode).toBe(200);
  });

  it("is frozen while the evaluation runs (configLock)", async () => {
    const { evaluationId } = await seed();
    await applyState(db(), await reload(db(), evaluationId), "running", server.clock.now());
    const refused = await patchConditions(evaluationId, conditions);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "running_locked" });
  });

  it("travels with a duplicate", async () => {
    const { evaluationId } = await seed();
    await patchConditions(evaluationId, conditions);
    const copy = await send("POST", `/app/api/evaluations/${evaluationId}/duplicate`, teacher.headers, { title: "Copy" });
    expect(copy.statusCode).toBeLessThan(300);
    const { id } = copy.json() as { id: string };
    const detail = (await send("GET", `/app/api/evaluations/${id}`, teacher.headers)).json() as EvaluationDetail;
    expect(detail.evaluation.settings.conditions).toHaveLength(2);
  });
});

describe("the student views", () => {
  const announced = [
    { kind: "allowed", text: "One A4 sheet of handwritten notes" },
    { kind: "forbidden", text: "Mobile phones" },
  ];

  it("carry the conditions in the waiting room, the ready screen and the attempt, never the catalog reference", async () => {
    // The waiting room, then the attempt.
    const lobbySeed = await seed();
    await patchConditions(lobbySeed.evaluationId, conditions);
    await applyState(db(), await reload(db(), lobbySeed.evaluationId), "lobby", server.clock.now());
    const lobby = await enter(lobbySeed.evaluationId);
    if (lobby.kind !== "lobby") throw new Error("lobby expected");
    expect(lobby.view.conditions.announced).toEqual(announced);
    expect(lobby.view.conditions.imposed.map((c) => c.key)).toEqual([
      "duration",
      "attempts",
      "visibility_logged",
      "autosave",
    ]);

    await applyState(db(), await reload(db(), lobbySeed.evaluationId), "running", server.clock.now());
    const attempt = await enter(lobbySeed.evaluationId);
    if (attempt.kind !== "attempt") throw new Error("attempt expected");
    expect(attempt.view.conditions.announced).toEqual(announced);
    // The announced ones travel in `conditions` only.
    expect(attempt.view.evaluation.settings).not.toHaveProperty("conditions");

    // The ready screen: running, no attempt row yet.
    const readySeed = await seed();
    await patchConditions(readySeed.evaluationId, conditions);
    await applyState(db(), await reload(db(), readySeed.evaluationId), "running", server.clock.now());
    const ready = await enter(readySeed.evaluationId);
    if (ready.kind !== "ready") throw new Error("ready expected");
    expect(ready.view.conditions.announced).toEqual(announced);

    for (const payload of [lobby, attempt, ready]) {
      const body = JSON.stringify(payload);
      expect(body).not.toContain(catalogId);
      expect(body).not.toContain("catalogId");
    }
  });
});

describe("the trusted-client screens (ADR-079 §7)", () => {
  /** The student's home, its open cards by id: what the SEB launch dialog reads. */
  const openCards = async () => {
    const res = await send("GET", "/app/api/student/home", student.headers);
    expect(res.statusCode).toBe(200);
    const home = StudentHome.parse(res.json());
    const evaluationCards = home.open.flatMap((c) => (c.kind === "evaluation" ? [c] : []));
    return { body: res.body, cards: new Map(evaluationCards.map((c) => [c.id, c])) };
  };

  it("give a Safe Exam Browser card its conditions, with the seat's extra time, and never the catalog reference", async () => {
    const sebSeed = await seedLive(db(), {
      teacherId: teacher.id,
      studentIds: [student.id],
      settings: { lobby: "manual", safeExamBrowser: true },
      timeBonusPercent: 25,
    });
    await patchConditions(sebSeed.evaluationId, conditions);
    const plain = await seed();
    await patchConditions(plain.evaluationId, conditions);
    for (const id of [sebSeed.evaluationId, plain.evaluationId]) {
      await applyState(db(), await reload(db(), id), "running", server.clock.now());
    }

    const { body, cards } = await openCards();
    const card = cards.get(sebSeed.evaluationId)!;
    expect(card.trustedClients).toEqual(["seb"]);
    expect(card.conditions!.announced).toEqual([
      { kind: "allowed", text: "One A4 sheet of handwritten notes" },
      { kind: "forbidden", text: "Mobile phones" },
    ]);
    expect(card.conditions!.imposed[0]).toEqual({ key: "trusted_client", kind: "forbidden", clients: ["seb"] });
    expect(card.conditions!.imposed.find((c) => c.key === "duration")).toMatchObject({ bonusPercent: 25 });
    // The portal opens a plain exam, whose waiting room states them: the card carries none.
    expect(cards.get(plain.evaluationId)!.conditions).toBeNull();
    expect(body).not.toContain(catalogId);
    expect(body).not.toContain("catalogId");
  });

  it("give the phone's pairing list the kiosk exam's conditions, and never the catalog reference", async () => {
    const kioskSeed = await seedLive(db(), {
      teacherId: teacher.id,
      studentIds: [student.id],
      settings: { lobby: "manual", kiosk: true },
    });
    await patchConditions(kioskSeed.evaluationId, conditions);
    await applyState(db(), await reload(db(), kioskSeed.evaluationId), "running", server.clock.now());

    const pairable = await pairableEvaluations(db(), student.id, server.clock.now());
    const mine = pairable.find((e) => e.id === kioskSeed.evaluationId)!;
    expect(mine.conditions.announced.map((c) => c.text)).toEqual(["One A4 sheet of handwritten notes", "Mobile phones"]);
    expect(mine.conditions.imposed[0]).toEqual({ key: "trusted_client", kind: "forbidden", clients: ["kiosk"] });
    const body = JSON.stringify(pairable);
    expect(body).not.toContain(catalogId);
    expect(body).not.toContain("catalogId");
  });
});
