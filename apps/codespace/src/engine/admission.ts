/**
 * The engine side of an image's admission (ADR-146 §5): read an image the
 * engine holds, pull one by digest, the image store's free disk and its
 * list, and the admission container in which the released base's contract
 * check runs. It never removes an image: staging and production share the
 * store, and the administrator frees disk by hand (ADR-146 §8).
 *
 * The admission container is a helper (`helper.ts`), a narrower case of the
 * collection's confined reader, not a third divergence: a session's
 * hardening, tmpfs mounts, limits and user, `--network none`,
 * `--pull=never`, no variable of ours, nothing from the host mounted —
 * `/work` is a tmpfs. Removed on every exit path, swept at startup (label
 * `heig-codespace.role=admission`).
 *
 * The check script never comes from the candidate: it is read from the
 * released base's own image (`BASE_CHECK_PATH`), in a throwaway helper of
 * that base under the reader's confinement, and piped to the candidate over
 * stdin. What the candidate prints is data, capped.
 */
import { spawn } from "node:child_process";

import { helperArgs, helperName, removeHelper, runPodman, sweepHelpers, type SpawnPodman } from "./helper.js";
import { SESSION_TMPFS, SESSION_USER, type Confinement, type EngineOptions, type Limits } from "./index.js";
import { READER_LIMITS, READER_TMPFS } from "./reader.js";

export const ADMISSION_ROLE = "admission";
/** Where `quiz-base` ships its contract check (images/quiz-base, ADR-146 §5). */
export const BASE_CHECK_PATH = "/usr/local/lib/quiz-base/check";
/** The session's tmpfs mounts, and `/work` as a tmpfs too: nothing from the host. */
export const ADMISSION_TMPFS: readonly string[] = [...SESSION_TMPFS, "/work:rw,nosuid,nodev,size=64m,mode=1777"];
/** code-server's health route inside the container: no address outside it under `--network none`. */
export const ADMISSION_PROBE = ["curl", "-fsS", "-m", "2", "http://127.0.0.1:8080/healthz"] as const;
/** The check's script on stdin, run by the image's shell as the session's user. */
export const ADMISSION_CHECK = ["/bin/sh", "-s"] as const;

export type ImageEngineOptions = Confinement & Pick<EngineOptions, "podmanUrl" | "instance"> & { limits: Limits };

/** What the engine knows of an image it holds. */
export interface LocalImage {
  /** The image id, `sha256:…`. */
  id: string;
  /** Its size on disk, uncompressed. */
  sizeBytes: number;
  /** `RootFS.Layers`: the uncompressed layers' digests. */
  diffIds: string[];
  user: string;
  entrypoint: string[] | null;
  cmd: string[] | null;
  labels: Record<string, string>;
}

/** One image of the store, with every name the store holds it by (tags and repository digests). */
export interface StoreImage {
  id: string;
  names: string[];
  sizeBytes: number;
  diffIds: string[];
}

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class ImageEngineError extends Error {
  constructor(
    message: string,
    readonly stderr = "",
  ) {
    super(message);
    this.name = "ImageEngineError";
  }
}

export interface ImageEngine {
  inspect(reference: string): Promise<LocalImage | null>;
  /** `podman image exists`: the store holds the image under that name. */
  exists(reference: string): Promise<boolean>;
  pull(reference: string, timeoutMs: number): Promise<void>;
  /** The image store's free bytes, or null when the engine does not say. */
  freeBytes(): Promise<number | null>;
  /** Every image of the store (both instances' and the runner's alike). */
  listImages(): Promise<StoreImage[]>;
  /** A file of a trusted image (a released base), read in a throwaway confined helper. */
  readFile(reference: string, path: string, timeoutMs: number): Promise<string>;
  /** Starts the admission container of `reference`; its name. */
  startAdmission(reference: string): Promise<string>;
  /** Whether code-server answered `/healthz` within `timeoutMs`. */
  waitHealthy(name: string, timeoutMs: number): Promise<boolean>;
  /** Runs `script` as the session's user; its exit code and output. */
  runCheck(name: string, script: string, timeoutMs: number): Promise<Ran>;
  logs(name: string, lines: number): Promise<string>;
  removeContainer(name: string): Promise<void>;
  /** Removes this instance's admission helpers a crash left behind (startup only). */
  sweep(): Promise<number>;
}

/** `podman run` of an admission container. */
export function admissionArgs(o: ImageEngineOptions, name: string, reference: string): string[] {
  return helperArgs(o, { role: ADMISSION_ROLE, name, detach: true, rm: false, tmpfs: ADMISSION_TMPFS, limits: o.limits, tail: ["--user", SESSION_USER, reference] });
}

/** `podman run` of the throwaway helper that prints one file of a trusted image. */
export function readFileArgs(o: ImageEngineOptions, name: string, reference: string, path: string): string[] {
  return helperArgs(o, {
    role: ADMISSION_ROLE,
    name,
    detach: false,
    rm: true,
    tmpfs: [READER_TMPFS],
    limits: READER_LIMITS,
    tail: ["--user", SESSION_USER, "--entrypoint", "/bin/cat", reference, path],
  });
}

interface PodmanImageInspect {
  Id?: string;
  Size?: number;
  RootFS?: { Layers?: string[] | null };
  Config?: { User?: string; Entrypoint?: string[] | null; Cmd?: string[] | null; Labels?: Record<string, string> | null };
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
}

const imageId = (id: string): string => (id.startsWith("sha256:") ? id : `sha256:${id}`);

