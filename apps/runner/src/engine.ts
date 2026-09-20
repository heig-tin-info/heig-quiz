import { spawn } from "node:child_process";

/**
 * The only module of the runner that knows about Podman.
 *
 * Two rules, inherited from the sibling project's `src/engine/` and from
 * `run-hardened.sh` (CLAUDE.md invariants 11-13):
 *
 *  1. **`podman --remote --url unix://<socket>` whenever a socket is there.**
 *     Without `--remote` the binary silently falls back to local rootless mode,
 *     and everything measured afterwards — network, user namespace, limits —
 *     belongs to another engine than the one production runs.
 *  2. **The hardening flags are those of `run-hardened.sh`, taken as they
 *     are**, minus the ones that mean nothing here (`--dns=none` conflicts
 *     with `--network none`) or that a rootless engine refuses
 *     (`--userns=auto`, probed once at startup). `containerArgs()` returns
 *     them explicitly so a test can compare them against the list.
 *
 * Nothing from the host is ever mounted: no `-v`, no bind, not even a
 * read-only one. The sources travel in through `podman exec` on stdin and the
 * work directory is a tmpfs that dies with the container.
 */

/** The closed list of environment variables a container gets (invariant 10). */
export const CONTAINER_ENV: Readonly<Record<string, string>> = Object.freeze({
  // Toolchains write caches next to the sources rather than into a $HOME that
  // does not exist on a read-only root.
  HOME: "/work",
  LANG: "C.UTF-8",
});

export interface EngineCapabilities {
  /** `podman --version`, verbatim. */
  version: string;
  rootless: boolean;
  /** `--remote --url unix://…` in use. */
  remote: boolean;
  /** `--userns=auto` accepted by this engine (always true rootful). */
  usernsAuto: boolean;
  /** An alternative OCI runtime, `runsc` (gVisor) when the host has it. */
  runtime: string | null;
  cgroupVersion: string;
}

export interface CreateOptions {
  name: string;
  image: string;
  memoryMb: number;
  pidsLimit: number;
  cpus: number;
  workdirMb: number;
  /** The container's own life, in seconds: `sleep <ttl>` is its only process. */
  ttlSeconds: number;
}

export interface ExecOptions {
  argv: string[];
  stdin: string;
  /** Service-side wall clock. Past it, `timedOut` comes back true and nothing was reaped. */
  timeoutMs: number;
  /** Per stream. Beyond it the bytes are dropped and `truncated` comes back true. */
  maxBytes: number;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  truncated: boolean;
  /** The container was gone: killed by the OOM reaper, or never started. */
  containerGone: boolean;
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface Engine {
  readonly capabilities: EngineCapabilities;
  /** The exact `podman run` arguments, so a test can assert the hardening. */
  containerArgs(options: CreateOptions): string[];
  create(options: CreateOptions): Promise<void>;
  exec(name: string, options: ExecOptions): Promise<ExecResult>;
  remove(name: string): Promise<void>;
  /** Image references present on the engine, `repository:tag`. */
  listImages(): Promise<string[]>;
}

export interface EngineOptions {
  podmanBin: string;
  /** `null` drives the local CLI: the escape hatch, not the normal path. */
  socket: string | null;
  seccompProfile: string;
  usernsAuto: boolean;
  runtime: string | null;
  capabilities: EngineCapabilities;
}

/** Message fragments Podman uses when the container is not there any more. */
const GONE = [
  "no such container",
  "is not running",
  "container state improper",
  "can only create exec sessions on running containers",
];

interface SpawnResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
}

/** Collects at most `maxBytes` per stream; the rest is counted and dropped. */
function collector(maxBytes: number): {
  push: (chunk: Buffer) => void;
  value: () => Buffer;
  truncated: () => boolean;
} {
  const chunks: Buffer[] = [];
  let size = 0;
  let cut = false;
  return {
    push(chunk) {
      if (size >= maxBytes) {
        cut = true;
        return;
      }
      const room = maxBytes - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size = maxBytes;
        cut = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    },
    value: () => Buffer.concat(chunks),
    truncated: () => cut,
  };
}

