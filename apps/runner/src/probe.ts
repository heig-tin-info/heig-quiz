import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { release as osRelease } from "node:os";
import { promisify } from "node:util";

import { EngineError, remoteArgs, type Engine, type EngineCapabilities } from "./engine.js";
import { availableLanguages, imageRef } from "./images.js";
import type { RunnerConfig } from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * What the engine can do, asked once at startup and never again.
 *
 * The hardening flags are not negotiated per request: they are decided here,
 * logged, and then identical for every container of the process's life. A
 * machine that cannot do `--userns=auto` runs with one layer less and says so
 * in its logs — it does not silently retry without it in the middle of a
 * grading pass.
 */
export interface ProbeResult {
  capabilities: EngineCapabilities;
  /** Why `--userns=auto` is off, when it is off and was not asked to be. */
  notes: string[];
}

interface PodmanInfo {
  host?: {
    security?: { rootless?: boolean };
    cgroupVersion?: string;
    ociRuntime?: { name?: string };
  };
}

/** One `podman` command, its stdout. Injected by the unit test. */
export type PodmanRun = (args: string[], timeoutMs?: number) => Promise<string>;

/**
 * The real spawner: the connection flags of invariant 13, then the command.
 *
 * It is not `engine.ts`'s: the probe answers the very question the engine's
 * options are built from, so it runs before an `Engine` exists. What it does
 * share is `remoteArgs`, which is the part that must not drift.
 */