function inspectList(stdout: string): PodmanImageInspect[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((e): e is PodmanImageInspect => typeof e === "object" && e !== null && typeof (e as PodmanImageInspect).Id === "string");
  } catch {
    return [];
  }
}

/** `podman image inspect --format json`'s first entry, as a {@link LocalImage}. */
export function parseImageInspect(stdout: string): LocalImage | null {
  const first = inspectList(stdout)[0];
  if (!first?.Id) return null;
  return {
    id: imageId(first.Id),
    sizeBytes: typeof first.Size === "number" ? first.Size : 0,
    diffIds: first.RootFS?.Layers ?? [],
    user: first.Config?.User ?? "",
    entrypoint: first.Config?.Entrypoint ?? null,
    cmd: first.Config?.Cmd ?? null,
    labels: first.Config?.Labels ?? {},
  };
}

/**
 * `podman image inspect --format json <id>…` of the whole store, as
 * {@link StoreImage}s. TODO(verify) Podman 5.7: `RepoTags` and `RepoDigests`
 * carry every name, a local build's tag prefixed `localhost/`.
 */
export function parseStoreImages(stdout: string): StoreImage[] {
  return inspectList(stdout).map((e) => ({
    id: imageId(e.Id ?? ""),
    names: [...(e.RepoTags ?? []), ...(e.RepoDigests ?? [])],
    sizeBytes: typeof e.Size === "number" ? e.Size : 0,
    diffIds: e.RootFS?.Layers ?? [],
  }));
}

/** `podman info --format json` → the image store's free bytes, or null. */
export function parseFreeBytes(stdout: string): number | null {
  try {
    const info = JSON.parse(stdout) as { store?: { graphRootAllocated?: number; graphRootUsed?: number } };
    const total = info.store?.graphRootAllocated;
    const used = info.store?.graphRootUsed;
    return typeof total === "number" && typeof used === "number" && total >= used ? total - used : null;
  } catch {
    return null;
  }
}

export function createImageEngine(o: ImageEngineOptions, spawnPodman?: SpawnPodman): ImageEngine {
  const start: SpawnPodman =
    spawnPodman ?? ((args) => spawn("podman", ["--remote", "--url", o.podmanUrl, ...args], { stdio: "pipe" }));

  /** One command; a timeout, an output over its cap or a podman that cannot start is a failed run, never a throw. */
  async function podman(args: string[], timeoutMs: number, stdin?: string): Promise<Ran> {
    try {
      const ran = await runPodman(start, args, Date.now() + timeoutMs, stdin === undefined ? {} : { stdin });
      return { code: ran.code, stdout: ran.stdout.toString("utf8"), stderr: ran.stderr };
    } catch (err) {
      return { code: null, stdout: "", stderr: String((err as Error).message ?? err) };
    }
  }

  return {
    async inspect(reference) {
      const ran = await podman(["image", "inspect", "--format", "json", reference], 30_000);
      return ran.code === 0 ? parseImageInspect(ran.stdout) : null;
    },

    async exists(reference) {
      return (await podman(["image", "exists", reference], 30_000)).code === 0;
    },

    async pull(reference, timeoutMs) {
      const ran = await podman(["pull", "-q", reference], timeoutMs);
      if (ran.code !== 0) throw new ImageEngineError(`podman pull failed (${ran.code})`, ran.stderr);
    },

    async freeBytes() {
      const ran = await podman(["info", "--format", "json"], 30_000);
      return ran.code === 0 ? parseFreeBytes(ran.stdout) : null;
    },

    async listImages() {
      const ids = await podman(["images", "--all", "--quiet", "--no-trunc"], 30_000);
      if (ids.code !== 0) throw new ImageEngineError(`podman images failed (${ids.code})`, ids.stderr);
      const list = [...new Set(ids.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== ""))];
      if (list.length === 0) return [];
      const ran = await podman(["image", "inspect", "--format", "json", ...list], 60_000);
      if (ran.code !== 0) throw new ImageEngineError(`podman image inspect failed (${ran.code})`, ran.stderr);
      return parseStoreImages(ran.stdout);
    },

    async readFile(reference, path, timeoutMs) {
      const name = helperName(o.instance, ADMISSION_ROLE);
      try {
        const ran = await podman(readFileArgs(o, name, reference, path), timeoutMs);
        if (ran.code !== 0) throw new ImageEngineError(`reading ${path} failed (${ran.code})`, ran.stderr);
        return ran.stdout;
      } finally {
        // `--rm` removes it once `cat` ends; a timeout or a killed client does not.
        await removeHelper(start, name);
      }
    },

    async startAdmission(reference) {
      const name = helperName(o.instance, ADMISSION_ROLE);
      const ran = await podman(admissionArgs(o, name, reference), 120_000);
      if (ran.code !== 0) {
        await removeHelper(start, name);
        throw new ImageEngineError(`the admission container did not start (${ran.code})`, ran.stderr);
      }
      return name;
    },

    async waitHealthy(name, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((await podman(["exec", name, ...ADMISSION_PROBE], 5_000)).code === 0) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    },

    async runCheck(name, script, timeoutMs) {
      return podman(["exec", "-i", "--user", SESSION_USER, name, ...ADMISSION_CHECK], timeoutMs, script);
    },

    async logs(name, lines) {
      const ran = await podman(["logs", "--tail", String(lines), name], 30_000);
      return `${ran.stdout}${ran.stderr}`;
    },

    removeContainer: (name) => removeHelper(start, name),

    sweep: () => sweepHelpers(start, o.instance, ADMISSION_ROLE),
  };
}
