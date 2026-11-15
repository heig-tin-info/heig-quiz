/**
 * The close of a kiosk sitting as Quiz sends it (ADR-089, amendment point 4):
 * the message the portal's `POST /api/sittings/close` reads, and the
 * answers that make a job retry. The portal's side is tested in
 * `apps/codespace` (`sessions/sittings.test.ts`, `classroom/routes.test.ts`).
 */
import { SITTING_CLOSE_AUDIENCE, SittingCloseClaims } from "@quiz/contracts";
import { verifyHs256 } from "@quiz/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendSittingClose } from "./service.js";

const CONFIG = { CODESPACE_URL: "https://code.test", CODESPACE_LAUNCH_SECRET: "a-test-launch-secret-0123456789" };
const CLOSE = { sitting: "6f1c2a3b-0000-4000-8000-0000000000a1", projectId: "6f1c2a3b-0000-4000-8000-0000000000b1" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function portal(status: number): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status });
  });
  return calls;
}

describe("sendSittingClose", () => {
  it("posts the close as its own bearer token, which the portal's schema reads", async () => {
    const calls = portal(204);
    await sendSittingClose(CONFIG, CLOSE, new Date());
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://code.test/api/sittings/close");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBeUndefined();
    const token = String((call?.init.headers as Record<string, string>).authorization).replace(/^Bearer /, "");
    const verdict = await verifyHs256<Record<string, unknown>>(token, CONFIG.CODESPACE_LAUNCH_SECRET, {
      audience: SITTING_CLOSE_AUDIENCE,
      issuer: "heig-quiz",
      requireJti: true,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(SittingCloseClaims.parse(verdict.claims)).toMatchObject(CLOSE);
  });

  it("throws on any other answer, so the job retries", async () => {
    portal(401);
    await expect(sendSittingClose(CONFIG, { ...CLOSE, projectId: null }, new Date())).rejects.toThrow("401");
  });
});
