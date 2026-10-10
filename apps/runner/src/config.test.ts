import { describe, expect, it } from "vitest";

import { defaultSeccompPath, isLoopback, loadConfig } from "./config.js";

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

  it("listens on the loopback by default", () => {
    const config = loadConfig({ PODMAN_SOCKET: "/tmp/x.sock", RUNNER_SECCOMP: SECCOMP });
    expect(config.HOST).toBe("127.0.0.1");
    expect(config.RUNNER_TOKEN).toBe("");
  });

  it("refuses a public bind without a token, and accepts one with it (audit L13)", () => {
    const base = { PODMAN_SOCKET: "/tmp/x.sock", RUNNER_SECCOMP: SECCOMP };
    for (const HOST of ["127.0.0.1", "127.0.1.1", "::1", "0:0:0:0:0:0:0:1", "localhost", " 127.0.0.1 "]) {
      expect(() => loadConfig({ ...base, HOST }), HOST).not.toThrow();
    }
    for (const HOST of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.2", "fe80::1", "runner.local"]) {
      expect(() => loadConfig({ ...base, HOST }), HOST).toThrow(
        new RegExp(`RUNNER_TOKEN is required to listen on ${HOST.replace(/[.]/g, "\\.")}`),
      );
      expect(() => loadConfig({ ...base, HOST, RUNNER_TOKEN: "   " }), HOST).toThrow(/RUNNER_TOKEN/);
      expect(loadConfig({ ...base, HOST, RUNNER_TOKEN: "s3cret" }).HOST).toBe(HOST);
    }
  });

  it("tells the loopback from everything else", () => {
    expect(["127.0.0.1", "127.255.255.254", "::1", "::ffff:127.0.0.1", "LOCALHOST"].map(isLoopback)).toEqual([
      true, true, true, true, true,
    ]);
    expect(["0.0.0.0", "::", "128.0.0.1", "126.255.255.255", "::2", "", "127.0.0.1.example"].map(isLoopback)).toEqual([
      false, false, false, false, false, false, false,
    ]);
  });

  it("takes a slice unit name as the cgroup parent, and nothing else", () => {
    const base = { PODMAN_SOCKET: "/tmp/x.sock", RUNNER_SECCOMP: SECCOMP };
    expect(loadConfig(base).RUNNER_CGROUP_PARENT).toBeNull();
    expect(loadConfig({ ...base, RUNNER_CGROUP_PARENT: " " }).RUNNER_CGROUP_PARENT).toBeNull();
    expect(
      loadConfig({ ...base, RUNNER_CGROUP_PARENT: "quiz-runner.slice" }).RUNNER_CGROUP_PARENT,
    ).toBe("quiz-runner.slice");
    for (const bad of ["/sys/fs/cgroup/x", "quiz-runner", "-x.slice", "a b.slice", "a/b.slice"]) {
      expect(() => loadConfig({ ...base, RUNNER_CGROUP_PARENT: bad }), bad).toThrow(
        /RUNNER_CGROUP_PARENT/,
      );
    }
  });

  it("refuses a configuration it cannot make sense of", () => {
    expect(() =>
      loadConfig({ PORT: "not-a-port", PODMAN_SOCKET: "/tmp/x.sock", RUNNER_SECCOMP: SECCOMP }),
    ).toThrow(/Invalid configuration/);
  });
});
