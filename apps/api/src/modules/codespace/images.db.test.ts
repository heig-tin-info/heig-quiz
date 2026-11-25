/**
 * A course's workspace images (ADR-146 §4–§8), Quiz's side, over the real
 * application with the portal a stub on `portal.test`:
 *
 * - who: every staff member reads; an owner with the workspace grant
 *   writes (an assistant `403 owner_required`, an owner without the grant
 *   `403 codespace_not_granted`, anyone else the 404 of a missing course);
 * - the list: five at most, a name unique in the course (case ignored);
 * - the admission: the portal's refusal of a reference, the follow-up that
 *   mirrors its states, swaps a Refresh's candidate in service once ready,
 *   keeps the digest in service on a refusal, gives up after 30 minutes;
 * - a project's choice: a ready image of its own course only, sent in the
 *   sync as its digest in service, or null for the default;
 * - removal refused while a project picks it; the portal un-admits a
 *   reference no other course names;
 * - the rollout's guard: an older portal makes every route `404
 *   images_unavailable`;
 * - the administrator's view of the store.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AdminWorkspaceImage,
  CodespaceAssignmentSync,
  CourseWorkspaceImage,
  CourseWorkspaceImages,
  ProjectSummary,
  ProjectWorkspace,
  SERVICE_AUDIENCE,
  ServiceTokenClaims,
  courseWorkspaceImagePath,
  courseWorkspaceImagesPath,
  projectWorkspaceImagePath,
  ADMIN_WORKSPACE_IMAGES_PATH,
} from "@quiz/contracts";
import { bindingMismatch, requestBinding, verifyHs256 } from "@quiz/domain";

import type { AppConfig } from "../../config.js";
import { auditLog, courseStaff, courses, courseWorkspaceImages } from "../../db/schema.js";
import { orgsRoute } from "../../github/testing.js";
import { ADMISSION_GIVE_UP_MS, followAdmission } from "./images.js";
import { syncPayload } from "./service.js";
import {
  CODESPACE_ENV,
  PORTAL_SECRET,
  admissionOf,
  connectedClassroom,
  digestRef,
  fakeImages,
  fakePortal,
  grantedTeacher,
  workModeBody,
  type PortalCall,
  type Room,
} from "./testing.js";
import { call, server, useProjectWorld, usersRoute, world, type Headers } from "../../test/projectWorld.js";

const NOW = "2026-11-25T08:00:00.000Z";
/** Each test runs ten minutes after the last: the routes' quiz-base, cached five minutes, is read again. */
let minutes = 0;
const CONFIG = CODESPACE_ENV as AppConfig;
const DEADLINE = "2026-12-14T22:00:00.000Z";

interface Person {
  id: string;
  headers: Headers;
}

const portal = fakePortal();

useProjectWorld({ routes: [orgsRoute(() => []), usersRoute, world.route], env: CODESPACE_ENV, fetch: portal.fetch, teacher: false });

let owner: Person;

beforeAll(async () => {
  owner = await grantedTeacher(true, 3);
});

beforeEach(() => {
  server.clock.set(new Date(Date.parse(NOW) + (minutes += 10) * 60_000));
  world.allowPushes();
  portal.calls.length = 0;
  portal.putStatus = 200;
  portal.down = false;
  portal.images = fakeImages();
});

// ---------------------------------------------------------------- helpers

/** The portal's checks (audit L25): the token verifies and binds exactly its request, query string included. */
async function expectBoundServiceToken(c: PortalCall): Promise<void> {
  const verdict = await verifyHs256(c.authorization!.replace(/^Bearer /, ""), PORTAL_SECRET, {
    audience: SERVICE_AUDIENCE,
    issuer: "heig-quiz",
    requireJti: true,
    now: () => Math.floor(server.clock.now().getTime() / 1000),
  });
  expect(verdict.ok).toBe(true);
  const claims = ServiceTokenClaims.parse(verdict.ok ? verdict.claims : null);
  expect(bindingMismatch(claims, await requestBinding(c.method, c.path, c.raw))).toBeNull();
}

let rooms = 0;
const connected = () => connectedClassroom(owner, [], { prefix: `img${(rooms += 1)}` });
const seat = (room: Room, userId: string, role: "owner" | "assistant") =>
  server.app.db.insert(courseStaff).values({ courseId: room.courseId, userId, role });

