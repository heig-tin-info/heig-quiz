/**
 * A course's workspace images (ADR-146 §4–§8), Quiz's side: the list its
 * staff read, an owner's writes (add, rename, refresh, remove), a project's
 * choice, the follow-up of an admission on the portal, and the
 * administrator's view of the engine's store.
 *
 * Quiz never calls a registry: the portal resolves a tag, pulls and admits
 * (§5), through the service routes of `@quiz/contracts`' `codespace.ts`
 * ({@link portalCall}, a service token bound to each request). Quiz keeps,
 * per image, the digest in service and the admission in flight
 * (`course_workspace_images`), and sends a project's sync the digest in
 * service — never a tag, never a candidate.
 *
 * The rollout's guard: while the portal has no image route (an older
 * portal), the list answers `503 images_unavailable` (its `GET
 * /api/images/base` is a 404), and so do an add, a Refresh and the
 * administrator's view (the route they call is); no image can be admitted,
 * so a sync keeps `image: null`.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  ADMISSION_IN_FLIGHT,
  COURSE_WORKSPACE_IMAGES_MAX,
  CodespaceBaseImage,
  CodespaceEngineImage,
  CodespaceImageAdmission,
  CodespaceImageAdmissionError,
  IMAGE_ADMISSIONS_PATH,
  IMAGE_BASE_PATH,
  IMAGES_PATH,
  imageAdmissionPath,
  type AdminWorkspaceImage,
  type AdmissionState,
  type CourseWorkspaceImage,
  type CourseWorkspaceImages,
  type ImageRefusal,
  type WorkspaceImageError,
} from "@quiz/contracts";
import { imageObsolete } from "@quiz/domain";

import { audit, SYSTEM_ACTOR, type AuditActor } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { isForeignKeyViolation, isUniqueViolation, type Db, type Tx } from "../../db/client.js";
import { codespaceProjects, courses, courseWorkspaceImages, projects } from "../../db/schema.js";
import { CODESPACE_IMAGE_QUEUE } from "../../jobs.js";
import { DomainError, notFoundError } from "../http.js";
import { portalCall } from "./portal.js";
import { requestCodespaceSync } from "./service.js";

type ImageRow = typeof courseWorkspaceImages.$inferSelect;
type App = Pick<FastifyInstance, "db" | "clock" | "boss" | "log">;

/** How often the follow-up asks the portal, and how long it waits before calling the admission lost. */
export const ADMISSION_POLL_MS = 5_000;
export const ADMISSION_GIVE_UP_MS = 30 * 60_000;

// ---------------------------------------------------------------- the refusals

/** The status of each refusal of `WORKSPACE_IMAGE_ERRORS` (the contract describes them). */
const IMAGE_ERROR_STATUS: Record<WorkspaceImageError, number> = {
  codespace_not_granted: 403,
  too_many_images: 409,
  name_taken: 409,
  image_in_use: 409,
  image_not_ready: 409,
  not_found: 422,
  not_public: 422,
  config: 422,
  registry_unavailable: 503,
  images_unavailable: 503,
  portal_unavailable: 503,
};

/** A refusal of the workspace images, THE way they are made: its code is one of the contract's, its status the table's. */
export function imageError(code: WorkspaceImageError, message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError(code, IMAGE_ERROR_STATUS[code], message, details);
}

const imagesUnavailable = () => imageError("images_unavailable", "The workspace portal does not serve images yet");
const portalUnavailable = (why = "could not be reached") => imageError("portal_unavailable", `The workspace portal ${why}`);

// ---------------------------------------------------------------- the portal's base (§7) and the rollout's guard

/** What the portal says of its current `quiz-base`. */
export type PortalBase =
  | { kind: "base"; base: CodespaceBaseImage }
  /** No release yet (`base_unreleased`), or the registry unreadable: images work, nothing is obsolete. */
  | { kind: "unreleased" }
  /** An older portal: no image route. */
  | { kind: "unsupported" }
  /** No answer: never cached. */
  | { kind: "unreachable" };

/** The portal's current `quiz-base`, as the plugin instance that made the reader keeps it. */
export interface BaseReader {
  read(): Promise<PortalBase>;
}

/** The base is read at most every five minutes (a release moves with a deploy). */
const BASE_TTL_MS = 5 * 60_000;

/**
 * A reader of `GET /api/images/base`, its answer cached five minutes by the
 * server's clock in the reader itself (one per plugin instance); a portal
 * that does not answer is asked again at the next read.
 */
