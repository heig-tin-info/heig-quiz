/**
 * 8b. The new project (F-PROJ-01, M3-11): the organization's repositories a
 * project may hand out, one of them in detail, and the create. One section
 * below GitHub, whose link it reads (a classroom not connected answers
 * `409 not_connected`, an organization gone `409 app_not_installed`), and
 * one below the projects (5c), whose lists the created draft joins. Shapes:
 * `ProjectSourceRepo`, `ProjectSourceDetail` and `ProjectSummary`, checked
 * by `contract.test.ts`.
 *
 * Scene flags: `?projects=1` serves PRG1-2026's organization's repositories
 * (without it the organization has none, the form's empty source);
 * `?srcmissing=1` refuses the create `422 source_not_found` — naming the
 * branches it lacks when the body asks for more than the default one;
 * `?distfail=1` refuses it `502 distribution_failed`. A create takes 2.5 s,
 * the time GitHub takes to build the students' repository, so the form's
 * building state is seen.
 */
import {
  PROTECTED_FILE_SUGGESTIONS,
  type ProjectCreate,
  type ProjectSourceDetail,
  type ProjectSourceRepo,
  type ProjectSummary,
} from "@quiz/contracts";

import { mockClassroomOrg } from "./github";
import { courses, rooms } from "./org";
import { addMockProject } from "./project";
import { D, flags, H, iso, MockError, MockPayload, nextId, now, on, role } from "./runtime";

/** How long the mock's GitHub takes to build a distribution repository. */
const BUILD_MS = 2500;

/** A repository of the organization: its listing, its branches and its tree. */
interface MockSource {
  repo: ProjectSourceRepo;
  branches: string[];
  files: string[];
}

const C_LAB = (topic: string) => [
  "README.md",
  "Makefile",
  "criteria.yml",
  ".github/workflows/grading.yml",
  `src/${topic}.c`,
  `src/${topic}.h`,
  `tests/test_${topic}.c`,
  "student/README.md",
];

/** The organization's repositories, the most recently pushed first, as GitHub lists them. */
const SOURCES: MockSource[] = [
  {
    repo: { name: "prg1-labo-04-arbres", defaultBranch: "main", private: true, pushedAt: iso(-2 * H) },
    branches: ["main", "solution", "tests-etendus"],
    files: C_LAB("arbre"),
  },
  {
    repo: { name: "prg1-labo-03-listes", defaultBranch: "main", private: true, pushedAt: iso(-1 * D) },
    branches: ["main", "solution"],
    files: C_LAB("liste"),
  },
  {
    repo: { name: "prg1-labo-02-pointeurs", defaultBranch: "main", private: true, pushedAt: iso(-8 * D) },
    branches: ["main"],
    files: C_LAB("pointeurs"),
  },
  {
    repo: { name: "prg1-exercices-libres", defaultBranch: "master", private: false, pushedAt: iso(-40 * D) },
    branches: ["master"],
    files: ["README.md", "exercices/01.c", "exercices/02.c"],
  },
];

/** A classroom of the staff persona with its organization, or the refusal the API answers. */
function connectedRoom(id: string) {
  const room = rooms.find((r) => r.id === id);
  if (role === "student" || !room) throw new MockError(404, "Not found");
  const org = mockClassroomOrg(id);
  if (!org) throw new MockPayload(409, { error: "not_connected", message: "The classroom is not connected" });
  if (!org.installed || org.status !== "active") {
    throw new MockPayload(409, { error: "app_not_installed", message: "The App is not installed" });
  }
  return { room, org };
}

/** The repositories of a classroom's organization: PRG1-2026's under `?projects=1`. */
const sourcesOf = (id: string): MockSource[] => (flags.projects && id === "r1" ? SOURCES : []);

on("GET", "/app/api/classrooms/:id/projects/sources", (m): ProjectSourceRepo[] => {
  const id = m.groups!.id!;
  connectedRoom(id);
  return sourcesOf(id).map((s) => s.repo);
});

on("GET", "/app/api/classrooms/:id/projects/sources/:repo", (m): ProjectSourceDetail => {
  const id = m.groups!.id!;
  connectedRoom(id);
  const source = sourcesOf(id).find((s) => s.repo.name === decodeURIComponent(m.groups!.repo!));
  if (!source) throw new MockError(404, "Not found");
  const dirs = [...new Set(source.files.flatMap((f) => f.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))))];
  return {
    name: source.repo.name,
    defaultBranch: source.repo.defaultBranch,
    branches: source.branches,
    tree: [
      ...dirs.map((path) => ({ path, type: "tree" as const })),
      ...source.files.map((path) => ({ path, type: "blob" as const })),
    ].sort((a, b) => a.path.localeCompare(b.path)),
    truncated: false,
    suggestedProtected: PROTECTED_FILE_SUGGESTIONS.filter((p) => source.files.includes(p)),
  };
});

on("POST", "/app/api/classrooms/:id/projects", async (m, raw): Promise<ProjectSummary> => {
  const id = m.groups!.id!;
  const { room, org } = connectedRoom(id);
  const body = raw as unknown as ProjectCreate;
  const source = sourcesOf(id).find((s) => s.repo.name === body.sourceRepo);
  const branches = body.branches ?? (source ? [source.repo.defaultBranch] : []);
  const deadline =
    body.durationMinutes !== undefined ? now + body.durationMinutes * 60_000 : Date.parse(body.deadlineAt ?? "");
  if (!(deadline > Date.now())) {
    throw new MockPayload(422, { error: "deadline_past", message: "The deadline has passed" });
  }
  if (flags.srcmissing || !source) {
    const extra = branches.filter((b) => b !== source?.repo.defaultBranch);
    throw new MockPayload(422, {
      error: "source_not_found",
      message: "The source repository was not found",
      ...(source && extra.length > 0 ? { branches: extra } : {}),
    });
  }
  await new Promise((resolve) => setTimeout(resolve, BUILD_MS));
  if (flags.distfail) {
    throw new MockPayload(502, { error: "distribution_failed", message: "Building the distribution repository failed: try again" });
  }
  const start = body.publishMode === "scheduled" && body.startAt ? body.startAt : iso(0);
  const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const project: ProjectSummary = {
    id: nextId("pj-"),
    classroomId: id,
    name: body.name,
    slug,
    state: "draft",
    publishMode: body.publishMode,
    startAt: start,
    deadlineAt: new Date(deadline).toISOString(),
    durationMinutes: body.durationMinutes ?? null,
    graceMinutes: body.graceMinutes,
    sourceStrategy: body.sourceStrategy,
    deadlineStrategy: body.deadlineStrategy,
    gradingMode: body.gradingMode,
    gradingScale: { kind: body.gradingScale?.kind ?? "linear", rounding: body.gradingScale?.rounding ?? "nearest" },
    branches,
    protectedFiles: body.protectedFiles,
    groupMode: body.groupMode,
    groupMaxSize: body.groupMaxSize ?? null,
    source: { fullName: `${org.login}/${source.repo.name}` },
    distribution: { fullName: `${org.login}/${slug}-squashed` },
    deadlineAppliedAt: null,
    archivedAt: null,
    createdAt: iso(0),
    accepted: false,
    editable: [],
  };
  const course = courses.find((c) => c.id === room.courseId);
  addMockProject({
    kind: "project",
    id: project.id,
    title: project.name,
    state: "draft",
    classroom: { id, name: room.name, courseCode: course?.code ?? "" },
    startAt: project.startAt,
    deadlineAt: project.deadlineAt,
  });
  return project;
});
