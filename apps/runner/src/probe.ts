import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { remoteArgs, type EngineCapabilities } from "./engine.js";
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

  // gVisor: used when the host has it and the configuration did not forbid it.
  // This machine has none; the production VM may grow one without a code
  // change. The runtime comes out of the `info` above — asking a second time,
  // with another format string, was two round trips for one answer.
  let runtime: string | null = null;
  if (config.RUNNER_RUNTIME === "runsc") {
    runtime = "runsc";
  } else if (config.RUNNER_RUNTIME === "auto") {
    runtime = hostRuntime === "runsc" ? "runsc" : null;
    if (runtime === null && hostRuntime !== null) {
      notes.push(`oci runtime ${hostRuntime}, no gVisor`);
    }
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
      runtime,
      cgroupVersion,
    },
    notes,
  };
}
