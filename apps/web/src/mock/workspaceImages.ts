/**
 * A course's workspace images (ADR-146 §4–§8), with the online workspace
 * (`?codespace=1`; without it every route here answers 404, as the API does).
 *
 * PRG1 holds four images: one ready, which "Labo 2 — pointeurs" runs; one
 * whose admission is in flight (Checking…, for good, so a screenshot finds
 * it there); one whose Refresh the portal refused while its previous digest
 * keeps running, its diagnostic quoted; and one ready on an older
 * `quiz-base`, obsolete. Every other course holds none; `?empty=1` empties
 * PRG1's too. An image added or refreshed here downloads for a few seconds,
 * checks for a few more, then is ready — the tab's polling shows it move. A
 * reference naming `private` is refused `422 not_public`. `?assistant=1`
 * makes the persona an assistant, who reads.
 *
 * The administrator's view of the engine's store lists the default, an older
 * base, the admitted images and an orphan.
 */
import {
  COURSE_WORKSPACE_IMAGES_MAX,
  CourseWorkspaceImageCreate,
  CourseWorkspaceImagePatch,
  type AdminWorkspaceImage,
  type CourseWorkspaceImage,
  type CourseWorkspaceImages,
} from "@quiz/contracts";

import { imageObsolete } from "@quiz/domain";

import { courseOr404, myRoleOn } from "./org";
import { mockProjectName } from "./project";
import { D, flags, H, iso, MockError, MockPayload, on, refuse } from "./runtime";

/** The current `quiz-base` release (ADR-146 §3). */
const BASE = {
  reference: `ghcr.io/heig-tin-info/quiz-base@sha256:${"4b1e".repeat(16)}`,
  version: "1.1.0",
};

/** Which image each project runs; a project absent runs the default. */
const PROJECT_IMAGES = new Map<string, string>([["pj-published", "1a6e0000-0000-4000-8000-000000000001"]]);

interface MockImage extends Omit<CourseWorkspaceImage, "projects" | "obsolete"> {
  /** When the admission in flight started: it moves on by itself. Null: it stays where it is. */
  startedAt: number | null;
}

const digest = (seed: string) => `sha256:${seed.repeat(64 / seed.length)}`;

const image = (over: Partial<MockImage> & Pick<MockImage, "id" | "name" | "reference">): MockImage => ({
  digestReference: null,
  state: "ready",
  reason: null,
  detail: null,
  baseVersion: BASE.version,
  diskBytes: null,
  createdAt: iso(-20 * D),
  updatedAt: iso(-2 * D),
  startedAt: null,
  ...over,
});

const PRG1: MockImage[] = [
  image({
    id: "1a6e0000-0000-4000-8000-000000000001",
    name: "C avec Baygon 0.10",
    reference: "ghcr.io/heig-tin-info/prog-c-baygon:0.10",
    digestReference: `ghcr.io/heig-tin-info/prog-c-baygon@${digest("a3")}`,
    diskBytes: 1_240_000_000,
  }),
  image({
    id: "1a6e0000-0000-4000-8000-000000000002",
    name: "Go 1.24",
    reference: "ghcr.io/heig-tin-info/prog-go:latest",
    state: "checking",
    baseVersion: null,
    createdAt: iso(-2 * 60_000),
    updatedAt: iso(-60_000),
  }),
  image({
    id: "1a6e0000-0000-4000-8000-000000000003",
    name: "Rust (essai)",
    reference: "docker.io/ycrc/prog-rust:latest",
    digestReference: `docker.io/ycrc/prog-rust@${digest("7c")}`,
    state: "refused",
    reason: "contract_failed",
    detail: 'FAIL the machine settings do not protect the platform: task.allowAutomaticTasks is "on", not "off"',
    diskBytes: 2_310_000_000,
    updatedAt: iso(-3 * H),
  }),
  image({
    id: "1a6e0000-0000-4000-8000-000000000004",
    name: "Python 3.12",
    reference: "ghcr.io/heig-tin-info/prog-python:2026",
    digestReference: `ghcr.io/heig-tin-info/prog-python@${digest("e5")}`,
    baseVersion: "1.0.0",
    diskBytes: 980_000_000,
    createdAt: iso(-60 * D),
    updatedAt: iso(-40 * D),
  }),
];