export function baseReader(app: Pick<FastifyInstance, "clock" | "log">, config: AppConfig): BaseReader {
  let cached: { at: number; value: PortalBase } | null = null;
  return {
    async read() {
      const now = app.clock.now();
      const age = cached === null ? Infinity : now.getTime() - cached.at;
      if (cached && age >= 0 && age < BASE_TTL_MS) return cached.value;
      let value: PortalBase;
      try {
        const response = await portalCall(config, now, "GET", IMAGE_BASE_PATH);
        if (response.status === 404) value = { kind: "unsupported" };
        else if (response.status === 503) value = { kind: "unreleased" };
        else {
          const base = response.ok ? CodespaceBaseImage.safeParse(await response.json().catch(() => null)) : null;
          value = base?.success ? { kind: "base", base: base.data } : { kind: "unreachable" };
        }
      } catch (err) {
        app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "codespace: the portal's base unreadable");
        value = { kind: "unreachable" };
      }
      if (value.kind !== "unreachable") cached = { at: now.getTime(), value };
      return value;
    },
  };
}

// ---------------------------------------------------------------- the staff's list

/** The projects that pick each of `imageIds`. */
async function usersOf(db: Db | Tx, imageIds: string[]): Promise<Map<string, { id: string; name: string }[]>> {
  const rows =
    imageIds.length === 0
      ? []
      : await db
          .select({ imageId: codespaceProjects.imageId, id: projects.id, name: projects.name })
          .from(codespaceProjects)
          .innerJoin(projects, eq(projects.id, codespaceProjects.projectId))
          .where(inArray(codespaceProjects.imageId, imageIds))
          .orderBy(asc(projects.name));
  const by = new Map<string, { id: string; name: string }[]>();
  for (const { imageId, ...project } of rows) by.set(imageId!, [...(by.get(imageId!) ?? []), project]);
  return by;
}

