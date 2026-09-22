import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { remoteArgs, type EngineCapabilities } from "./engine.js";
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

type Run = (args: string[], timeout?: number) => Promise<string>;

/** Any runner image will do to find out whether `--userns=auto` starts. */
async function probeImage(run: Run, config: RunnerConfig): Promise<string | null> {
  const images = await run(["images", "--format", "{{.Repository}}:{{.Tag}}"]).catch(() => "");
  const found = images
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.includes(`${config.RUNNER_IMAGE_PREFIX}-`));
  return found ?? null;
}

export async function probeEngine(config: RunnerConfig): Promise<ProbeResult> {
  const base = remoteArgs(config.PODMAN_SOCKET);
  const notes: string[] = [];

  const run = async (args: string[], timeout = 30_000): Promise<string> => {
    const { stdout } = await execFileAsync(config.PODMAN_BIN, [...base, ...args], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  };

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
  // This machine has none; the production VM may grow one without a code change.
  let runtime: string | null = null;
  if (config.RUNNER_RUNTIME === "runsc") {
    runtime = "runsc";
  } else if (config.RUNNER_RUNTIME === "auto") {
    const hasRunsc = await run(["info", "--format", "{{.Host.OCIRuntime.Name}}"])
      .then((out) => out.trim() === "runsc")
      .catch(() => false);
    runtime = hasRunsc ? "runsc" : null;
    if (!hasRunsc && hostRuntime !== null) notes.push(`oci runtime ${hostRuntime}, no gVisor`);
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
        usernsAuto = await run(
          ["run", "--rm", "--userns=auto", "--network", "none", image, "true"],
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
    capabilities: { version, rootless, remote: base.length > 0, usernsAuto, runtime, cgroupVersion },
    notes,
  };
}
