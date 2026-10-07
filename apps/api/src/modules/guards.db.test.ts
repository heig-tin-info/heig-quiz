/**
 * `sitRefusal`, THE rule of the trusted clients (ADR-027, ADR-051 §2), over
 * the real application: every session kind that sits (portal, seb, kiosk)
 * against every combination of an exam's two switches, through the entry of
 * a sitting route. The test opens each session directly, a `kiosk` one on a
 * real station whose `quiz_kiosk` cookie rides along, so that the trust of
 * the session (`auth/trust.ts`) holds and `sitRefusal` is what decides. A
 * `seb` session is audited, not refused, while `SEB_CONFIG_KEY_ENFORCE` is
 * off (the default).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";
import type { SessionKind } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { createSession, CSRF_COOKIE, SESSION_COOKIE } from "../auth/session.js";
import { evaluations } from "../db/schema.js";
import { fakeShort } from "../test/fakeType.js";
import { testServer, type TestServer } from "../test/http.js";
import { kioskStation } from "../test/kiosk.js";
import { seedLive } from "../test/live.js";

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

/** A running evaluation with one seated student, and its two switches as given. */
async function running(settings: { safeExamBrowser?: boolean; kiosk?: boolean }, mode: "exam" | "exercise" = "exam") {
  const student = await server.signIn("student");
  const teacher = await server.signIn("teacher");
  const seeded = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], mode, settings });
  const started = await server.app.inject({
    method: "POST",
    url: `/app/api/evaluations/${seeded.evaluationId}/start`,
    headers: teacher.headers,
    payload: { confirm: true },
  });
  expect(started.statusCode, started.body).toBe(200);
  return { evaluationId: seeded.evaluationId, student };
}

async function headersOf(userId: string, kind: SessionKind, evaluationId: string | null) {
  const station = kind === "kiosk" ? await kioskStation(server.app) : null;
  const s = await createSession(server.app.db, userId, 12, {
    kind,
    actorUserId: null,
    evaluationId,
    projectId: null,
    deviceId: station?.deviceId ?? null,
  });
  const cookie = `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`;
  return { cookie: station ? `${cookie}; ${station.cookie}` : cookie, "x-csrf-token": s.csrf };
}

const enter = (evaluationId: string, headers: Record<string, string>) =>
  server.app.inject({ method: "POST", url: `/app/api/evaluations/${evaluationId}/attempt`, headers, payload: {} });

/** Who sits, per the exam's switches: the table of ADR-051 §2. */
const MATRIX = [
  ["neither switch", {}, ["portal"]],
  ["SEB only", { safeExamBrowser: true }, ["seb"]],
  ["kiosk only", { kiosk: true }, ["kiosk"]],
  ["both", { safeExamBrowser: true, kiosk: true }, ["seb", "kiosk"]],
] as const;

describe("sitRefusal (ADR-051 §2)", () => {
  it.each(MATRIX)("an exam with %s is sat by %j only", async (_name, settings, sitters) => {
    const { evaluationId, student } = await running(settings);
    for (const kind of ["portal", "seb", "kiosk"] as const) {
      const headers = await headersOf(student.id, kind, kind === "portal" ? null : evaluationId);
      const res = await enter(evaluationId, headers);
      expect(res.statusCode, `${kind}: ${res.body}`).toBe((sitters as readonly string[]).includes(kind) ? 200 : 404);
    }
  });

  it("confines a seb or kiosk session to its own evaluation, even one that accepts its kind", async () => {
    const mine = await running({ safeExamBrowser: true, kiosk: true });
    const theirs = await running({ safeExamBrowser: true, kiosk: true });
    for (const kind of ["seb", "kiosk"] as const) {
      const headers = await headersOf(mine.student.id, kind, theirs.evaluationId);
      expect((await enter(mine.evaluationId, headers)).statusCode, kind).toBe(404);
    }
  });

  it("is inert on an exercise: its switches are an exam's, so the portal sits it", async () => {
    const { evaluationId, student } = await running({ safeExamBrowser: true, kiosk: true }, "exercise");
    expect((await enter(evaluationId, student.headers)).statusCode).toBe(200);
    const kiosk = await headersOf(student.id, "kiosk", evaluationId);
    expect((await enter(evaluationId, kiosk)).statusCode).toBe(404);
  });

  it("holds the room restriction for a kiosk session too (F-EVAL-12)", async () => {
    const { evaluationId, student } = await running({ kiosk: true });
    await server.app.db.update(evaluations).set({ ipAllowlist: ["10.20."] }).where(eq(evaluations.id, evaluationId));
    const kiosk = await headersOf(student.id, "kiosk", evaluationId);
    const outside = await enter(evaluationId, { ...kiosk, "x-forwarded-for": "203.0.113.9" });
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error).toBe("ip_not_allowed");
    const inRoom = await enter(evaluationId, { ...kiosk, "x-forwarded-for": "10.20.0.7" });
    expect(inRoom.statusCode).toBe(200);
  });
});
