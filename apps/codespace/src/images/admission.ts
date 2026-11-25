/**
 * The portal's admitted set (ADR-146 §5): a course image runs only once the
 * portal admitted it under the very reference the project names, and the
 * platform's own image — the default — is admitted at startup without a
 * check.
 *
 * One admission job at a time, idempotent per reference:
 *
 *  1. the registry, anonymously (`@quiz/core/oci`): the public proof, then
 *     {@link manifestVerdict} — linux/amd64, the compressed ceiling, the
 *     first uncompressed layers (`rootfs.diff_ids`) against a released
 *     `quiz-base`'s (the base version comes from that prefix, never from the
 *     candidate's label), `User`, `Entrypoint` and `Cmd` equal to that base's;
 *  2. the image store's free disk above the floor, then the pull by digest;
 *  3. the size on disk against the ceiling;
 *  4. the admission container (`engine/admission.ts`, the session's
 *     hardening, `--network none`), code-server's `/healthz`, then the base's
 *     contract check, read from the BASE's image and piped over stdin.
 *
 * `downloading` covers 1–3, `checking` 4. The portal never removes an image
 * from the store (staging and production share it, ADR-146 §8): a refusal
 * leaves what it pulled, and an un-admission removes the row only.
 * Admission catches accidents, not the image's author (ADR-146 §5): what
 * protects anything is enforced at run time by the session's flags.
 */
import {
  DigestReference,
  IMAGE_DETAIL_MAX,
  IMAGE_REMOVE_REFUSALS,
  type CodespaceBaseImage,
  type CodespaceEngineImage,
  type CodespaceEngineImageAdmission,
  type CodespaceImageAdmission,
  type CodespaceImageAdmissionError,
  type ImageRefusal,
} from "@quiz/contracts";
import { OciError, parseOciReference, type OciClient, type OciErrorKind, type OciImage } from "@quiz/core/oci";
import { and, count, eq, inArray, ne } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { admittedImages, sessions, type AdmittedImageRow } from "../db/schema.js";
import { BASE_CHECK_PATH, type ImageEngine } from "../engine/admission.js";
import { LIVE_STATES } from "../sessions/store.js";

/** The label `quiz-base` carries its version in; trusted on the platform's own image only. */
export const BASE_VERSION_LABEL = "io.quiz.base.version";

/** A session asked for an image the portal has not admitted, or the store no longer holds: no container is started. */
export class ImageNotAdmittedError extends Error {
  constructor(readonly reference: string) {
    super(`image not admitted: ${reference}`);
    this.name = "ImageNotAdmittedError";
  }
}

export interface ImageAdmissionOptions {
  db: Db;
  registry: OciClient;
  engine: ImageEngine;
  /** `CODESPACE_DEFAULT_IMAGE`, resolved. */
  defaultImage: string;
  /** The released `quiz-base` digest references (the config's `baseReleases`). */
  baseReleases: readonly string[];
  maxBytes: number;
  minFreeBytes: number;
  /** code-server's `/healthz` in the admission container. */
  healthTimeoutMs: number;
  pullTimeoutMs?: number;
  checkTimeoutMs?: number;
  log: {
    info: (o: object, m: string) => void;
    warn: (o: object, m: string) => void;
    error: (o: object, m: string) => void;
  };
  now?: () => Date;
}

export type AdmissionRequestResult =
  | { status: 202; admission: CodespaceImageAdmission }
  | { status: 422 | 503; error: CodespaceImageAdmissionError };

export type RemoveResult = "removed" | "not_found" | (typeof IMAGE_REMOVE_REFUSALS)[number];

export interface ImageAdmissions {
  /** Resolves a reference (tag or digest, canonical) and queues its admission. */
  request(reference: string): Promise<AdmissionRequestResult>;
  get(reference: string): CodespaceImageAdmission | null;
  /** The current `quiz-base` (the default), or null while the default is not pinned by digest. */
  base(): Promise<CodespaceBaseImage | null>;
  /** The store's workspace images joined with this instance's admissions. */
  list(): Promise<CodespaceEngineImage[]>;
  /** Un-admits a reference: the row only, never the store. */
  remove(reference: string): Promise<RemoveResult>;
  /** May a container start on `reference` now: the default or a `ready` admission, held by the store. */
  runnable(reference: string): Promise<boolean>;
  markUsed(reference: string): void;
  /** Interrupted admissions refused, leftover containers swept, earlier defaults demoted, the default admitted. */
  startup(): Promise<void>;
  /** Resolves once the queue is empty: for the tests (a shutdown does not wait for a 30-minute pull). */
  idle(): Promise<void>;
}

