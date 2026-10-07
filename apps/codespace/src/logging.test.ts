/**
 * A launch token is a live single-use credential in a query string, and a
 * service token rides in `Authorization`: neither may reach the request log.
 * A real portal is built with its log captured, then searched.
 */
import { signHs256 } from "@quiz/domain";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "./auth/config.js";
import { openDb, type DbHandle } from "./db/client.js";
import type { Engine } from "./engine/index.js";
import { redactUrl } from "./logging.js";
import { buildPortal, type Portal } from "./server.js";

const SECRET = "test-launch-secret-0123456789012345";
const engine = { listSessions: async () => [] } as unknown as Engine;

let handle: DbHandle | null = null;
let portal: Portal | null = null;
afterEach(async () => {
  await portal?.close();
  handle?.close();
  portal = null;
  handle = null;
});

describe("redactUrl", () => {
  it("masks the token parameter and keeps the rest", () => {
    expect(redactUrl("/launch?token=abc.def.ghi")).toBe("/launch?token=%E2%80%A6");
    expect(redactUrl("/launch?x=1&token=abc")).toBe("/launch?x=1&token=%E2%80%A6");
    expect(redactUrl("/s/s1/?folder=/work")).toBe("/s/s1/?folder=/work");
    expect(redactUrl("/healthz")).toBe("/healthz");
  });
});

describe("the request log", () => {
  it("carries neither a launch token, nor a service token, nor a cookie", async () => {
    const lines: string[] = [];
    handle = openDb(":memory:");
    portal = await buildPortal({
      config: loadConfig({ LOG_LEVEL: "info", SEB_VERIFIER: "simulated", CODESPACE_LAUNCH_SECRET: SECRET }),
      dbHandle: handle,
      engine,
      withGitServer: false,
      withTimers: false,
      logStream: { write: (line) => void lines.push(line) },
    });
    const now = Math.floor(Date.now() / 1000);
    const launch = await signHs256(
      { iss: "heig-quiz", aud: "heig-codespace", iat: now, exp: now + 300, jti: "j-log", sub: "u1" },
      SECRET,
    );
    const service = await signHs256(
      { iss: "heig-quiz", aud: "heig-codespace-api", iat: now, exp: now + 120 },
      SECRET,
    );

    await portal.app.inject({
      url: `/launch?token=${launch}`,
      headers: { cookie: "cs_session=s1.cookie-secret-value; exam_session=exam-secret-value" },
    });
    await portal.app.inject({
      url: "/api/assignments/a1/sessions",
      headers: { authorization: `Bearer ${service}` },
    });

    const log = lines.join("");
    expect(log).toContain("/launch?token=");
    expect(log).toContain("/api/assignments/a1/sessions");
    for (const secret of [launch, service, "cookie-secret-value", "exam-secret-value"]) {
      expect(log).not.toContain(secret);
    }
    // Not even a fragment of the JWT: its signature part alone.
    expect(log).not.toContain(launch.split(".")[2]);
  });
});
