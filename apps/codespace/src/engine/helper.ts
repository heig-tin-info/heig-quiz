/**
 * The portal's helper containers: the collection's confined reader
 * (`reader.ts`, ADR-130) and an image's admission (`admission.ts`,
 * ADR-146). Neither is a session (no session label: neither the listing, the
 * reconciliation nor the quota sees one); both run a session's hardening
 * (`hardeningArgs`), `--network none`, `--pull=never`, and carry a role and
 * an instance label by which a startup sweep removes what a crash left.
 *
 * One argv builder, one sweep and one `podman --remote` runner for both, so
 * a helper cannot drift from the others.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { INSTANCE_LABEL, PULL_NEVER, hardeningArgs, type Confinement, type Limits } from "./index.js";

/** The role label of the portal's helpers: never `SESSION_LABEL`. */
export const ROLE_LABEL = "heig-codespace.role";

/** Starts `podman --remote …`; injectable so that the tests drive a fake engine. */
export type SpawnPodman = (args: string[]) => ChildProcessWithoutNullStreams;

/** A helper could not run, or answered something it never would. */
export class ReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReaderError";
  }
}

/** A command printed more than its cap. */
export class OutputOverCap extends ReaderError {
  constructor() {
    super("the helper's output is over its cap");
  }
}

/** The time given ran out. */
export class ReaderTimeout extends Error {
  constructor() {
    super("the confined helper ran out of time");
    this.name = "ReaderTimeout";
  }
}

/** What a helper container is: its role, name, tmpfs mounts, limits, and what follows `--network none`. */
export interface HelperSpec {
  role: string;
  name: string;
  /** `-d`: started in the background (a container that lives); else the command's output is read. */
  detach: boolean;
  /** `--rm`: it goes on its own once its process ends. */
  rm: boolean;
  tmpfs: readonly string[];
  limits: Limits;
  /** `--user`, mounts, `--entrypoint`, the image and its arguments. */
  tail: readonly string[];
}

/** The `podman run` of a helper: the same frame for every role. */
export function helperArgs(o: Confinement & { instance: string }, h: HelperSpec): string[] {
  return [
    "run",
    ...(h.detach ? ["-d"] : []),
    ...(h.rm ? ["--rm"] : []),
    PULL_NEVER,
    "--name",
    h.name,
    "--label",
    `${ROLE_LABEL}=${h.role}`,
    "--label",
    `${INSTANCE_LABEL}=${o.instance}`,
    ...hardeningArgs(o, h.tmpfs, h.limits),
    "--network",
    "none",
    ...h.tail,
  ];
}

/** A fresh helper name, `cs-<instance>-<role>-<uuid>`: what the sweep recognizes. */
export const helperName = (instance: string, role: string): string => `cs-${instance}-${role}-${randomUUID()}`;

export interface PodmanRun {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** stderr went past what is kept: a list read from it would be incomplete. */
  stderrCut: boolean;
}

/** What is kept of a helper's stderr. */
const STDERR_MAX = 64 * 1024;
/** What a command other than a listing may print (a container id, a name, a short script). */
export const OUTPUT_MAX_BYTES = 256 * 1024;

/** Waits for `child`, collecting its output, killed past `deadline` (then {@link ReaderTimeout}). */
export function finish(child: ChildProcessWithoutNullStreams, deadline: number, maxStdout: number, collect = true): Promise<PodmanRun> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    let stderrCut = false;
    let failure: Error | null = null;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const stop = (e: Error) => {
      failure ??= e;
      child.kill("SIGKILL");
      // Output nobody reads would hold `close` back.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => stop(new ReaderTimeout()), Math.max(0, deadline - Date.now()));
    if (collect) {
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxStdout) stop(new OutputOverCap());
        else out.push(chunk);
      });
    }
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length + chunk.length <= STDERR_MAX) err += chunk.toString("utf8");
      else stderrCut = true;
    });
    // A podman that cannot even start (no binary): its own error, at once.
    child.on("error", (e) => settle(() => reject(failure ?? new ReaderError(e.message))));
    child.on("close", (code) => settle(() => (failure ? reject(failure) : resolve({ code, stdout: Buffer.concat(out), stderr: err, stderrCut }))));
  });
}

/**
 * One `podman` command, its stdin given (or closed at once), its output
 * collected up to `maxStdout`. Throws {@link ReaderTimeout} past `deadline`,
 * {@link OutputOverCap} past the cap, {@link ReaderError} when podman cannot start.
 */
export async function runPodman(
  start: SpawnPodman,
  args: string[],
  deadline: number,
  opts: { maxStdout?: number; stdin?: string } = {},
): Promise<PodmanRun> {
  if (Date.now() >= deadline) throw new ReaderTimeout();
  const child = start(args);
  child.stdin.on("error", () => undefined);
  child.stdin.end(opts.stdin ?? "");
  return finish(child, deadline, opts.maxStdout ?? OUTPUT_MAX_BYTES);
}

/** Removal runs whatever the caller's budget says. */
export const REMOVE_TIMEOUT_MS = 15_000;

/** Removes one helper, now; never throws. */
export async function removeHelper(start: SpawnPodman, name: string): Promise<void> {
  await runPodman(start, ["rm", "-f", "-t", "0", name], Date.now() + REMOVE_TIMEOUT_MS).catch(() => undefined);
}

/** Removes this instance's helpers of `role` a crash left behind (startup only: none is in use then). */
export async function sweepHelpers(start: SpawnPodman, instance: string, role: string): Promise<number> {
  const listed = await runPodman(
    start,
    ["ps", "--all", "--filter", `label=${ROLE_LABEL}=${role}`, "--filter", `label=${INSTANCE_LABEL}=${instance}`, "--format", "{{.Names}}"],
    Date.now() + REMOVE_TIMEOUT_MS,
  );
  if (listed.code !== 0) throw new ReaderError(`listing the ${role} helpers failed (${listed.code}): ${listed.stderr.slice(0, 400)}`);
  const prefix = `cs-${instance}-${role}-`;
  const names = listed.stdout.toString("utf8").split("\n").map((n) => n.trim()).filter((n) => n.startsWith(prefix));
  for (const name of names) await removeHelper(start, name);
  return names.length;
}