/** A released `quiz-base`, as its registry describes it. */
export interface BaseInfo {
  reference: string;
  digest: string;
  diffIds: string[];
  user: string;
  entrypoint: string[] | null;
  cmd: string[] | null;
  version: string | null;
}

export type Verdict = { ok: true; base: BaseInfo } | { ok: false; reason: ImageRefusal; detail: string | null };

const list = (v: string[] | null): string[] | null => (v && v.length > 0 ? v : null);
const same = (a: string[] | null, b: string[] | null): boolean => JSON.stringify(list(a)) === JSON.stringify(list(b));
const isPrefix = (prefix: readonly string[], of: readonly string[]): boolean =>
  prefix.length > 0 && prefix.length <= of.length && prefix.every((d, i) => d === of[i]);

/**
 * What a manifest alone decides (ADR-146 §5), before anything is pulled:
 * linux/amd64, the compressed size under the ceiling, the released base
 * whose layers are the longest prefix of the image's, and `User`,
 * `Entrypoint`, `Cmd` equal to that base's. Pure.
 */
export function manifestVerdict(image: OciImage, bases: readonly BaseInfo[], maxBytes: number): Verdict {
  const { config } = image;
  if (config.os !== "linux" || config.architecture !== "amd64") return { ok: false, reason: "config", detail: `${config.os}/${config.architecture}` };
  if (image.compressedBytes > maxBytes) return { ok: false, reason: "too_large", detail: `${image.compressedBytes}>${maxBytes}` };
  let base: BaseInfo | null = null;
  for (const b of bases) if (isPrefix(b.diffIds, config.diffIds) && (!base || b.diffIds.length > base.diffIds.length)) base = b;
  if (!base) return { ok: false, reason: "not_on_base", detail: null };
  const differs = [
    config.user === base.user ? null : "User",
    same(config.entrypoint, base.entrypoint) ? null : "Entrypoint",
    same(config.cmd, base.cmd) ? null : "Cmd",
  ].filter((x) => x !== null);
  return differs.length > 0 ? { ok: false, reason: "config", detail: differs.join(",") } : { ok: true, base };
}

/** A refusal the job raises from any step. */
class Refusal extends Error {
  constructor(
    readonly reason: ImageRefusal,
    readonly detail: string | null,
  ) {
    super(reason);
  }
}

const OCI_REFUSAL: Record<Exclude<OciErrorKind, "unavailable">, "not_found" | "not_public" | "config"> = {
  not_found: "not_found",
  not_public: "not_public",
  invalid: "config",
};

