/**
 * The calculator an evaluation provides (ADR-069), over the REAL application:
 * the setting travels through a patch, is refused on a poll, is announced in
 * the waiting room and reaches the player inside the attempt's settings.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AttemptOrLobby } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { evaluations } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState } from "../evaluation/service.js";

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-10-04T08:00:00.000Z");
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
});
afterAll(async () => {
  await server.close();
  restore();
});

const db = () => server.app.db;
const send = (method: "POST" | "PATCH", url: string, headers: Record<string, string>, payload: Payload = {}) =>
  server.app.inject({ method, url, headers, payload });

const seed = (mode: "exam" | "poll" = "exam") =>
  seedLive(db(), {
    teacherId: teacher.id,
    studentIds: [student.id],
    mode,
    settings: { lobby: "manual" },
  });

describe("the calculator setting", () => {
  it("is refused on a poll, switching it off passing", async () => {
    const { evaluationId } = await seed();
    await db().update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, evaluationId));
    const url = `/app/api/evaluations/${evaluationId}`;
    const refused = await send("PATCH", url, teacher.headers, { settings: { calculator: "standard" } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: "calculator_not_allowed" });
    const off = await send("PATCH", url, teacher.headers, { settings: { calculator: "none" } });
    expect(off.statusCode).toBe(200);
  });

  it("is announced in the waiting room, and reaches the player", async () => {
    const lobbyOf = async (evaluationId: string) => {
      await applyState(db(), await reload(db(), evaluationId), "lobby", server.clock.now());
      return (await send("POST", `/app/api/evaluations/${evaluationId}/attempt`, student.headers)).json() as AttemptOrLobby;
    };
    const without = await seed();
    const lobbyWithout = await lobbyOf(without.evaluationId);
    expect(lobbyWithout.kind === "lobby" && lobbyWithout.view.calculator).toBe("none");

    const { evaluationId } = await seed();
    const set = await send("PATCH", `/app/api/evaluations/${evaluationId}`, teacher.headers, {
      settings: { calculator: "standard" },
    });
    expect(set.statusCode).toBe(200);
    const lobby = await lobbyOf(evaluationId);
    expect(lobby.kind === "lobby" && lobby.view.calculator).toBe("standard");

    await applyState(db(), await reload(db(), evaluationId), "running", server.clock.now());
    const url = `/app/api/evaluations/${evaluationId}/attempt`;
    const entered = (await send("POST", url, student.headers)).json() as AttemptOrLobby;
    expect(entered.kind === "attempt" && entered.view.evaluation.settings.calculator).toBe("standard");
  });
});