function viewOf(row: ImageRow, base: PortalBase, projectsOf: { id: string; name: string }[]): CourseWorkspaceImage {
  return {
    id: row.id,
    name: row.name,
    reference: row.reference,
    digestReference: row.digestReference,
    state: row.state,
    reason: row.reason,
    detail: row.detail,
    baseVersion: row.baseVersion,
    diskBytes: row.diskBytes,
    obsolete: imageObsolete(row.baseVersion, base.kind === "base" ? base.base.version : null),
    projects: projectsOf,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One image, as its course's list shows it. */
export async function imageView(db: Db, bases: BaseReader, row: ImageRow): Promise<CourseWorkspaceImage> {
  return viewOf(row, await bases.read(), (await usersOf(db, [row.id])).get(row.id) ?? []);
}

/** `GET /app/api/courses/:id/workspace-images`: every staff member's read, and the rollout's guard. */
export async function courseImages(db: Db, bases: BaseReader, courseId: string, canManage: boolean): Promise<CourseWorkspaceImages> {
  const base = await bases.read();
  if (base.kind === "unsupported") throw imagesUnavailable();
  const rows = await db
    .select()
    .from(courseWorkspaceImages)
    .where(eq(courseWorkspaceImages.courseId, courseId))
    .orderBy(asc(courseWorkspaceImages.createdAt), asc(courseWorkspaceImages.name));
  const using = await usersOf(db, rows.map((r) => r.id));
  return {
    images: rows.map((row) => viewOf(row, base, using.get(row.id) ?? [])),
    base: base.kind === "base" ? { reference: base.base.reference, version: base.base.version } : null,
    canManage,
    max: COURSE_WORKSPACE_IMAGES_MAX,
  };
}

/** The image of the course, or null (another course's is a miss). */
export async function imageOfCourse(db: Db | Tx, courseId: string, imageId: string): Promise<ImageRow | null> {
  const [row] = await db
    .select()
    .from(courseWorkspaceImages)
    .where(and(eq(courseWorkspaceImages.id, imageId), eq(courseWorkspaceImages.courseId, courseId)));
  return row ?? null;
}

// ---------------------------------------------------------------- the portal's admission

/**
 * Asks the portal to admit `reference` (a tag or a digest; it resolves the
 * tag): its admission, or the portal's refusal — `422 not_found |
 * not_public | config` and `503 registry_unavailable` with its `detail`,
 * `503 images_unavailable` from an older portal, `503 portal_unavailable`
 * otherwise.
 */
async function requestAdmission(config: AppConfig, now: Date, reference: string): Promise<CodespaceImageAdmission> {
  let response: Response;
  try {
    response = await portalCall(config, now, "POST", IMAGE_ADMISSIONS_PATH, { reference });
  } catch {
    throw portalUnavailable();
  }
  if (response.status === 404) throw imagesUnavailable();
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 202) {
    const admission = CodespaceImageAdmission.safeParse(body);
    if (admission.success) return admission.data;
  } else if (response.status === 422 || response.status === 503) {
    const refusal = CodespaceImageAdmissionError.safeParse(body);
    if (refusal.success) throw imageError(refusal.data.error, "The workspace portal refused the image", { detail: refusal.data.detail ?? null });
  }
  throw portalUnavailable(`answered ${response.status}`);
}

/** A verdict to write on an image: the columns, and what changed in service. */
interface Verdict {
  set: Partial<typeof courseWorkspaceImages.$inferInsert>;
  outcome: "pending" | "admitted" | "unchanged" | "refused";
}

type Admission = Pick<CodespaceImageAdmission, "reference" | "state" | "reason" | "detail" | "baseVersion" | "diskBytes">;

const inFlight = (state: AdmissionState): boolean => (ADMISSION_IN_FLIGHT as readonly AdmissionState[]).includes(state);

/**
 * What an admission makes of the image (ADR-146 §6): in flight, it is the
 * candidate (`pending`); refused, the digest in service stays (`refused`);
 * ready on another digest than the one in service, it replaces it
 * (`admitted`); ready on the same, nothing changes in service (`unchanged`).
 */
function verdictOf(row: Pick<ImageRow, "digestReference">, admission: Admission): Verdict {
  if (inFlight(admission.state)) {
    return { set: { candidateReference: admission.reference, state: admission.state, reason: null, detail: null }, outcome: "pending" };
  }
  const settled = { candidateReference: null, reason: null, detail: null };
  if (admission.state === "refused") {
    return { set: { ...settled, state: "refused", reason: admission.reason ?? "pull_failed", detail: admission.detail }, outcome: "refused" };
  }
  if (admission.reference === row.digestReference) return { set: { ...settled, state: "ready" }, outcome: "unchanged" };
  return {
    set: { ...settled, state: "ready", digestReference: admission.reference, baseVersion: admission.baseVersion, diskBytes: admission.diskBytes },
    outcome: "admitted",
  };
}

/** A refusal Quiz decides itself: the portal lost the admission, or never settled it in time. */
const lost = (detail: string): Admission => ({
  reference: "",
  state: "refused",
  reason: "interrupted" satisfies ImageRefusal,
  detail,
  baseVersion: null,
  diskBytes: null,
});

/**
 * Writes a verdict, only while the row still holds the candidate it was
 * about (a Refresh meanwhile wins), audits the portal's verdict, and asks a
 * sync of every project that picks the image when the digest in service
 * moved.
 */
async function settle(app: App, config: AppConfig, row: ImageRow & { candidateReference: string }, verdict: Verdict, now: Date): Promise<void> {
  const written = await app.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(courseWorkspaceImages)
      .set({ ...verdict.set, updatedAt: now })
      .where(and(eq(courseWorkspaceImages.id, row.id), eq(courseWorkspaceImages.candidateReference, row.candidateReference)))
      .returning();
    if (updated) await auditVerdict(tx, row, updated, verdict, now);
    return updated;
  });
  if (written && verdict.outcome === "admitted") await syncUsers(app, config, row.id);
}

async function auditVerdict(tx: Tx, before: ImageRow, after: ImageRow, verdict: Verdict, now: Date): Promise<void> {
  if (verdict.outcome === "admitted") {
    await audit(tx, {
      ...SYSTEM_ACTOR,
      action: "codespace.image_admitted",
      subjectType: "course",
      subjectId: after.courseId,
      payload: { imageId: after.id, digestReference: after.digestReference, previous: before.digestReference, baseVersion: after.baseVersion },
      at: now,
    });
  } else if (verdict.outcome === "refused") {
    await audit(tx, {
      ...SYSTEM_ACTOR,
      action: "codespace.image_refused",
      subjectType: "course",
      subjectId: after.courseId,
      payload: { imageId: after.id, candidate: before.candidateReference, reason: after.reason, detail: after.detail },
      at: now,
    });
  }
}