const IMAGES: Record<string, MockImage[]> = { c1: flags.empty ? [] : PRG1 };

/** How long a new admission downloads, then checks, in the mock. */
const STEP_MS = 6_000;

/** An admission in flight moves on with the time: downloading, checking, then ready. */
function advance(img: MockImage): MockImage {
  if (img.startedAt === null) return img;
  const elapsed = Date.now() - img.startedAt;
  if (elapsed < STEP_MS) return img;
  if (elapsed < 2 * STEP_MS) {
    img.state = "checking";
    return img;
  }
  img.state = "ready";
  img.startedAt = null;
  img.digestReference = `${img.reference.replace(/:[^:/@]+$/, "")}@${digest("d0")}`;
  img.baseVersion = BASE.version;
  img.diskBytes = 1_050_000_000;
  img.updatedAt = new Date().toISOString();
  return img;
}

const imagesOf = (courseId: string): MockImage[] => {
  if (!flags.codespace) throw new MockError(404, "Not found");
  return (IMAGES[courseOr404(courseId).id] ??= []);
};

const usersOf = (imageId: string) =>
  [...PROJECT_IMAGES].filter(([, id]) => id === imageId).map(([projectId]) => ({ id: projectId, name: mockProjectName(projectId) }));

const asRead = (img: MockImage): CourseWorkspaceImage => {
  const { startedAt: _, ...rest } = advance(img);
  return { ...rest, obsolete: imageObsolete(rest.baseVersion, BASE.version), projects: usersOf(img.id) };
};

/** The writes are an owner's with the grant: the persona, unless `?assistant=1`. */
const manager = (courseId: string) => {
  if (myRoleOn(courseId) !== "owner") throw refuse(403, "owner_required", "Only an owner of this course may do that");
};

const imageOr404 = (m: RegExpMatchArray): MockImage => {
  const found = imagesOf(m.groups!.id!).find((i) => i.id === m.groups!.imageId);
  if (!found) throw new MockError(404, "Not found");
  return found;
};

on("GET", "/app/api/courses/:id/workspace-images", (m): CourseWorkspaceImages => {
  const images = imagesOf(m.groups!.id!);
  return {
    images: images.map(asRead),
    base: BASE,
    canManage: myRoleOn(m.groups!.id!) === "owner",
    max: COURSE_WORKSPACE_IMAGES_MAX,
  };
});

on("POST", "/app/api/courses/:id/workspace-images", (m, raw): CourseWorkspaceImage => {
  const courseId = m.groups!.id!;
  const images = imagesOf(courseId);
  manager(courseId);
  const body = CourseWorkspaceImageCreate.safeParse(raw);
  if (!body.success) throw new MockPayload(400, { error: "validation", message: body.error.message });
  if (images.length >= COURSE_WORKSPACE_IMAGES_MAX) throw refuse(409, "too_many_images", "too many images");
  if (images.some((i) => i.name.toLowerCase() === body.data.name.toLowerCase())) throw refuse(409, "name_taken", "name taken");
  if (body.data.reference.includes("private")) {
    throw refuse(422, "not_public", "The workspace portal refused the image", { detail: "401 Unauthorized: anonymous token refused" });
  }
  const created = image({
    id: crypto.randomUUID(),
    name: body.data.name,
    reference: body.data.reference,
    state: "downloading",
    baseVersion: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: Date.now(),
  });
  images.push(created);
  return asRead(created);
});

on("PATCH", "/app/api/courses/:id/workspace-images/:imageId", (m, raw): CourseWorkspaceImage => {
  const img = imageOr404(m);
  manager(m.groups!.id!);
  const body = CourseWorkspaceImagePatch.safeParse(raw);
  if (!body.success) throw new MockPayload(400, { error: "validation", message: body.error.message });
  const taken = imagesOf(m.groups!.id!).some((i) => i.id !== img.id && i.name.toLowerCase() === body.data.name.toLowerCase());
  if (taken) throw refuse(409, "name_taken", "name taken");
  img.name = body.data.name;
  return asRead(img);
});