/** A quoted diagnostic: one line, no control character, capped; null when empty. */
export function cleanDetail(text: string | null | undefined): string | null {
  const flat = (text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  return flat.length > IMAGE_DETAIL_MAX ? `${flat.slice(0, IMAGE_DETAIL_MAX - 1)}…` : flat;
}

/** A registry failure's diagnostic: its HTTP status, or null (never the error's prose). */
const statusOf = (err: OciError): string | null => (err.status === null ? null : String(err.status));

/** The last non-empty line of an output. */
const lastLine = (text: string): string => text.split("\n").map((l) => l.trim()).filter((l) => l !== "").pop() ?? "";

/** A store name as a reference: a local build's `localhost/` prefix dropped. */
const storeName = (name: string): string => name.replace(/^localhost\//, "");

export function createImageAdmissions(o: ImageAdmissionOptions): ImageAdmissions {
  const { db, registry, engine, log } = o;
  const now = o.now ?? (() => new Date());
  const pullTimeoutMs = o.pullTimeoutMs ?? 30 * 60_000;
  const checkTimeoutMs = o.checkTimeoutMs ?? 120_000;
  const pinnedDefault = DigestReference.safeParse(o.defaultImage).success;
  let tail: Promise<void> = Promise.resolve();
  const bases = new Map<string, Promise<BaseInfo>>();
  const checks = new Map<string, Promise<string>>();

  const row = (reference: string): AdmittedImageRow | undefined =>
    db.select().from(admittedImages).where(eq(admittedImages.reference, reference)).get();

  function update(reference: string, patch: Partial<AdmittedImageRow>): void {
    db.update(admittedImages).set({ ...patch, updatedAt: now() }).where(eq(admittedImages.reference, reference)).run();
  }

  function upsert(values: Omit<AdmittedImageRow, "updatedAt">): void {
    const full = { ...values, updatedAt: now() };
    db.insert(admittedImages).values(full).onConflictDoUpdate({ target: admittedImages.reference, set: full }).run();
  }

  function toAdmission(r: AdmittedImageRow): CodespaceImageAdmission | null {
    if (!DigestReference.safeParse(r.reference).success) return null;
    return {
      reference: r.reference,
      digest: r.digest,
      state: r.state,
      reason: r.reason,
      detail: r.detail,
      baseVersion: r.baseVersion,
      compressedBytes: r.compressedBytes,
      diskBytes: r.diskBytes,
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  function liveSessions(reference: string): number {
    return (
      db
        .select({ n: count() })
        .from(sessions)
        .where(and(eq(sessions.image, reference), inArray(sessions.state, [...LIVE_STATES])))
        .get()?.n ?? 0
    );
  }

  /** A released base, from its registry; cached (a digest never moves), a failure not. */
  function baseInfo(reference: string): Promise<BaseInfo> {
    let cached = bases.get(reference);
    if (!cached) {
      cached = registry.image(reference).then((image) => ({
        reference,
        digest: image.digest,
        diffIds: image.config.diffIds,
        user: image.config.user,
        entrypoint: image.config.entrypoint,
        cmd: image.config.cmd,
        version: image.config.labels[BASE_VERSION_LABEL] ?? null,
      }));
      cached.catch(() => bases.delete(reference));
      bases.set(reference, cached);
    }
    return cached;
  }

  /** No pull starts under the floor (ADR-146 §5). */
  async function ensureFloor(): Promise<void> {
    const free = await engine.freeBytes();
    if (free === null) throw new Refusal("disk_full", null);
    if (free < o.minFreeBytes) throw new Refusal("disk_full", `${free}<${o.minFreeBytes}`);
  }

  /** The base's own check script: from the base's image, pulled by digest (above the floor) if the store lacks it. */
  function trustedCheck(base: BaseInfo): Promise<string> {
    let cached = checks.get(base.reference);
    if (!cached) {
      cached = (async () => {
        if (!(await engine.exists(base.reference))) {
          await ensureFloor();
          await engine.pull(base.reference, pullTimeoutMs);
        }
        const script = await engine.readFile(base.reference, BASE_CHECK_PATH, checkTimeoutMs);
        if (script.trim() === "") throw new Error("the base's check is empty");
        return script;
      })();
      cached.catch(() => checks.delete(base.reference));
      checks.set(base.reference, cached);
    }
    return cached;
  }

  async function admit(reference: string): Promise<void> {
    const current = row(reference);
    if (!current || current.state !== "downloading") return;
    try {
      // --- 1. the registry, anonymously, and what the manifest decides ----------
      const image = await registry.image(reference).catch((err: unknown) => {
        if (err instanceof OciError) throw new Refusal(err.kind === "unavailable" ? "pull_failed" : OCI_REFUSAL[err.kind], statusOf(err));
        throw err;
      });
      update(reference, { compressedBytes: image.compressedBytes });
      // An unreadable release is skipped with a warning; none readable at all is the registry's failure.
      const read = await Promise.allSettled(o.baseReleases.map(baseInfo));
      const released = read.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      read.forEach((r, i) => {
        if (r.status === "rejected") log.warn({ base: o.baseReleases[i], err: String((r.reason as Error).message ?? r.reason) }, "a released quiz-base could not be read");
      });
      const unreadable = read.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (released.length === 0 && unreadable) throw new Refusal("pull_failed", unreadable.reason instanceof OciError ? statusOf(unreadable.reason) : null);
      const verdict = manifestVerdict(image, released, o.maxBytes);
      if (!verdict.ok) throw new Refusal(verdict.reason, verdict.detail);
      const base = verdict.base;
      update(reference, { baseVersion: base.version });

      // --- 2. the floor, then the pull --------------------------------------------
      if (!(await engine.exists(reference))) {
        await ensureFloor();
        try {
          await engine.pull(reference, pullTimeoutMs);
        } catch (err) {
          throw new Refusal("pull_failed", lastLine((err as { stderr?: string }).stderr ?? ""));
        }
      }
      const local = await engine.inspect(reference);
      if (!local || !same(local.diffIds, image.config.diffIds)) throw new Refusal("pull_failed", null);

      // --- 3. on disk -------------------------------------------------------------
      update(reference, { diskBytes: local.sizeBytes });
      if (local.sizeBytes > o.maxBytes) throw new Refusal("too_large", `${local.sizeBytes}>${o.maxBytes}`);

      // --- 4. the admission container and the base's check ----------------------
      update(reference, { state: "checking" });
      const script = await trustedCheck(base).catch((err: unknown) => {
        if (err instanceof Refusal) throw err;
        log.error({ base: base.reference, err: String((err as Error).message ?? err) }, "the base's contract check could not be read");
        throw new Refusal("contract_failed", null);
      });
      const name = await engine.startAdmission(reference).catch((err: unknown) => {
        throw new Refusal("contract_failed", lastLine((err as { stderr?: string }).stderr ?? ""));
      });
      try {
        if (!(await engine.waitHealthy(name, o.healthTimeoutMs))) throw new Refusal("contract_failed", lastLine(await engine.logs(name, 20)));
        const ran = await engine.runCheck(name, script, checkTimeoutMs);
        if (ran.code !== 0) throw new Refusal("contract_failed", lastLine(`${ran.stdout}\n${ran.stderr}`));
      } finally {
        await engine.removeContainer(name);
      }

      update(reference, { state: "ready", reason: null, detail: null, admittedAt: now() });
      log.info({ image: { reference, digest: current.digest, baseVersion: base.version, diskBytes: local.sizeBytes } }, "image admitted");
    } catch (err) {
      if (!(err instanceof Refusal)) log.error({ reference, err: String((err as Error).message ?? err) }, "admission failed");
      const refusal = err instanceof Refusal ? err : new Refusal("pull_failed", null);
      const detail = cleanDetail(refusal.detail);
      update(reference, { state: "refused", reason: refusal.reason, detail });
      log.warn({ image: { reference, reason: refusal.reason, detail } }, "image refused");
    }
  }

  function enqueue(reference: string): void {
    tail = tail.then(() => admit(reference)).catch((err: unknown) => log.error({ reference, err: String((err as Error).message ?? err) }, "admission job failed"));
  }

  function entry(r: AdmittedImageRow): CodespaceEngineImageAdmission {
    return {
      reference: r.reference,
      digest: r.digest,
      source: r.source,
      state: r.state,
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      liveSessions: liveSessions(r.reference),
    };
  }

  return {
    async request(reference) {
      let resolved: { reference: string; digest: string };
      try {
        resolved = await registry.resolve(reference);
      } catch (err) {
        if (!(err instanceof OciError)) throw err;
        const detail = statusOf(err);
        if (err.kind === "unavailable") return { status: 503, error: { error: "registry_unavailable", detail } };
        return { status: 422, error: { error: OCI_REFUSAL[err.kind], detail } };
      }
      // One row per reference, never rewritten while it is not refused: a ready
      // row (the default's included) is answered as it is — unless the store
      // lost its image (removed by hand), when a Refresh admits it again.
      const existing = row(resolved.reference);
      const lost = existing?.state === "ready" && existing.source === "course" && !(await engine.exists(resolved.reference));
      if (!existing || existing.state === "refused" || lost) {
        upsert({
          reference: resolved.reference,
          digest: resolved.digest,
          state: "downloading",
          reason: null,
          detail: null,
          baseVersion: null,
          compressedBytes: null,
          diskBytes: null,
          source: "course",
          requestedAt: now(),
          admittedAt: null,
          lastUsedAt: existing?.lastUsedAt ?? null,
        });
        enqueue(resolved.reference);
      }
      const admission = toAdmission(row(resolved.reference)!);
      if (!admission) throw new Error("an admission without a digest reference");
      return { status: 202, admission };
    },

    get(reference) {
      const r = row(reference);
      return r ? toAdmission(r) : null;
    },

    async base() {
      if (!pinnedDefault) return null;
      const info = await baseInfo(o.defaultImage);
      return { reference: o.defaultImage, digest: info.digest, version: info.version };
    },

    async list() {
      const store = await engine.listImages();
      const rows = db.select().from(admittedImages).all();
      const released = new Set(o.baseReleases);
      const prefixes = store.filter((img) => img.names.some((n) => released.has(storeName(n)))).map((img) => img.diffIds);
      /** What a store image is to this instance; null: not a workspace image. */
      const kindOf = (names: string[], admitted: boolean, diffIds: string[]): CodespaceEngineImage["kind"] | null => {
        if (names.includes(o.defaultImage)) return "default";
        if (names.some((n) => released.has(n))) return "base";
        if (admitted) return "admitted";
        if (prefixes.some((p) => isPrefix(p, diffIds))) return "orphan";
        return null;
      };
      const seen = new Set<string>();
      const images: CodespaceEngineImage[] = [];
      for (const img of store) {
        const names = img.names.map(storeName);
        const admitted = rows.filter((r) => names.includes(r.reference));
        for (const r of admitted) seen.add(r.reference);
        const kind = kindOf(names, admitted.length > 0, img.diffIds);
        // Not a workspace image: the runner's, a build's intermediate layer.
        if (kind === null) continue;
        images.push({ id: img.id, names: img.names, diskBytes: img.sizeBytes, kind, admissions: admitted.map(entry) });
      }
      // Admitted here, gone from the store (removed by hand): shown, so the console says so.
      for (const r of rows.filter((x) => !seen.has(x.reference))) {
        images.push({ id: null, names: [], diskBytes: null, kind: r.reference === o.defaultImage ? "default" : "admitted", admissions: [entry(r)] });
      }
      return images;
    },

    async remove(reference) {
      const r = row(reference);
      if (!r) return "not_found";
      if (r.reference === o.defaultImage) return "default_image";
      if (r.state === "downloading" || r.state === "checking") return "admission_running";
      if (liveSessions(r.reference) > 0) return "image_in_use";
      db.delete(admittedImages).where(eq(admittedImages.reference, reference)).run();
      log.info({ image: { reference, digest: r.digest } }, "image un-admitted by the administrator; the store keeps it");
      return "removed";
    },

    async runnable(reference) {
      const admitted =
        reference === o.defaultImage ||
        db
          .select({ reference: admittedImages.reference })
          .from(admittedImages)
          .where(and(eq(admittedImages.reference, reference), eq(admittedImages.state, "ready")))
          .get() !== undefined;
      // Removed from the store by hand: refused here, rather than a failed `--pull=never` start.
      return admitted && (await engine.exists(reference));
    },

    markUsed(reference) {
      db.update(admittedImages).set({ lastUsedAt: now() }).where(eq(admittedImages.reference, reference)).run();
    },

    async startup() {
      const at = now();
      db.update(admittedImages)
        .set({ state: "refused", reason: "interrupted", detail: null, updatedAt: at })
        .where(inArray(admittedImages.state, ["downloading", "checking"]))
        .run();
      await engine.sweep().catch((err: unknown) => log.warn({ err: String((err as Error).message ?? err) }, "admission sweep failed"));
      // An earlier default is no longer the platform's: it runs again only once admitted as a course image.
      const demoted = db
        .delete(admittedImages)
        .where(and(eq(admittedImages.source, "default"), ne(admittedImages.reference, o.defaultImage)))
        .returning({ reference: admittedImages.reference })
        .all();
      for (const d of demoted) log.info({ image: { reference: d.reference } }, "an earlier default image is no longer admitted");

      // The default is the platform's own (ADR-146 §3), pulled by the deploy: admitted as it is, whatever its form.
      const local = await engine.inspect(o.defaultImage);
      if (!local) {
        log.error({ image: o.defaultImage }, "the default image is not on the engine: sessions cannot start until a deploy pulls it");
        return;
      }
      const previous = row(o.defaultImage);
      upsert({
        reference: o.defaultImage,
        digest: parseOciReference(o.defaultImage)?.digest ?? local.id,
        state: "ready",
        reason: null,
        detail: null,
        baseVersion: local.labels[BASE_VERSION_LABEL] ?? null,
        compressedBytes: previous?.compressedBytes ?? null,
        diskBytes: local.sizeBytes,
        source: "default",
        requestedAt: previous?.requestedAt ?? at,
        admittedAt: previous?.admittedAt ?? at,
        lastUsedAt: previous?.lastUsedAt ?? null,
      });
      log.info({ image: { reference: o.defaultImage } }, "default image admitted");
    },

    idle() {
      return tail;
    },
  };
}
