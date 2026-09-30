/**
 * 8. GitHub (F-GH-01 to F-GH-05; M1-05, for the screens of M2-07): the
 * organizations where Quiz's App is installed, a classroom's link to one of
 * them with its checks, and the persona's own account link. Shapes: the
 * `github` contracts (M2-01), checked by `contract.test.ts`.
 *
 * By default the classroom PRG1-2026 (`r1`) is connected to the course's
 * organization, every check green; the other classrooms are plain Quiz
 * classrooms (a link of `null`), and those of the same course are offered
 * that organization first. No avatar URL: an organization is drawn by its
 * initials (`OrgAvatar`, M1-04) until the API serves a same-origin one.
 *
 * Scene flag `?unlinked=1` (`flags.unlinked`): the persona has no linked
 * GitHub account (`GET /app/api/me/github`).
 */
import type { GithubAccountState, GithubClassroom, GithubClassroomLink, GithubOrg } from "@quiz/contracts";

import { rooms } from "./org";
import { D, flags, iso, MockError, on, role } from "./runtime";

const ORGS: GithubOrg[] = [
  {
    id: "0190d3c4-0000-7000-8000-00000000a001",
    login: "heig-tin-info",
    avatarUrl: null,
    status: "installed",
    plan: "team",
  },
  {
    id: "0190d3c4-0000-7000-8000-00000000a002",
    login: "heig-emb-lab",
    avatarUrl: null,
    status: "installed",
    plan: "free",
  },
];

/** The classrooms connected by default: PRG1-2026 only. */
const LINKS: Record<string, GithubClassroomLink> = {
  r1: {
    org: ORGS[0]!,
    linkedAt: iso(-20 * D),
    checks: { app: "ok", plan: "ok", llmSecret: "present" },
  },
};

const INSTALL_URL = "https://github.com/apps/heig-quiz/installations/new";

on("GET", "/app/api/github/orgs", () => {
  if (role === "student") throw new MockError(403, "Forbidden");
  return ORGS;
});

on("GET", "/app/api/classrooms/:id/github", (m): GithubClassroom => {
  const id = m.groups!.id!;
  const room = rooms.find((r) => r.id === id);
  if (role === "student" || !room) throw new MockError(404, "Not found");
  const sibling = rooms.find((r) => r.courseId === room.courseId && r.id !== id && LINKS[r.id]);
  return {
    link: LINKS[id] ?? null,
    suggestedOrgId: sibling ? LINKS[sibling.id]!.org.id : null,
    installUrl: `${INSTALL_URL}?state=${id}`,
  };
});

on("GET", "/app/api/me/github", (): GithubAccountState => ({
  account: flags.unlinked
    ? null
    : { login: role === "student" ? "alice-dupont" : "ychevallier", linkedAt: iso(-60 * D) },
  // F-GH-05: staff of a connected classroom; a student before any project is not.
  relevant: role !== "student",
}));
