import { describe, expect, it } from "vitest";

import { EngineError } from "./engine.js";
import { gvisorWarning, probeEngine, proveRuntime, type PodmanRun } from "./probe.js";
import { testConfig } from "./test/config.js";
import { createFakeEngine, FAKE_CAPABILITIES, type FakeEngine } from "./test/fakeEngine.js";

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
      runtime: "crun",
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
      "run", "--rm", "--pull=never", "--userns=auto", "--network", "none",
      "quiz-runner-c:latest", "true",
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
    const forced = await probeEngine(testConfig({ RUNNER_USERNS_AUTO: "true" }), spawner({}).run);
    expect(forced.capabilities).toMatchObject({ usernsAuto: true });

    const off = spawner({ images: "localhost/quiz-runner-c:latest\n" });
    const refused = await probeEngine(testConfig({ RUNNER_USERNS_AUTO: "false" }), off.run);
    expect(refused.capabilities).toMatchObject({ usernsAuto: false });
    expect(off.calls.map((args) => args[0])).not.toContain("run");
  });

  it("records the engine's runtime, whatever RUNNER_RUNTIME demands", async () => {
    // A `--remote` client cannot choose the runtime: what the service runs is
    // what the containers get, and `RUNNER_RUNTIME=runsc` is checked against
    // it by `proveRuntime`, not imposed by a flag.
    const demanded = await probeEngine(testConfig({ RUNNER_RUNTIME: "runsc" }), spawner({}).run);
    expect(demanded.capabilities.runtime).toBe("crun");
    expect(demanded.notes).toContain("oci runtime crun, no gVisor");

    const gvisor = await probeEngine(
      testConfig(),
      spawner({ info: INFO({ ociRuntime: { name: "runsc" } }) }).run,
    );
    expect(gvisor.capabilities.runtime).toBe("runsc");
    expect(gvisor.notes.filter((note) => note.includes("gVisor"))).toEqual([]);
  });

  it("carries on with the defaults when `podman info` cannot be read", async () => {
    const podman = spawner({ info: new Error("cannot connect to podman") });
    const probed = await probeEngine(testConfig({ PODMAN_SOCKET: null }), podman.run);

    expect(probed.capabilities).toMatchObject({
      cgroupVersion: "unknown",
      runtime: null,
    });
    expect(probed.notes).toContain("podman info could not be parsed; assuming defaults");
  });
});

describe("gvisorWarning", () => {
  const caps = (runtime: string | null) => ({ ...FAKE_CAPABILITIES, runtime });

  it("speaks up under `auto` in production without gVisor, naming the runtime in use", () => {
    const prod = testConfig({ NODE_ENV: "production" });
    expect(gvisorWarning(prod, caps("crun"))).toMatch(
      /gVisor is NOT in use: student code runs under crun\./,
    );
    expect(gvisorWarning(prod, caps(null))).toMatch(/an unnamed runtime/);
  });

  it("is silent under gVisor, outside production, and under the explicit derogation `none`", () => {
    const prod = testConfig({ NODE_ENV: "production" });
    expect(gvisorWarning(prod, caps("runsc"))).toBeNull();
    expect(gvisorWarning(testConfig(), caps("crun"))).toBeNull();
    expect(gvisorWarning({ ...prod, RUNNER_RUNTIME: "none" }, caps("crun"))).toBeNull();
  });
});

/**
 * The fail-closed gate, against a fake engine. Against a real one it runs at
 * the start of every integration suite of the CI's runsc leg
 * (`test/integration.ts`).
 */
describe("proveRuntime", () => {
  const RUNSC = testConfig({ RUNNER_RUNTIME: "runsc" });
  const HOST = "6.8.0-1017-azure";

  function gvisorEngine(handler: Parameters<typeof createFakeEngine>[0] = () => ({ stdout: "4.4.0\n" })): FakeEngine {
    const engine = createFakeEngine(handler);
    return { ...engine, capabilities: { ...engine.capabilities, runtime: "runsc" } };
  }

  it("passes once a hardened container saw another kernel than the host's, and removes it", async () => {
    const engine = gvisorEngine();
    await proveRuntime(engine, RUNSC, HOST);

    expect(engine.created).toHaveLength(1);
    const proof = engine.created[0]!;
    expect(proof.image).toBe("quiz-runner-c:latest");
    expect(engine.calls.map((call) => [call.container, call.argv])).toEqual([
      [proof.name, ["uname", "-r"]],
    ]);
    expect(engine.removed).toEqual([proof.name]);
  });

  it("refuses an engine whose runtime is not runsc, before starting anything", async () => {
    const engine = createFakeEngine();
    await expect(proveRuntime(engine, RUNSC, HOST)).rejects.toThrow(
      /runs crun, not runsc; a --remote client rejects --runtime/,
    );
    expect(engine.created).toEqual([]);
  });

  it("refuses a container that shares the host's kernel", async () => {
    const engine = gvisorEngine(() => ({ stdout: `${HOST}\n` }));
    await expect(proveRuntime(engine, RUNSC, HOST)).rejects.toThrow(/the host's own/);
    expect(engine.removed).toHaveLength(1);
  });

  it("refuses when the container does not run, and still removes it", async () => {
    const engine = gvisorEngine(() => ({ exitCode: 125, stderr: "OCI runtime error: runsc" }));
    await expect(proveRuntime(engine, RUNSC, HOST)).rejects.toThrow(
      /no hardened container could run under gVisor \(podman exec failed \(125\): OCI runtime error/,
    );
    expect(engine.removed).toHaveLength(1);
  });

  it("refuses when the engine will not create it", async () => {
    const engine = gvisorEngine();
    const refusing: FakeEngine = {
      ...engine,
      create: () =>
        Promise.reject(new EngineError("podman run failed (126)", "runsc: unsupported flag")),
    };
    await expect(proveRuntime(refusing, RUNSC, HOST)).rejects.toThrow(/unsupported flag/);
  });

  it("refuses with no runner image to prove it on", async () => {
    const base = createFakeEngine();
    // `listImages` reads the images of the object it was made with.
    base.images = [];
    const engine: FakeEngine = { ...base, capabilities: { ...base.capabilities, runtime: "runsc" } };
    await expect(proveRuntime(engine, RUNSC, HOST)).rejects.toThrow(/no runner image/);
    expect(engine.created).toEqual([]);
  });

  it("proves nothing, and starts nothing, unless runsc is demanded", async () => {
    for (const RUNNER_RUNTIME of ["auto", "none"] as const) {
      const engine = createFakeEngine();
      await proveRuntime(engine, testConfig({ RUNNER_RUNTIME }), HOST);
      expect(engine.created).toEqual([]);
    }
  });
});
