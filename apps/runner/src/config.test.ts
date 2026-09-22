import { describe, expect, it } from "vitest";

import { defaultSeccompPath, loadConfig } from "./config.js";

const SECCOMP = defaultSeccompPath();

describe("loadConfig", () => {
  it("defaults to the port, the pool and the limits of the plan", () => {
    const config = loadConfig({ PODMAN_SOCKET: "/tmp/x.sock", RUNNER_SECCOMP: SECCOMP });
    expect(config).toMatchObject({
      PORT: 3200,
      RUNNER_CONCURRENCY: 4,
      RUNNER_QUEUE_MAX: 32,
      RUNNER_IMAGE_PREFIX: "quiz-runner",
      RUNNER_WORKDIR_MB: 32,
      RUNNER_USERNS_AUTO: "auto",
    });
  });

  it("caps a request at the schema's own maxima until an operator lowers one", () => {
    // The three ceilings default to `RunnerRequest.limits`'s upper bounds
    // (packages/core/src/runner.ts), so a fresh deployment clamps nothing.
    const config = loadConfig({ PODMAN_SOCKET: "/tmp/x.sock", RUNNER_SECCOMP: SECCOMP });
    expect(config).toMatchObject({
      RUNNER_MAX_OUTPUT_KB: 256,
      RUNNER_MAX_MEMORY_MB: 512,
      RUNNER_MAX_TIME_MS: 20_000,
    });
    const tight = loadConfig({
      PODMAN_SOCKET: "/tmp/x.sock",
      RUNNER_SECCOMP: SECCOMP,
      RUNNER_MAX_MEMORY_MB: "128",
      RUNNER_MAX_TIME_MS: "3000",
    });
    expect(tight).toMatchObject({ RUNNER_MAX_MEMORY_MB: 128, RUNNER_MAX_TIME_MS: 3000 });
  });

  it("ships a seccomp profile of its own and refuses to start without one", () => {
    expect(loadConfig({ PODMAN_SOCKET: "/tmp/x.sock" }).RUNNER_SECCOMP).toBe(SECCOMP);
    expect(() =>
      loadConfig({ PODMAN_SOCKET: "/tmp/x.sock", RUNNER_SECCOMP: "/nowhere/profile.json" }),
    ).toThrow(/seccomp profile not found/);
  });

  it("drops the socket, and only the socket, when asked for the local CLI", () => {
    const config = loadConfig({
      PODMAN_SOCKET: "/run/podman/podman.sock",
      PODMAN_REMOTE: "false",
      RUNNER_SECCOMP: SECCOMP,
    });
    expect(config.PODMAN_SOCKET).toBeNull();
  });

  it("requires the shared token in production, and trims it", () => {
    const base = { PODMAN_SOCKET: "/tmp/x.sock", RUNNER_SECCOMP: SECCOMP };
    expect(loadConfig(base).RUNNER_TOKEN).toBe("");
    expect(loadConfig({ ...base, RUNNER_TOKEN: " s3cret " }).RUNNER_TOKEN).toBe("s3cret");
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/RUNNER_TOKEN/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", RUNNER_TOKEN: "  " })).toThrow(
      /RUNNER_TOKEN/,
    );
    expect(loadConfig({ ...base, NODE_ENV: "production", RUNNER_TOKEN: "x" }).RUNNER_TOKEN).toBe(
      "x",
    );
  });

  it("refuses a configuration it cannot make sense of", () => {
    expect(() =>
      loadConfig({ PORT: "not-a-port", PODMAN_SOCKET: "/tmp/x.sock", RUNNER_SECCOMP: SECCOMP }),
    ).toThrow(/Invalid configuration/);
  });
});