export function createEngine(options: EngineOptions): Engine {
  const base =
    options.socket === null
      ? []
      : ["--remote", "--url", `unix://${options.socket}`];

  function podman(
    args: string[],
    io: { stdin?: string; timeoutMs: number; maxBytes: number },
  ): Promise<SpawnResult> {
    return new Promise((resolve) => {
      const started = process.hrtime.bigint();
      const child = spawn(options.podmanBin, [...base, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out = collector(io.maxBytes);
      const err = collector(io.maxBytes);
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        // Killing the client does NOT reap what runs inside the container:
        // the caller destroys the container, which is the only reliable reaper
        // when Podman is driven over a socket.
        child.kill("SIGKILL");
      }, io.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.stdin.on("error", () => {
        // A program that exits without reading its stdin gives us EPIPE.
        // That is the program's business, not an error of ours.
      });
      if (io.stdin !== undefined) child.stdin.end(io.stdin);
      else child.stdin.end();

      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          stdout: out.value(),
          stderr: err.value(),
          timedOut,
          truncated: out.truncated() || err.truncated(),
          ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
        });
      };

      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code));
    });
  }

  function containerArgs(create: CreateOptions): string[] {
    return [
      "run",
      "-d",
      "--name",
      create.name,
      "--label",
      "quiz.runner=1",
      // --- hardening, from the sibling project's run-hardened.sh (README) ---
      // `--userns=auto`: a private uid range per container. Rootful always
      // has it; a rootless engine only with a large enough /etc/subuid, which
      // is why it is probed instead of assumed.
      ...(options.usernsAuto ? ["--userns=auto"] : []),
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      `seccomp=${options.seccompProfile}`,
      "--read-only",
      // /tmp is where a compiler puts its intermediate files; it never has to
      // be executable, and /work does, so they are two mounts and not one.
      "--tmpfs",
      `/tmp:rw,noexec,nosuid,nodev,size=${create.workdirMb}m`,
      // mode=1777: with --userns=auto the container's uid is not the one that
      // created the tmpfs, so an inherited root:root 755 would leave the
      // student's user unable to write its own sources.
      "--tmpfs",
      `/work:rw,exec,nosuid,nodev,size=${create.workdirMb}m,mode=1777`,
      "--pids-limit",
      String(create.pidsLimit),
      "--memory",
      `${create.memoryMb}m`,
      // No swap at all: with swap, a memory bomb pages instead of dying and
      // the `oom` verdict never comes.
      "--memory-swap",
      `${create.memoryMb}m`,
      "--cpus",
      String(create.cpus),
      // Invariant 11: closed by construction. `--dns=none` is not passed —
      // Podman refuses it together with `--network none`.
      "--network",
      "none",
      ...(options.runtime === null ? [] : ["--runtime", options.runtime]),
      // Invariant 10: a CLOSED list, and no secret in it.
      ...Object.entries(CONTAINER_ENV).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      create.image,
      // The container's only process. It bounds the container's life even if
      // the runner itself dies between two cases.
      "sleep",
      String(create.ttlSeconds),
    ];
  }

  return {
    capabilities: options.capabilities,
    containerArgs,

    async create(create) {
      const result = await podman(containerArgs(create), {
        timeoutMs: 60_000,
        maxBytes: 64 * 1024,
      });
      if (result.code !== 0) {
        throw new EngineError(
          `podman run failed (${result.code ?? "killed"})`,
          result.stderr.toString("utf8"),
        );
      }
    },

    async exec(name, exec) {
      const result = await podman(
        ["exec", "-i", "-w", "/work", name, ...exec.argv],
        { stdin: exec.stdin, timeoutMs: exec.timeoutMs, maxBytes: exec.maxBytes },
      );
      const stderr = result.stderr.toString("utf8");
      const gone =
        result.code !== 0 && GONE.some((needle) => stderr.toLowerCase().includes(needle));
      return {
        exitCode: result.code,
        stdout: result.stdout.toString("utf8"),
        // Podman's own complaint is not the program's output.
        stderr: gone ? "" : stderr,
        ms: result.ms,
        timedOut: result.timedOut,
        truncated: result.truncated,
        containerGone: gone,
      };
    },

    async remove(name) {
      await podman(["rm", "-f", "-t", "0", name], { timeoutMs: 30_000, maxBytes: 16 * 1024 });
    },

    async listImages() {
      const result = await podman(
        ["images", "--format", "{{.Repository}}:{{.Tag}}"],
        { timeoutMs: 30_000, maxBytes: 1024 * 1024 },
      );
      if (result.code !== 0) return [];
      return result.stdout
        .toString("utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    },
  };
}