/** A sync of every project that picks the image: its digest in service moved (§6). */
async function syncUsers(app: App, config: AppConfig, imageId: string): Promise<void> {
  const rows = await app.db.select({ projectId: codespaceProjects.projectId }).from(codespaceProjects).where(eq(codespaceProjects.imageId, imageId));
  for (const { projectId } of rows) await requestCodespaceSync(app, config, projectId);
}

/**
 * One tick of an admission's follow-up: asks the portal about the row's
 * candidate and mirrors the answer. `pending` while it is in flight;
 * `settled` once ready, refused, lost (`interrupted`: the portal forgot it,
 * `unknown_image`; or no verdict within {@link ADMISSION_GIVE_UP_MS},
 * `timeout`), or when the row holds no candidate. A portal that cannot be
 * asked is a tick that changes nothing.
 */
export async function followAdmission(app: App, config: AppConfig, imageId: string): Promise<"pending" | "settled"> {
  const now = app.clock.now();
  const [found] = await app.db.select().from(courseWorkspaceImages).where(eq(courseWorkspaceImages.id, imageId));
  if (!found || found.candidateReference === null) return "settled";
  const row = { ...found, candidateReference: found.candidateReference };
  if (now.getTime() - row.requestedAt.getTime() > ADMISSION_GIVE_UP_MS) {
    await settle(app, config, row, verdictOf(row, lost("timeout")), now);
    return "settled";
  }
  let response: Response;
  try {
    response = await portalCall(config, now, "GET", imageAdmissionPath(row.candidateReference));
  } catch (err) {
    app.log.warn({ imageId, err: err instanceof Error ? err.message : String(err) }, "codespace.image: the portal unreachable");
    return "pending";
  }
  if (response.status === 404) {
    await settle(app, config, row, verdictOf(row, lost("unknown_image")), now);
    return "settled";
  }
  const admission = response.ok ? CodespaceImageAdmission.safeParse(await response.json().catch(() => null)) : null;
  if (!admission?.success) {
    app.log.warn({ imageId, status: response.status }, "codespace.image: the portal's answer is not an admission");
    return "pending";
  }
  const verdict = verdictOf(row, admission.data);
  await settle(app, config, row, verdict, now);
  return verdict.outcome === "pending" ? "pending" : "settled";
}

/**
 * The follow-up of an admission in flight: a job {@link ADMISSION_POLL_MS}
 * on. Without a queue (`JOBS_DISABLED`), one tick now, its failure logged:
 * the row then shows the state of that moment.
 */
export async function followLater(app: App, config: AppConfig, imageId: string): Promise<void> {
  if (app.boss) {
    await app.boss.send(CODESPACE_IMAGE_QUEUE, { imageId }, { startAfter: new Date(app.clock.now().getTime() + ADMISSION_POLL_MS) });
    return;
  }
  try {
    await followAdmission(app, config, imageId);
  } catch (err) {
    app.log.warn({ err, imageId }, "codespace.image inline follow-up failed");
  }
}

// ---------------------------------------------------------------- an owner's writes

const nameTaken = () => imageError("name_taken", "Another image of this course has that name");

/** The name's unique index answered: `409 name_taken`. */
function rethrowNameTaken(err: unknown): never {
  if (isUniqueViolation(err, "course_workspace_images_course_name_uq")) throw nameTaken();
  throw err;
}

async function refuseFullCourse(db: Db | Tx, courseId: string): Promise<void> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(courseWorkspaceImages)
    .where(eq(courseWorkspaceImages.courseId, courseId));
  if (n >= COURSE_WORKSPACE_IMAGES_MAX) throw imageError("too_many_images", `A course holds ${COURSE_WORKSPACE_IMAGES_MAX} images at most`);
}

/**
 * Adds an image to the course: the cap and the name checked before the
 * portal is asked to admit the reference (its refusal is the answer: no
 * row), the row written under the course's lock (the cap again, the name by
 * its unique index), audited, and its admission followed while in flight.
 */