on("POST", "/app/api/courses/:id/workspace-images/:imageId/refresh", (m): CourseWorkspaceImage => {
  const img = imageOr404(m);
  manager(m.groups!.id!);
  Object.assign(img, { state: "downloading", reason: null, detail: null, startedAt: Date.now(), updatedAt: new Date().toISOString() });
  return asRead(img);
});

on("DELETE", "/app/api/courses/:id/workspace-images/:imageId", (m) => {
  const img = imageOr404(m);
  manager(m.groups!.id!);
  const projects = usersOf(img.id);
  if (projects.length > 0) throw refuse(409, "image_in_use", "A project of this course runs this image", { projects });
  const images = imagesOf(m.groups!.id!);
  images.splice(images.indexOf(img), 1);
  return undefined;
});

/** The image a project runs, as its workspace names it (`mock/codespace.ts`); null for the default. */
export function mockProjectImage(projectId: string): { id: string; name: string } | null {
  const id = PROJECT_IMAGES.get(projectId);
  const img = id ? Object.values(IMAGES).flat().find((i) => i.id === id) : undefined;
  return img ? { id: img.id, name: img.name } : null;
}

/** A project's choice (`PUT /projects/:id/workspace/image`): an image with a digest in service, or null. */
export function setMockProjectImage(projectId: string, imageId: string | null): void {
  if (imageId === null) {
    PROJECT_IMAGES.delete(projectId);
    return;
  }
  const img = Object.values(IMAGES).flat().find((i) => i.id === imageId);
  if (!img) throw new MockError(404, "Not found");
  if (advance(img).digestReference === null) throw refuse(409, "image_not_ready", "This image is not admitted yet");
  PROJECT_IMAGES.set(projectId, imageId);
}

// --- The administrator's view of the engine's store (ADR-146 §8) -------------------

const PRG1_COURSE = { id: "c1", name: "Programmation C", code: "PRG1" };

on("GET", "/app/api/admin/workspace-images", (): AdminWorkspaceImage[] => {
  if (!flags.codespace) throw new MockError(404, "Not found");
  const admission = (reference: string, source: "default" | "course", lastUsed: number | null, liveSessions = 0) => ({
    reference,
    digest: reference.slice(reference.indexOf("@") + 1),
    source,
    state: "ready" as const,
    lastUsedAt: lastUsed === null ? null : iso(-lastUsed),
    liveSessions,
  });
  const courseImage = (img: MockImage) => ({
    course: PRG1_COURSE,
    image: { id: img.id, name: img.name },
    projects: usersOf(img.id),
  });
  return [
    {
      id: "4b1e0c2a9f31",
      names: ["ghcr.io/heig-tin-info/quiz-base:1.1.0", BASE.reference],
      diskBytes: 1_020_000_000,
      kind: "default",
      admissions: [{ ...admission(BASE.reference, "default", 4 * 60_000, 12), uses: [] }],
    },
    {
      id: "9d27e61b0a44",
      names: ["ghcr.io/heig-tin-info/quiz-base:1.0.0"],
      diskBytes: 1_010_000_000,
      kind: "base",
      admissions: [],
    },
    ...PRG1.filter((img) => img.digestReference !== null).map((img, i) => ({
      id: `c0ffee0${i}a1b2`,
      names: [img.digestReference!],
      diskBytes: img.diskBytes,
      kind: "admitted" as const,
      admissions: [{ ...admission(img.digestReference!, "course", i === 0 ? 20 * 60_000 : 6 * D, i === 0 ? 3 : 0), uses: [courseImage(img)] }],
    })),
    {
      id: "0bad0f00d123",
      names: [`docker.io/ycrc/prog-rust@${digest("51")}`],
      diskBytes: 2_290_000_000,
      kind: "orphan",
      admissions: [],
    },
  ];
});