/** A tag the portal resolves to the digest reference made of `n`. */
function tag(name: string, n: string): { tag: string; digest: string } {
  const digest = digestRef(`acme/${name}`, n);
  portal.images.tags.set(`ghcr.io/acme/${name}:latest`, digest);
  return { tag: `ghcr.io/acme/${name}:latest`, digest };
}

const list = (room: Room, who: Person = owner) => call("GET", courseWorkspaceImagesPath(room.courseId), who.headers);
const add = (room: Room, body: object, who: Person = owner) => call("POST", courseWorkspaceImagesPath(room.courseId), who.headers, body);
const refresh = (room: Room, imageId: string, who: Person = owner) =>
  call("POST", `${courseWorkspaceImagePath(room.courseId, imageId)}/refresh`, who.headers);
const pick = (projectId: string, imageId: string | null, who: Person = owner) =>
  call("PUT", projectWorkspaceImagePath(projectId), who.headers, { imageId });

/** Adds an image named `name` on the tag `n` resolves, and returns it as the route answered. */
async function added(room: Room, name: string, n: string): Promise<CourseWorkspaceImage & { tagged: string }> {
  const { tag: tagged } = tag(name.toLowerCase().replace(/[^a-z0-9]/g, ""), n);
  const res = await add(room, { name, reference: tagged });
  expect(res.statusCode, res.body).toBe(201);
  return { ...CourseWorkspaceImage.parse(res.json()), tagged };
}

/** The portal settles `reference`'s admission, and the follow-up ticks once. */
async function settleOn(imageId: string, reference: string, state: string, extra: Record<string, unknown> = {}) {
  portal.images.admissions.set(reference, admissionOf(reference, state, extra));
  return followAdmission(server.app, CONFIG, imageId);
}

/** An image ready on `n`'s digest, base 1.0.0. */
async function readyImage(room: Room, name: string, n: string) {
  const image = await added(room, name, n);
  await settleOn(image.id, image.digestReference ?? portal.images.tags.get(image.tagged)!, "ready", {
    baseVersion: "1.0.0",
    diskBytes: 1_000,
  });
  return image;
}

async function onlineProject(room: Room, name: string): Promise<string> {
  const created = await call("POST", `/app/api/classrooms/${room.classroomId}/projects`, owner.headers, {
    name,
    sourceRepo: "starter",
    deadlineAt: DEADLINE,
  });
  expect(created.statusCode, created.body).toBe(201);
  const { id } = ProjectSummary.parse(created.json());
  expect((await call("POST", `/app/api/projects/${id}/publish`, owner.headers)).statusCode).toBe(200);
  const mode = await call("PUT", `/app/api/projects/${id}/workspace/mode`, owner.headers, workModeBody("online"));
  expect(mode.statusCode, mode.body).toBe(200);
  return id;
}

/** The image of the last sync the portal received for the project. */
const lastSyncImage = (projectId: string) =>
  CodespaceAssignmentSync.parse(portal.calls.filter((c) => c.method === "PUT" && c.path === `/api/assignments/${projectId}`).at(-1)!.body).image;

const rowOf = async (imageId: string) =>
  (await server.app.db.select().from(courseWorkspaceImages).where(eq(courseWorkspaceImages.id, imageId)))[0];

const audits = (action: string, subjectId: string) =>
  server.app.db.select().from(auditLog).where(and(eq(auditLog.action, action as never), eq(auditLog.subjectId, subjectId)));

// ---------------------------------------------------------------- who

