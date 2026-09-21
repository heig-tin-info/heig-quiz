import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/**
 * Configuration of the runner service, validated at startup (fail-fast), the
 * same posture as `apps/api/src/config.ts`.
 *
 * Nothing here is a secret: the runner holds no credential, talks to no
 * database and passes no environment variable of its own into a container
 * (invariant 10). What it does own is the hardening, and every knob that could
 * weaken it — the seccomp profile, the user namespace, the limits — is
 * explicit, defaulted to the safe value and logged at startup.
 */

/** `/run/user/<uid>/podman/podman.sock` (rootless), then `/run/podman/podman.sock` (rootful). */
export function detectSocket(): string | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const candidates = [
    ...(uid === null ? [] : [`/run/user/${uid}/podman/podman.sock`]),
    "/run/podman/podman.sock",
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** `apps/runner/infra/seccomp/runner.json`, resolved from this file, in `src` or in `dist`. */
export function defaultSeccompPath(): string {
  return fileURLToPath(new URL("../infra/seccomp/runner.json", import.meta.url));
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * The runner is an INTERNAL service: `compose.prod.yml` never publishes its
   * port and Caddy never routes to it. It binds every interface of its own
   * network namespace because that is what a container needs to be reachable
   * from the API container, and nothing else.
   */
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3200),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /** The Podman binary. `podman-remote` works too; `docker` does not. */
  PODMAN_BIN: z.string().default("podman"),
  /**
   * The Podman API socket. Empty = auto-detect (rootless user socket first,
   * then the rootful one). Every call is made as
   * `podman --remote --url unix://<socket>`, invariant 13: without `--remote`
   * the binary silently falls back to local rootless mode and an isolation
   * test measures something else than what production runs.
   */
  PODMAN_SOCKET: z.string().default(""),
  /**
   * `auto` (default) uses `--remote` as soon as a socket is there, `false`
   * drives the local CLI instead — the escape hatch for a host whose Podman
   * service is not running.
   */
  PODMAN_REMOTE: z.enum(["auto", "true", "false"]).default("auto"),

  /**
   * Shared secret the API presents as `Authorization: Bearer` (ADR-016). The
   * service sits on its own VM behind TLS: without this, whoever finds the
   * address has a free compute service. Empty = no check, which is only
   * acceptable on a development workstation — production refuses to start.
   */
  RUNNER_TOKEN: z.string().default(""),

  /** Containers running at the same time. Each one is 1 CPU and `memoryMb`. */
  RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Requests waiting in the two queues before `POST /run` answers 429. */
  RUNNER_QUEUE_MAX: z.coerce.number().int().min(1).max(1000).default(32),

  RUNNER_IMAGE_PREFIX: z.string().default("quiz-runner"),
  RUNNER_IMAGE_TAG: z.string().default("latest"),

  /** Seccomp profile passed to every container. Empty = the built-in default of this package. */
  RUNNER_SECCOMP: z.string().default(""),
  /**
   * `--userns=auto` maps the container into a fresh, private uid range.
   * `auto` (default) probes it once at startup and uses it when it works:
   * rootful Podman always supports it, a rootless one only with a large
   * enough `/etc/subuid` allocation.
   */
  RUNNER_USERNS_AUTO: z.enum(["auto", "true", "false"]).default("auto"),
  /** An alternative OCI runtime, e.g. `runsc` (gVisor). Empty = the host default, probed at startup. */
  RUNNER_RUNTIME: z.enum(["auto", "none", "runsc"]).default("auto"),

  /** Hard ceiling on the per-request `limits.outputKb`, per stream and per case. */
  RUNNER_MAX_OUTPUT_KB: z.coerce.number().int().min(1).max(4096).default(256),
  /** Size of the tmpfs mounted at /work. Source, objects and binary all live there. */
  RUNNER_WORKDIR_MB: z.coerce.number().int().min(4).max(512).default(32),
  /** Budget of the compilation step, which is not the budget of a test case. */
  RUNNER_COMPILE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  /**
   * How long the service waits past a case's own deadline before it stops
   * trusting the in-container `timeout` and destroys the container. The wall
   * clock is the service's, always (N-SEC-06).
   */
  RUNNER_CASE_GRACE_MS: z.coerce.number().int().min(250).max(30_000).default(2000),
  /** Ceiling on a whole request, all cases together. */
  RUNNER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(120_000),
});

export type RunnerConfig = Omit<z.infer<typeof EnvSchema>, "PODMAN_SOCKET" | "RUNNER_SECCOMP"> & {
  /** Resolved: the configured socket, the detected one, or `null` for the local CLI. */
  PODMAN_SOCKET: string | null;
  RUNNER_SECCOMP: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const data = parsed.data;

  const socket = data.PODMAN_SOCKET.trim() === "" ? detectSocket() : data.PODMAN_SOCKET.trim();
  const seccomp = data.RUNNER_SECCOMP.trim() === "" ? defaultSeccompPath() : data.RUNNER_SECCOMP.trim();

  // A missing profile is a configuration error, not a reason to run without
  // one: hardening is never "added later" (invariant 12).
  if (!existsSync(seccomp)) {
    throw new Error(`Invalid configuration: seccomp profile not found at ${seccomp}`);
  }

  const token = data.RUNNER_TOKEN.trim();
  if (data.NODE_ENV === "production" && token === "") {
    throw new Error("Invalid configuration: RUNNER_TOKEN is required in production");
  }

  return {
    ...data,
    RUNNER_TOKEN: token,
    PODMAN_SOCKET: data.PODMAN_REMOTE === "false" ? null : socket,
    RUNNER_SECCOMP: seccomp,
  };
}