export function podmanRun(config: RunnerConfig): PodmanRun {
  const base = remoteArgs(config.PODMAN_SOCKET);
  return async (args, timeoutMs = 30_000) => {
    const { stdout } = await execFileAsync(config.PODMAN_BIN, [...base, ...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  };
}

/**
 * A runner image to try `--userns=auto` on, or `null`.
 *
 * It reads the image list with the same rule `GET /health` answers with
 * (`availableLanguages`), so the probe cannot pick something the service would
 * never run — and it names it the short way, which is what the command line
 * takes.
 */
async function probeImage(run: PodmanRun, config: RunnerConfig): Promise<string | null> {
  const images = await run(["images", "--format", "{{.Repository}}:{{.Tag}}"]).catch(() => "");
  const language = availableLanguages(images.split("\n"), config)[0];
  return language === undefined ? null : imageRef(config, language);
}

export async function probeEngine(
  config: RunnerConfig,
  run: PodmanRun = podmanRun(config),
): Promise<ProbeResult> {
  const notes: string[] = [];

  const version = (await run(["--version"])).trim();

  let rootless = config.PODMAN_SOCKET === null;
  let cgroupVersion = "unknown";
  let hostRuntime: string | null = null;
  try {
    const info = JSON.parse(await run(["info", "--format", "json"])) as PodmanInfo;
    rootless = info.host?.security?.rootless ?? rootless;
    cgroupVersion = info.host?.cgroupVersion ?? "unknown";
    hostRuntime = info.host?.ociRuntime?.name ?? null;
  } catch {
    notes.push("podman info could not be parsed; assuming defaults");
  }

  // gVisor is the engine's default runtime or nothing: a `--remote` client
  // cannot choose the runtime of a container (`EngineCapabilities.runtime`).
  // So this only RECORDS what the engine runs; `RUNNER_RUNTIME=runsc` turns
  // it into a demand that `proveRuntime` enforces (fail-closed), and a
  // production runner without it warns (`gvisorWarning`). The runtime comes
  // out of the `info` above — asking a second time, with another format
  // string, was two round trips for one answer.
  if (hostRuntime !== null && hostRuntime !== "runsc") {
    notes.push(`oci runtime ${hostRuntime}, no gVisor`);
  }

  let usernsAuto = config.RUNNER_USERNS_AUTO === "true";
  if (config.RUNNER_USERNS_AUTO === "auto") {
    if (!rootless) {
      // Rootful Podman always has the subuid range `--userns=auto` carves
      // from: no probe, no container start at boot.
      usernsAuto = true;
    } else {
      // Rootless only has it when /etc/subuid gives the user a large enough
      // allocation, so the only honest answer is to try it once, on a real
      // image, before any request arrives.
      const image = await probeImage(run, config);
      if (image === null) {
        usernsAuto = false;
        notes.push("no runner image to probe --userns=auto with: flag not passed");
      } else {
        // `--pull=never`: the reference is the short one the service uses, and
        // a host that somehow resolved it to a registry must not start a boot
        // by downloading something. The runner never pulls (README).
        usernsAuto = await run(
          ["run", "--rm", "--pull=never", "--userns=auto", "--network", "none", image, "true"],
          60_000,
        )
          .then(() => true)
          .catch(() => false);
        if (!usernsAuto) {
          notes.push("rootless engine without a usable --userns=auto: flag not passed");
        }
      }
    }
  }

  return {
    capabilities: {
      version,
      rootless,
      remote: config.PODMAN_SOCKET !== null,
      usernsAuto,
      runtime: hostRuntime,
      cgroupVersion,
    },
    notes,
  };
}

/**
 * The line a production runner without gVisor logs at startup and on every
 * `GET /health`, or `null`.
 *
 * N-SEC-06 requires gVisor, but production only REFUSES to start without it
 * when `RUNNER_RUNTIME=runsc` says so (`proveRuntime`): the switch is flipped
 * by the operator once runsc is installed on the VM, never by a deploy. Until
 * then the omission is loud rather than silent (ADR-016, audit M6).
 */
export function gvisorWarning(
  config: RunnerConfig,
  capabilities: EngineCapabilities,
): string | null {
  if (config.NODE_ENV !== "production" || capabilities.runtime === "runsc") return null;
  return (
    `gVisor is NOT in use: student code runs under ${capabilities.runtime ?? "an unnamed runtime"} ` +
    `(RUNNER_RUNTIME=${config.RUNNER_RUNTIME}). N-SEC-06 requires it: run deploy/install-gvisor.sh, ` +
    "then set PODMAN_SOCKET to its service and RUNNER_RUNTIME=runsc (apps/runner/README.md, In production)."
  );
}

/** The container `proveRuntime` starts: small, short-lived, hardened like any other. */
const PROOF_TTL_SECONDS = 60;

/**
 * Fail-closed: with `RUNNER_RUNTIME=runsc`, the service accepts nothing until
 *
 *  1. the engine names `runsc` as its runtime — a `--remote` client cannot
 *     ask for it per container, so `PODMAN_SOCKET` must reach a Podman
 *     service whose DEFAULT runtime is runsc (`deploy/install-gvisor.sh`);
 *  2. a container created with EXACTLY the argv of a student's run
 *     (`containerArgs`) runs a command through `podman exec`;
 *  3. and that command sees a kernel that is not the host's: `uname -r` in a
 *     gVisor sandbox answers the Sentry's release, so a container that fell
 *     back to crun or runc — which share the host kernel — fails here.
 *
 * Throws otherwise; the caller refuses to start (`buildApp`), the quadlet
 * restarts it, `/healthz` reports the runner down and the status alert fires.
 * Without it, a missing runsc, or one that cannot honour a flag, is a runner
 * whose `/health` says ok while every run fails with an `engine_error` — and
 * every code answer falls back to a hand-graded proposal.
 *
 * Any other `RUNNER_RUNTIME` proves nothing here and returns at once.
 */
export async function proveRuntime(
  engine: Engine,
  config: RunnerConfig,
  hostRelease: string = osRelease(),
): Promise<void> {
  if (config.RUNNER_RUNTIME !== "runsc") return;
  const refuse = (why: string, cause?: unknown): Error =>
    new Error(`RUNNER_RUNTIME=runsc: ${why}`, cause === undefined ? undefined : { cause });

  if (engine.capabilities.runtime !== "runsc") {
    throw refuse(
      `the Podman service at ${config.PODMAN_SOCKET ?? "the local CLI"} runs ` +
        `${engine.capabilities.runtime ?? "an unnamed runtime"}, not runsc; a --remote client ` +
        "cannot choose the runtime, so PODMAN_SOCKET must reach a service whose default is runsc " +
        "(deploy/install-gvisor.sh)",
    );
  }
  const language = availableLanguages(await engine.listImages(), config)[0];
  if (language === undefined) {
    throw refuse("no runner image to prove gVisor with (images/build.sh)");
  }
  const name = `quiz-runtime-proof-${randomUUID()}`;
  let kernel: string;
  try {
    await engine.create({
      name,
      image: imageRef(config, language),
      memoryMb: Math.min(128, config.RUNNER_MAX_MEMORY_MB),
      pidsLimit: 64,
      cpus: 1,
      workdirMb: config.RUNNER_WORKDIR_MB,
      ttlSeconds: PROOF_TTL_SECONDS,
    });
    const ran = await engine.exec(name, {
      argv: ["uname", "-r"],
      stdin: "",
      timeoutMs: 30_000,
      maxBytes: 16 * 1024,
    });
    if (ran.exitCode !== 0) {
      throw new EngineError(`podman exec failed (${ran.exitCode ?? "killed"})`, ran.stderr);
    }
    kernel = ran.stdout.trim();
  } catch (error) {
    const detail =
      error instanceof EngineError ? `${error.message}: ${error.stderr.trim()}` : String(error);
    throw refuse(`no hardened container could run under gVisor (${detail})`, error);
  } finally {
    await engine.remove(name).catch(() => undefined);
  }
  if (kernel === "" || kernel === hostRelease) {
    throw refuse(
      `the container saw kernel ${kernel || "(nothing)"}, the host's own: it did not run under gVisor`,
    );
  }
}
