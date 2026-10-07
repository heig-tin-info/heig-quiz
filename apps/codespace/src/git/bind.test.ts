/**
 * The git channel's bind (M6-04): the `0.0.0.0` fallback exists for a
 * workstation only. In production, and for every named instance (two bridges
 * on one host), a gateway that is not on the machine fails the start.
 */
import { describe, expect, it } from "vitest";

import { openGitDb } from "../db/client.js";
import { strictGitBind } from "../server.js";

import { startGitServer } from "./httpBackend.js";
import { createPushEventStore } from "./pushEvents.js";

/** TEST-NET-1: never an address of this machine, so the bind gets EADDRNOTAVAIL. */
const ABSENT_GATEWAY = "192.0.2.1";

function options(strictBind: boolean) {
  return {
    sessions: { byIp: () => undefined, byId: () => undefined },
    store: createPushEventStore(openGitDb(":memory:").db),
    volumesRoot: "/nonexistent",
    host: ABSENT_GATEWAY,
    port: 0,
    strictBind,
  } as unknown as Parameters<typeof startGitServer>[0];
}

describe("git channel bind", () => {
  it("falls back to 0.0.0.0 when not strict (a workstation)", async () => {
    const started = await startGitServer(options(false));
    expect(started.host).toBe("0.0.0.0");
    await started.app.close();
  });

  it("refuses to start when strict and the gateway is absent", async () => {
    await expect(startGitServer(options(true))).rejects.toThrow();
  });

  it("is strict in production and for every named instance", () => {
    expect(strictGitBind({ NODE_ENV: "development", CODESPACE_INSTANCE: "default" })).toBe(false);
    expect(strictGitBind({ NODE_ENV: "production", CODESPACE_INSTANCE: "default" })).toBe(true);
    expect(strictGitBind({ NODE_ENV: "development", CODESPACE_INSTANCE: "staging" })).toBe(true);
    expect(strictGitBind({ NODE_ENV: "test", CODESPACE_INSTANCE: "prod" })).toBe(true);
  });
});
