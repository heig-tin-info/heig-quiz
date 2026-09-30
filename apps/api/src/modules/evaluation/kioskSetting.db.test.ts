/**
 * ADR-051 §2: `settings.kiosk` is switched on only where the kiosk path
 * exists (`KIOSK_ATTESTATION` is not `off`), on both routes that write an
 * evaluation's settings — the evaluation's and the template's (the MCP tool
 * `update_evaluation` calls the first). Switching it off always passes, so an
 * exam left on after the platform turned the kiosk off can still be fixed.
 * Two servers, one after the other: the path off, then on (`mock`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";
import { registerForTests } from "@quiz/registry/server";

import { evaluations } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";

let restore: () => void;
beforeAll(() => {
  restore = registerForTests(fakeShort);
});
afterAll(() => restore());

type Caller = { id: string; headers: Record<string, string> };

/** A draft exam, and a template saved from it, of one teacher. */
async function world(server: TestServer) {
  const teacher: Caller = await server.signIn("teacher");
  const { evaluationId } = await seedLive(server.app.db, { teacherId: teacher.id, mode: "exam" });
  const saved = await server.app.inject({
    method: "POST",
    url: `/app/api/evaluations/${evaluationId}/template`,
    headers: teacher.headers,
    payload: { title: "Exam template" },
  });
  expect(saved.statusCode, saved.body).toBe(201);
  const templateId = saved.json().id as string;
  const patch = (url: string, settings: object) =>
    server.app.inject({ method: "PATCH", url, headers: teacher.headers, payload: { settings } });
  return {
    evaluationId,
    urls: [`/app/api/evaluations/${evaluationId}`, `/app/api/templates/${templateId}`],
    patch,
  };
}

describe("with no kiosk path (KIOSK_ATTESTATION=off)", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await testServer({ KIOSK_ATTESTATION: "off" });
  });
  afterAll(() => server.close());

  it("refuses to switch kiosk stations on, on an evaluation and on a template", async () => {
    const { urls, patch } = await world(server);
    for (const url of urls) {
      const res = await patch(url, { kiosk: true });
      expect(res.statusCode, url).toBe(422);
      expect(res.json().error).toBe("kiosk_unavailable");
    }
  });

  it("always lets it be switched off, and anything else patched, on an exam left on", async () => {
    const { evaluationId, urls, patch } = await world(server);
    const [row] = await server.app.db.select().from(evaluations).where(eq(evaluations.id, evaluationId));
    await server.app.db
      .update(evaluations)
      .set({ settings: { ...(row!.settings as object), kiosk: true } })
      .where(eq(evaluations.id, evaluationId));
    const other = await patch(urls[0]!, { shuffleItems: true });
    expect(other.statusCode, other.body).toBe(200);
    const off = await patch(urls[0]!, { kiosk: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().evaluation.settings.kiosk).toBe(false);
  });
});

describe("with a kiosk path (KIOSK_ATTESTATION=mock)", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await testServer({ KIOSK_ATTESTATION: "mock" });
  });
  afterAll(() => server.close());

  it("switches kiosk stations on, on an evaluation and on a template", async () => {
    const { urls, patch } = await world(server);
    for (const url of urls) {
      const res = await patch(url, { kiosk: true });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    }
  });

  it("says the path exists in the public configuration", async () => {
    const res = await server.app.inject({ method: "GET", url: "/app/api/config" });
    expect(res.json()).toMatchObject({ kiosk: { extensionId: null, mock: true } });
  });
});
