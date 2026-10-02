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
 * A connect (PUT) and a disconnect (DELETE) change the link for the page's
 * life, as the API would; a disconnect of a classroom (or a connect elsewhere)
 * while it has a GitHub-mode journal (`?journalgithub=1`, or one set from its Settings) is
 * refused `409 journal_attached` (D28).
 *
 * Scene flags: `?unlinked=1` (`flags.unlinked`), the persona has no linked
 * GitHub account (`GET /app/api/me/github`); `?ghwarn=1`, PRG1-2026's
 * organization is on the free plan and has no LLM secret; `?ghmissing=1`,
 * that organization no longer exists on GitHub.
 */
import type {
  GithubAccountState,
  GithubClassroom,
  GithubClassroomLink,
  GithubConnectBody,
  GithubOrg,
} from "@quiz/contracts";

import { hasMockGithubJournal } from "./journal";
import { rooms } from "./org";
import { D, flags, iso, MockError, MockPayload, on, role } from "./runtime";

const ORGS: GithubOrg[] = [
  {
    id: "0190d3c4-0000-7000-8000-00000000a001",
    login: "heig-tin-info",
    avatarUrl: null,
    installed: true,
    status: "active",
    plan: "team",
  },
  {
    id: "0190d3c4-0000-7000-8000-00000000a002",
    login: "heig-emb-lab",
    avatarUrl: null,
    installed: true,
    status: "active",
    plan: "free",
  },
];

/** PRG1-2026's organization as the scene flags draw it. */
const linkedOrg = (): GithubOrg =>
  flags.ghmissing
    ? { ...ORGS[0]!, installed: false, status: "deleted" }
    : flags.ghwarn
      ? { ...ORGS[0]!, plan: "free" }
      : ORGS[0]!;

/** The classrooms connected by default: PRG1-2026 only. */
const LINKS: Record<string, GithubClassroomLink> = {
  r1: {
    org: linkedOrg(),
    linkedAt: iso(-20 * D),
    checks: flags.ghmissing
      ? { allRepositories: null, llmSecret: "unknown" }
      : { allRepositories: true, llmSecret: flags.ghwarn ? "missing" : "present" },
  },
};

/** The organization a classroom is connected to, null when it is not (`projectNew.ts`). */
export const mockClassroomOrg = (id: string): GithubOrg | null => LINKS[id]?.org ?? null;

const INSTALL_URL = "https://github.com/apps/heig-quiz/installations/new";

on("GET", "/app/api/github/orgs", () => {
  if (role === "student") throw new MockError(403, "Forbidden");
  return ORGS;
});

/** A classroom of the staff persona, or the 404 the API answers off the staff. */
function staffRoom(id: string) {
  const room = rooms.find((r) => r.id === id);
  if (role === "student" || !room) throw new MockError(404, "Not found");
  return room;
}

function classroomGithub(id: string): GithubClassroom {
  const room = staffRoom(id);
  const sibling = rooms.find((r) => r.courseId === room.courseId && r.id !== id && LINKS[r.id]);
  return {
    link: LINKS[id] ?? null,
    suggestedOrgId: sibling ? LINKS[sibling.id]!.org.id : null,
    installUrl: `${INSTALL_URL}?state=${id}`,
  };
}

on("GET", "/app/api/classrooms/:id/github", (m) => classroomGithub(m.groups!.id!));

on("PUT", "/app/api/classrooms/:id/github", (m, body) => {
  const id = m.groups!.id!;
  staffRoom(id);
  const org = ORGS.find((o) => o.id === (body as GithubConnectBody).orgId);
  if (!org?.installed || org.status !== "active") {
    throw new MockPayload(409, { error: "app_not_installed" });
  }
  if (hasMockGithubJournal(id) && LINKS[id]?.org.id !== org.id) {
    throw new MockPayload(409, { error: "journal_attached" });
  }
  LINKS[id] = {
    org,
    linkedAt: iso(0),
    checks: { allRepositories: true, llmSecret: org.plan === "free" ? "unknown" : "present" },
  };
  return classroomGithub(id);
});

on("DELETE", "/app/api/classrooms/:id/github", (m) => {
  const id = m.groups!.id!;
  staffRoom(id);
  if (hasMockGithubJournal(id)) throw new MockPayload(409, { error: "journal_attached" });
  delete LINKS[id];
  return undefined;
});

let account: GithubAccountState["account"] = flags.unlinked
  ? null
  : { login: role === "student" ? "alice-dupont" : "ychevallier", linkedAt: iso(-60 * D) };

on("GET", "/app/api/me/github", (): GithubAccountState => ({
  account,
  // F-GH-05: staff of a connected classroom, or a seat in one; every mock
  // persona is one or the other (the student sits in PRG1-2026).
  relevant: true,
}));

on("DELETE", "/app/api/me/github", () => {
  account = null;
  return undefined;
});