export async function addImage(
  app: App,
  config: AppConfig,
  courseId: string,
  body: { name: string; reference: string },
  who: { userId: string; actor: AuditActor },
  now: Date,
): Promise<ImageRow> {
  await refuseFullCourse(app.db, courseId);
  const [clash] = await app.db
    .select({ id: courseWorkspaceImages.id })
    .from(courseWorkspaceImages)
    .where(and(eq(courseWorkspaceImages.courseId, courseId), sql`lower(${courseWorkspaceImages.name}) = lower(${body.name})`));
  if (clash) throw nameTaken();
  const admission = await requestAdmission(config, now, body.reference);
  const verdict = verdictOf({ digestReference: null }, admission);
  const row = await app.db
    .transaction(async (tx) => {
      // Two adds at once: the second waits here, then counts the first.
      await tx.select({ id: courses.id }).from(courses).where(eq(courses.id, courseId)).for("no key update");
      await refuseFullCourse(tx, courseId);
      const [inserted] = await tx
        .insert(courseWorkspaceImages)
        .values({
          id: randomUUID(),
          courseId,
          name: body.name,
          reference: body.reference,
          state: "downloading",
          ...verdict.set,
          requestedAt: now,
          createdBy: who.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await audit(tx, {
        ...who.actor,
        action: "codespace.image_added",
        subjectType: "course",
        subjectId: courseId,
        payload: { imageId: inserted!.id, name: inserted!.name, reference: inserted!.reference },
        at: now,
      });
      await auditVerdict(tx, { ...inserted!, digestReference: null, candidateReference: admission.reference }, inserted!, verdict, now);
      return inserted!;
    })
    .catch(rethrowNameTaken);
  if (verdict.outcome === "pending") await followLater(app, config, row.id);
  return row;
}

/** Renames an image; its reference never changes. A name another image holds is `409 name_taken`, by the unique index. */
export async function renameImage(db: Db, row: ImageRow, name: string, actor: AuditActor, now: Date): Promise<ImageRow> {
  if (name === row.name) return row;
  return db
    .transaction(async (tx) => {
      const [renamed] = await tx.update(courseWorkspaceImages).set({ name, updatedAt: now }).where(eq(courseWorkspaceImages.id, row.id)).returning();
      await audit(tx, {
        ...actor,
        action: "codespace.image_renamed",
        subjectType: "course",
        subjectId: row.courseId,
        payload: { imageId: row.id, name, reference: row.reference, from: row.name },
        at: now,
      });
      return renamed!;
    })
    .catch(rethrowNameTaken);
}

/**
 * Refresh (ADR-146 §6), never refused for a project using the image, even
 * open under supervision: the portal re-resolves the tag and admits what it
 * names now. The same digest, ready, changes nothing; another one, once
 * ready, replaces the digest in service and every project that picks the
 * image is synced; a refusal leaves the digest in service. An admission
 * still in flight is answered as it is (no second request) until the
 * follow-up gives up on it.
 */
export async function refreshImage(app: App, config: AppConfig, row: ImageRow, actor: AuditActor, now: Date): Promise<ImageRow> {
  if (row.candidateReference !== null && now.getTime() - row.requestedAt.getTime() <= ADMISSION_GIVE_UP_MS) return row;
  const admission = await requestAdmission(config, now, row.reference);
  const verdict = verdictOf(row, admission);
  const updated = await app.db.transaction(async (tx) => {
    const [written] = await tx
      .update(courseWorkspaceImages)
      .set({ ...verdict.set, requestedAt: now, updatedAt: now })
      .where(eq(courseWorkspaceImages.id, row.id))
      .returning();
    if (!written) throw notFoundError("image");
    await audit(tx, {
      ...actor,
      action: "codespace.image_refreshed",
      subjectType: "course",
      subjectId: row.courseId,
      payload: { imageId: row.id, name: row.name, reference: row.reference, candidate: verdict.outcome === "unchanged" ? null : admission.reference },
      at: now,
    });
    await auditVerdict(tx, { ...row, candidateReference: admission.reference }, written, verdict, now);
    return written;
  });
  if (verdict.outcome === "admitted") await syncUsers(app, config, row.id);
  if (verdict.outcome === "pending") await followLater(app, config, row.id);
  return updated;
}

/**
 * Removes an image no project picks (`409 image_in_use`, the projects
 * named). Only Quiz's row goes: the portal keeps its admission and the
 * store its bytes (ADR-146 §8: the administrator frees the disk by hand,
 * and a sync already sent may still name the digest).
 *
 * The check and the delete hold the image row's lock: a project's choice
 * landing meanwhile (its key check takes a share lock on that row) either
 * committed first, and is counted, or waits and then finds no image (404).
 * The key's `SET NULL` never runs for an image in use.
 */
export async function removeImage(db: Db, row: ImageRow, actor: AuditActor, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: courseWorkspaceImages.id }).from(courseWorkspaceImages).where(eq(courseWorkspaceImages.id, row.id)).for("update");
    const using = (await usersOf(tx, [row.id])).get(row.id) ?? [];
    if (using.length > 0) throw imageError("image_in_use", "A project of this course runs this image", { projects: using });
    await tx.delete(courseWorkspaceImages).where(eq(courseWorkspaceImages.id, row.id));
    await audit(tx, {
      ...actor,
      action: "codespace.image_removed",
      subjectType: "course",
      subjectId: row.courseId,
      payload: { imageId: row.id, name: row.name, reference: row.reference, digestReference: row.digestReference },
      at: now,
    });
  });
}