describe("who reads and who writes (ADR-146 §4)", () => {
  it("lets every staff member read, the owner with the grant write, and 404s anyone else", async () => {
    const room = await connected();
    const assistant = await grantedTeacher(true);
    await seat(room, assistant.id, "assistant");
    const ungranted = await grantedTeacher(false);
    await seat(room, ungranted.id, "owner");
    const outsider = await grantedTeacher(true);

    const image = await added(room, "C lab", "a");
    const imagePath = courseWorkspaceImagePath(room.courseId, image.id);

    const read = CourseWorkspaceImages.parse((await list(room, assistant)).json());
    expect(read).toMatchObject({ canManage: false, max: 5, images: [{ id: image.id, name: "C lab" }] });
    expect(CourseWorkspaceImages.parse((await list(room, ungranted)).json()).canManage).toBe(false);
    expect(CourseWorkspaceImages.parse((await list(room)).json()).canManage).toBe(true);
    expect((await list(room, outsider)).statusCode).toBe(404);

    const writes = (who: Person) => [
      add(room, { name: "Other", reference: "ghcr.io/acme/other:1" }, who),
      call("PATCH", imagePath, who.headers, { name: "Renamed" }),
      refresh(room, image.id, who),
      call("DELETE", imagePath, who.headers),
    ];
    for (const res of await Promise.all(writes(assistant))) expect([res.statusCode, res.json().error]).toEqual([403, "owner_required"]);
    for (const res of await Promise.all(writes(ungranted))) expect([res.statusCode, res.json().error]).toEqual([403, "codespace_not_granted"]);
    for (const res of await Promise.all(writes(outsider))) expect(res.statusCode).toBe(404);
    // A malformed body from a refused caller is the same refusal: the role is the loader's.
    const malformed = await add(room, { name: "" }, assistant);
    expect(malformed.statusCode).toBe(403);
    expect(await rowOf(image.id)).toMatchObject({ name: "C lab" });

    // An image of another course is the 404 of a missing one.
    const other = await connected();
    const foreign = await call("PATCH", courseWorkspaceImagePath(other.courseId, image.id), owner.headers, { name: "X" });
    expect(foreign.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------- the list

describe("the list (ADR-146 §4)", () => {
  it("holds five images at most, a name once (case ignored), and refuses what the portal cannot resolve", async () => {
    const room = await connected();
    for (const n of ["1", "2", "3", "4", "5"]) await added(room, `Image ${n}`, n);
    const sixth = await add(room, { name: "Image 6", reference: tag("six", "6").tag });
    expect([sixth.statusCode, sixth.json().error]).toEqual([409, "too_many_images"]);

    const second = await connected();
    await added(second, "C lab", "a");
    const twin = await add(second, { name: "c LAB", reference: tag("twin", "c").tag });
    expect([twin.statusCode, twin.json().error]).toEqual([409, "name_taken"]);
    const other = await added(second, "Python", "d");
    const rename = await call("PATCH", courseWorkspaceImagePath(second.courseId, other.id), owner.headers, { name: "C LAB" });
    expect([rename.statusCode, rename.json().error]).toEqual([409, "name_taken"]);
    const renamed = await call("PATCH", courseWorkspaceImagePath(second.courseId, other.id), owner.headers, { name: "Python 3" });
    expect(CourseWorkspaceImage.parse(renamed.json())).toMatchObject({ name: "Python 3", reference: other.reference });
    expect((await audits("codespace.image_renamed", second.courseId)).map((a) => a.payload)).toEqual([
      expect.objectContaining({ imageId: other.id, name: "Python 3", from: "Python" }),
    ]);

    // The portal's refusal of the reference is the answer, its detail quoted; no row.
    const unknown = await add(second, { name: "Ghost", reference: "ghcr.io/acme/ghost:1" });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ error: "not_found", detail: "manifest unknown" });
    portal.images.postRefusal = { status: 503, body: { error: "registry_unavailable" } };
    const down = await add(second, { name: "Later", reference: tag("later", "e").tag });
    expect([down.statusCode, down.json().error]).toEqual([503, "registry_unavailable"]);
    portal.images.postRefusal = null;
    expect(CourseWorkspaceImages.parse((await list(second)).json()).images.map((i) => i.name)).toEqual(["C lab", "Python 3"]);

    // A malformed reference never reaches the portal.
    portal.calls.length = 0;
    const bad = await add(second, { name: "Quay", reference: "quay.io/acme/lab:1" });
    expect(bad.statusCode).toBe(400);
    expect(portal.calls.filter((c) => c.method === "POST")).toEqual([]);
  });
});

// ---------------------------------------------------------------- the admission

describe("the admission's follow-up (ADR-146 §5)", () => {
  it("mirrors the portal's states, then puts the digest in service, with a bound service token", async () => {
    const room = await connected();
    const image = await added(room, "C lab", "a");
    const digest = portal.images.tags.get(image.tagged)!;
    expect(image).toMatchObject({ reference: image.tagged, digestReference: null, state: "downloading", obsolete: null });
    const [post] = portal.calls.filter((c) => c.method === "POST" && c.path === "/api/images/admissions");
    expect(post!.body).toEqual({ reference: image.tagged });
    await expectBoundServiceToken(post!);

    portal.calls.length = 0;
    expect(await settleOn(image.id, digest, "checking")).toBe("pending");
    const [follow] = portal.calls;
    expect(follow!.path).toBe(`/api/images/admissions?reference=${encodeURIComponent(digest)}`);
    await expectBoundServiceToken(follow!);
    expect(await rowOf(image.id)).toMatchObject({ state: "checking", candidateReference: digest, digestReference: null });

    expect(await settleOn(image.id, digest, "ready", { baseVersion: "1.0.0", diskBytes: 2_000, compressedBytes: 700 })).toBe("settled");
    const [ready] = CourseWorkspaceImages.parse((await list(room)).json()).images;
    // The current base is 1.1.0: an image on 1.0.0 is obsolete.
    expect(ready).toMatchObject({ digestReference: digest, state: "ready", baseVersion: "1.0.0", diskBytes: 2_000, obsolete: true });
    expect((await audits("codespace.image_admitted", room.courseId)).map((a) => a.payload)).toEqual([
      { imageId: image.id, digestReference: digest, previous: null, baseVersion: "1.0.0" },
    ]);
    // Nothing left to follow.
    expect(await followAdmission(server.app, CONFIG, image.id)).toBe("settled");
  });

  it("records a refusal, an admission the portal forgot, and one that never settles", async () => {
    const room = await connected();
    const refused = await added(room, "Big", "a");
    await settleOn(refused.id, portal.images.tags.get(refused.tagged)!, "refused", { reason: "too_large", detail: "5368709120>4294967296" });
    expect(await rowOf(refused.id)).toMatchObject({ state: "refused", reason: "too_large", detail: "5368709120>4294967296", candidateReference: null, digestReference: null });
    expect((await audits("codespace.image_refused", room.courseId)).map((a) => a.payload)).toEqual([
      expect.objectContaining({ imageId: refused.id, reason: "too_large" }),
    ]);

    const forgotten = await added(room, "Forgotten", "b");
    portal.images.admissions.clear();
    expect(await followAdmission(server.app, CONFIG, forgotten.id)).toBe("settled");
    expect(await rowOf(forgotten.id)).toMatchObject({ state: "refused", reason: "interrupted", detail: "unknown_image" });

    const slow = await added(room, "Slow", "c");
    portal.down = true;
    expect(await followAdmission(server.app, CONFIG, slow.id)).toBe("pending");
    portal.down = false;
    server.clock.set(new Date(server.clock.now().getTime() + ADMISSION_GIVE_UP_MS + 1_000));
    expect(await followAdmission(server.app, CONFIG, slow.id)).toBe("settled");
    expect(await rowOf(slow.id)).toMatchObject({ state: "refused", reason: "interrupted", detail: "timeout", candidateReference: null });

    // A refused image is asked again by a Refresh: the portal starts it over.
    const again = CourseWorkspaceImage.parse((await refresh(room, refused.id)).json());
    expect(again).toMatchObject({ state: "downloading", reason: null });
  });
});

// ---------------------------------------------------------------- a project's choice

describe("a project's image (ADR-146 §4)", () => {
  it("picks a ready image of its own course, sent in the sync by digest; null is the default", async () => {
    const room = await connected();
    const lab = await onlineProject(room, "Image lab");
    expect(lastSyncImage(lab)).toBeNull();

    const pendingImage = await added(room, "Pending", "a");
    const notReady = await pick(lab, pendingImage.id);
    expect([notReady.statusCode, notReady.json().error]).toEqual([409, "image_not_ready"]);

    const other = await connected();
    const foreign = await readyImage(other, "Foreign", "b");
    expect((await pick(lab, foreign.id)).statusCode).toBe(404);

    const assistant = await grantedTeacher(true);
    await seat(room, assistant.id, "assistant");
    const image = await readyImage(room, "C lab", "c");
    const byAssistant = await pick(lab, image.id, assistant);
    expect([byAssistant.statusCode, byAssistant.json().error]).toEqual([403, "owner_required"]);

    const set = await pick(lab, image.id);
    expect(set.statusCode, set.body).toBe(200);
    expect(ProjectWorkspace.parse(set.json()).image).toEqual({ id: image.id, name: "C lab" });
    const digest = portal.images.tags.get(image.tagged)!;
    expect(lastSyncImage(lab)).toBe(digest);
    expect((await syncPayload(server.app.db, lab))!.image).toBe(digest);
    expect((await audits("codespace.project_image", lab)).map((a) => a.payload)).toEqual([{ from: null, to: image.id }]);
    // The staff's read says it too, and the list names the project.
    expect(ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab}/workspace`, assistant.headers)).json()).image).toEqual({
      id: image.id,
      name: "C lab",
    });
    expect(CourseWorkspaceImages.parse((await list(room)).json()).images.find((i) => i.id === image.id)!.projects).toEqual([
      { id: lab, name: "Image lab" },
    ]);

    // Remove refused while the project picks it.
    const removal = await call("DELETE", courseWorkspaceImagePath(room.courseId, image.id), owner.headers);
    expect(removal.statusCode).toBe(409);
    expect(removal.json()).toMatchObject({ error: "image_in_use", projects: [{ id: lab, name: "Image lab" }] });

    const back = await pick(lab, null);
    expect(ProjectWorkspace.parse(back.json()).image).toBeNull();
    expect(lastSyncImage(lab)).toBeNull();

    // Free now: Quiz's row goes; the portal is told nothing (ADR-146 §8: the administrator frees the disk).
    portal.calls.length = 0;
    expect((await call("DELETE", courseWorkspaceImagePath(room.courseId, image.id), owner.headers)).statusCode).toBe(204);
    expect(await rowOf(image.id)).toBeUndefined();
    expect(portal.calls).toEqual([]);
    expect((await audits("codespace.image_removed", room.courseId)).map((a) => a.payload)).toEqual([
      expect.objectContaining({ imageId: image.id, digestReference: digest }),
    ]);
  });

  it("shares a ready admission between courses, and a course's delete takes its images and its projects' choices", async () => {
    const first = await connected();
    const second = await connected();
    const a = await readyImage(first, "Shared", "a");
    // The same tag in another course: the portal answers the ready admission as it is.
    const res = await add(second, { name: "Shared too", reference: a.tagged });
    const b = CourseWorkspaceImage.parse(res.json());
    expect(b).toMatchObject({ state: "ready", digestReference: portal.images.tags.get(a.tagged) });

    const lab = await onlineProject(second, "Doomed lab");
    expect((await pick(lab, b.id)).statusCode).toBe(200);
    // Two cascades reach the project's choice and the image: the key sets null, never refuses the course's delete.
    await server.app.db.delete(courses).where(eq(courses.id, second.courseId));
    expect(await rowOf(b.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- Refresh

describe("Refresh (ADR-146 §6)", () => {
  it("swaps a new digest in once ready and syncs the projects; a refusal keeps the old; the same digest changes nothing", async () => {
    const room = await connected();
    const lab = await onlineProject(room, "Refresh lab");
    const image = await readyImage(room, "C lab", "a");
    const first = portal.images.tags.get(image.tagged)!;
    await pick(lab, image.id);

    // The same digest: nothing to do, nothing synced.
    portal.calls.length = 0;
    const same = CourseWorkspaceImage.parse((await refresh(room, image.id)).json());
    expect(same).toMatchObject({ digestReference: first, state: "ready" });
    expect(portal.calls.filter((c) => c.method === "PUT")).toEqual([]);

    // The tag moved: a candidate, the old digest still in service.
    const second = digestRef("acme/clab", "f");
    portal.images.tags.set(image.tagged, second);
    const moving = CourseWorkspaceImage.parse((await refresh(room, image.id)).json());
    expect(moving).toMatchObject({ digestReference: first, state: "downloading" });
    expect((await syncPayload(server.app.db, lab))!.image).toBe(first);
    // A second Refresh while in flight asks nothing more.
    portal.calls.length = 0;
    expect(CourseWorkspaceImage.parse((await refresh(room, image.id)).json()).state).toBe("downloading");
    expect(portal.calls.filter((c) => c.method === "POST")).toEqual([]);

    await settleOn(image.id, second, "ready", { baseVersion: "1.1.0", diskBytes: 3_000 });
    expect(await rowOf(image.id)).toMatchObject({ digestReference: second, candidateReference: null, state: "ready", baseVersion: "1.1.0" });
    expect(lastSyncImage(lab)).toBe(second);
    expect(CourseWorkspaceImages.parse((await list(room)).json()).images[0]!.obsolete).toBe(false);
    const refreshed = (await audits("codespace.image_refreshed", room.courseId)).map((a) => (a.payload as { candidate: string | null }).candidate);
    expect(refreshed).toEqual([null, second]);
    expect((await audits("codespace.image_admitted", room.courseId)).map((a) => a.payload)).toContainEqual(
      expect.objectContaining({ digestReference: second, previous: first }),
    );

    // A refused candidate leaves the digest in service, and the project keeps running it.
    const third = digestRef("acme/clab", "9");
    portal.images.tags.set(image.tagged, third);
    await refresh(room, image.id);
    portal.calls.length = 0;
    await settleOn(image.id, third, "refused", { reason: "not_on_base" });
    expect(await rowOf(image.id)).toMatchObject({ digestReference: second, candidateReference: null, state: "refused", reason: "not_on_base" });
    expect(portal.calls.filter((c) => c.method === "PUT")).toEqual([]);
    expect((await syncPayload(server.app.db, lab))!.image).toBe(second);
    // Still ready to pick: a digest is in service.
    expect((await pick(lab, null)).statusCode).toBe(200);
    expect((await pick(lab, image.id)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- the rollout's guard and the administrator

describe("an older portal (the rollout's guard)", () => {
  it("answers 404 images_unavailable (the feature off) on the list, an add and the administrator's view; the sync keeps null", async () => {
    const room = await connected();
    const lab = await onlineProject(room, "Old portal lab");
    portal.images.base = 404;
    const admin = await server.signIn("admin", `adm-${randomUUID().slice(0, 8)}@heig.test`);
    const answers = [
      await list(room),
      await add(room, { name: "C lab", reference: "ghcr.io/acme/lab:1" }),
      await call("GET", ADMIN_WORKSPACE_IMAGES_PATH, admin.headers),
    ];
    for (const res of answers) expect([res.statusCode, res.json().error]).toEqual([404, "images_unavailable"]);
    // The default needs no image route.
    expect((await pick(lab, null)).statusCode).toBe(200);
    expect((await syncPayload(server.app.db, lab))!.image).toBeNull();
    // Cached five minutes: a portal deployed meanwhile is read again after.
    portal.images.base = fakeImages().base;
    expect((await list(room)).statusCode).toBe(404);
    server.clock.set(new Date(server.clock.now().getTime() + 6 * 60_000));
    expect((await list(room)).statusCode).toBe(200);
  });

  it("lists no base and marks nothing obsolete before the first release", async () => {
    const room = await connected();
    await readyImage(room, "C lab", "a");
    portal.images.base = 503;
    server.clock.set(new Date(server.clock.now().getTime() + 6 * 60_000));
    const read = CourseWorkspaceImages.parse((await list(room)).json());
    expect(read.base).toBeNull();
    expect(read.images[0]).toMatchObject({ state: "ready", obsolete: null });
  });
});

describe("the administrator's view (ADR-146 §8)", () => {
  it("joins the engine's store with the courses and projects naming each admission", async () => {
    const room = await connected();
    const lab = await onlineProject(room, "Admin lab");
    const image = await readyImage(room, "Admin lab image", "7");
    await pick(lab, image.id);
    const digest = portal.images.tags.get(image.tagged)!;
    const admission = { reference: digest, digest: digest.split("@")[1], source: "course", state: "ready", lastUsedAt: null, liveSessions: 0 };
    portal.images.store = [
      { id: "abc", names: [digest], diskBytes: 1_000, kind: "admitted", admissions: [admission] },
      { id: "def", names: [], diskBytes: 9, kind: "orphan", admissions: [] },
    ];
    const admin = await server.signIn("admin", `adm-${randomUUID().slice(0, 8)}@heig.test`);
    const res = await call("GET", ADMIN_WORKSPACE_IMAGES_PATH, admin.headers);
    expect(res.statusCode, res.body).toBe(200);
    const [admitted, orphan] = res.json().map((i: unknown) => AdminWorkspaceImage.parse(i));
    expect(admitted!.admissions[0]!.uses).toEqual([
      {
        course: expect.objectContaining({ id: room.courseId }),
        image: { id: image.id, name: "Admin lab image" },
        projects: [{ id: lab, name: "Admin lab" }],
      },
    ]);
    expect(orphan!.admissions).toEqual([]);

    expect((await call("GET", ADMIN_WORKSPACE_IMAGES_PATH, owner.headers)).statusCode).toBe(403);
    portal.down = true;
    const down = await call("GET", ADMIN_WORKSPACE_IMAGES_PATH, admin.headers);
    expect([down.statusCode, down.json().error]).toEqual([503, "portal_unavailable"]);
  });
});
