import { describe, expect, it } from "vitest";

import { probeEngine, type PodmanRun } from "./probe.js";
import { testConfig } from "./test/config.js";

/**
 * The startup probe, against an injected spawner.
 *
 * What it decides — `--userns=auto` on or off, gVisor or not — is decided ONCE
 * and then applies to every container of the process's life, so getting it
 * wrong is getting the hardening of a whole deployment wrong. None of it needs
 * Podman to be tested: the answers are strings.
 */

const INFO = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    host: {
      security: { rootless: true },
      cgroupVersion: "v2",
      ociRuntime: { name: "crun" },
      ...overrides,
    },
  });

/** A `podman` that answers from a table and records what it was asked. */
function spawner(answers: {
  version?: string;
  info?: string | Error;
  images?: string;
  run?: Error;
}): { run: PodmanRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: PodmanRun = async (args) => {
    calls.push(args);
    if (args[0] === "--version") return answers.version ?? "podman version 5.2.0\n";
    if (args[0] === "info") {
      const info = answers.info ?? INFO();
      if (info instanceof Error) throw info;
      return info;
    }
    if (args[0] === "images") return answers.images ?? "";
    if (args[0] === "run") {
      if (answers.run !== undefined) throw answers.run;
      return "";
    }
    throw new Error(`unexpected podman ${args.join(" ")}`);
  };
  return { run, calls };
}

describe("probeEngine", () => {
  it("reads the version, the cgroups and the OCI runtime from ONE podman info", async () => {
    const podman = spawner({ info: INFO({ security: { rootless: false } }) });
    const probed = await probeEngine(testConfig(), podman.run);

    expect(probed.capabilities).toMatchObject({
      version: "podman version 5.2.0",
      rootless: false,
      remote: true,
      cgroupVersion: "v2",
      runtime: null,
    });
    // Two round trips for one answer is what a second `info --format
    // {{.Host.OCIRuntime.Name}}` was: the JSON already carries it.
    expect(podman.calls.filter((args) => args[0] === "info")).toHaveLength(1);
    expect(probed.notes).toEqual(["oci runtime crun, no gVisor"]);
  });

  it("says `remote` exactly when a socket is configured", async () => {
    const withSocket = await probeEngine(testConfig(), spawner({}).run);
    expect(withSocket.capabilities.remote).toBe(true);
    const local = await probeEngine(testConfig({ PODMAN_SOCKET: null }), spawner({}).run);
    expect(local.capabilities.remote).toBe(false);
  });

  it("takes --userns=auto for granted on a rootful engine, starting nothing", async () => {
    const podman = spawner({ info: INFO({ security: { rootless: false } }) });
    const probed = await probeEngine(testConfig(), podman.run);

    expect(probed.capabilities.usernsAuto).toBe(true);
    expect(podman.calls.map((args) => args[0])).not.toContain("run");
  });

  it("tries it once, on a real runner image, when the engine is rootless", async () => {
    const podman = spawner({
      images: "localhost/quiz-runner-c:latest\ndocker.io/library/alpine:3.20\n",
    });
    const probed = await probeEngine(testConfig(), podman.run);

    expect(probed.capabilities.usernsAuto).toBe(true);
    expect(probed.notes).toEqual(["oci runtime crun, no gVisor"]);
    // The short name Podman takes on a command line, and the flags of a probe
    // that must not touch anything: nothing kept, no network.
    expect(podman.calls.find((args) => args[0] === "run")).toEqual([
      "run", "--rm", "--userns=auto", "--network", "none", "quiz-runner-c:latest", "true",
    ]);
  });

  it("drops the flag, with a note, when no runner image is there to probe with", async () => {
    // An image of something else is not a runner image: probing `alpine` would
    // answer a question about `alpine`.
    const podman = spawner({ images: "docker.io/library/alpine:3.20\n" });
    const probed = await probeEngine(testConfig(), podman.run);

    expect(probed.capabilities.usernsAuto).toBe(false);
    expect(probed.notes).toContain("no runner image to probe --userns=auto with: flag not passed");
    expect(podman.calls.map((args) => args[0])).not.toContain("run");
  });

  it("drops the flag, with a note, when the probe container refuses to start", async () => {
    const podman = spawner({
      images: "localhost/quiz-runner-c:latest\n",
      run: new Error("/etc/subuid: no subuid ranges found"),
    });
    const probed = await probeEngine(testConfig(), podman.run);

    expect(probed.capabilities.usernsAuto).toBe(false);
    expect(probed.notes).toContain(
      "rootless engine without a usable --userns=auto: flag not passed",
    );
  });

  it("obeys the configuration when it is not `auto`", async () => {
    const forced = await probeEngine(
      testConfig({ RUNNER_USERNS_AUTO: "true", RUNNER_RUNTIME: "runsc" }),
      spawner({}).run,
    );
    expect(forced.capabilities).toMatchObject({ usernsAuto: true, runtime: "runsc" });

    const off = spawner({ images: "localhost/quiz-runner-c:latest\n" });
    const refused = await probeEngine(
      testConfig({ RUNNER_USERNS_AUTO: "false", RUNNER_RUNTIME: "none" }),
      off.run,
    );
    expect(refused.capabilities).toMatchObject({ usernsAuto: false, runtime: null });
    expect(off.calls.map((args) => args[0])).not.toContain("run");
  });

  it("carries on with the defaults when `podman info` cannot be read", async () => {
    const podman = spawner({ info: new Error("cannot connect to podman") });
    const probed = await probeEngine(testConfig({ PODMAN_SOCKET: null }), podman.run);

    expect(probed.capabilities).toMatchObject({ cgroupVersion: "unknown", runtime: null });
    expect(probed.notes).toContain("podman info could not be parsed; assuming defaults");
  });
});