// ---------------------------------------------------------------- a project's choice (§4)

/**
 * Sets the image a project runs: one of its course's (another course's is
 * the 404 of a missing image) with a digest in service (`409
 * image_not_ready`), or null for the default. Not frozen by a launch: the
 * containers started afterwards run it. Under the project's portal row's
 * lock; audited when it changes, and the project synced.
 */
export async function setProjectImage(
  app: App,
  config: AppConfig,
  project: { id: string; courseId: string },
  imageId: string | null,
  actor: AuditActor,
  now: Date,
): Promise<void> {
  const changed = await app.db
    .transaction(async (tx) => {
      if (imageId !== null) {
        const image = await imageOfCourse(tx, project.courseId, imageId);
        if (!image) throw notFoundError("image");
        if (image.digestReference === null) throw imageError("image_not_ready", "This image is not admitted yet");
      }
      const [current] = await tx
        .select({ imageId: codespaceProjects.imageId })
        .from(codespaceProjects)
        .where(eq(codespaceProjects.projectId, project.id))
        .for("update");
      const from = current?.imageId ?? null;
      if (from === imageId) return false;
      await tx
        .insert(codespaceProjects)
        .values({ projectId: project.id, imageId })
        .onConflictDoUpdate({ target: codespaceProjects.projectId, set: { imageId } });
      await audit(tx, { ...actor, action: "codespace.project_image", subjectType: "project", subjectId: project.id, payload: { from, to: imageId }, at: now });
      return true;
    })
    .catch((err: unknown) => {
      // Removed meanwhile.
      if (isForeignKeyViolation(err, "codespace_projects_image_id_course_workspace_images_id_fk")) throw notFoundError("image");
      throw err;
    });
  if (changed) await requestCodespaceSync(app, config, project.id);
}

// ---------------------------------------------------------------- the administrator's view (§8)

const EngineImages = z.array(CodespaceEngineImage);

/**
 * `GET /app/api/admin/workspace-images`: the engine's store as the portal
 * lists it (`GET /api/images`), each admission with the course images that
 * name its reference and the projects that pick them. `503
 * images_unavailable` from an older portal, `503 portal_unavailable` when
 * the portal cannot be asked.
 */
export async function adminImages(app: App, config: AppConfig): Promise<AdminWorkspaceImage[]> {
  let response: Response;
  try {
    response = await portalCall(config, app.clock.now(), "GET", IMAGES_PATH);
  } catch {
    throw portalUnavailable();
  }
  if (response.status === 404) throw imagesUnavailable();
  const listed = response.ok ? EngineImages.safeParse(await response.json().catch(() => null)) : null;
  if (!listed?.success) throw portalUnavailable(`answered ${response.status}`);
  const store = listed.data;
  const references = [...new Set(store.flatMap((image) => image.admissions.map((a) => a.reference)))];
  const rows =
    references.length === 0
      ? []
      : await app.db
          .select({ image: courseWorkspaceImages, course: { id: courses.id, name: courses.name, code: courses.code } })
          .from(courseWorkspaceImages)
          .innerJoin(courses, eq(courses.id, courseWorkspaceImages.courseId))
          .where(or(inArray(courseWorkspaceImages.digestReference, references), inArray(courseWorkspaceImages.candidateReference, references)))
          .orderBy(asc(courses.name), asc(courseWorkspaceImages.name));
  const using = await usersOf(app.db, rows.map((r) => r.image.id));
  const usesOf = (reference: string) =>
    rows
      .filter(({ image }) => image.digestReference === reference || image.candidateReference === reference)
      .map(({ image, course }) => ({ course, image: { id: image.id, name: image.name }, projects: using.get(image.id) ?? [] }));
  return store.map((image) => ({ ...image, admissions: image.admissions.map((a) => ({ ...a, uses: usesOf(a.reference) })) }));
}
