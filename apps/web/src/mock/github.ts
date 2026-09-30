/**
 * 8. GitHub (F-GH-01 to F-GH-03; M1-05, for the screens of M2-07): the
 * organizations where Quiz's App is installed, and a classroom's link to one
 * of them with its checks.
 *
 * By default the classroom PRG1-2026 (`r1`) is connected to the course's
 * organization, every check green; the other classrooms are plain Quiz
 * classrooms (a link of `null`). No avatar URL: an organization is drawn by
 * its initials (`OrgAvatar`, M1-04) until the API serves a same-origin one.
 *
 * Scene flag `?unlinked=1` (`flags.unlinked`): the persona has no linked
 * GitHub account. Declared here for the account's route, which M2-01 places
 * (F-GH-05) and this file then serves under the flag.
 */
import { rooms } from "./org";
import { D, iso, MockError, on, role } from "./runtime";

/*
 * TODO(M2-01): replace these local shapes with the `github` contracts
 * (`packages/contracts/src/github.ts`) once M2-01 writes them, and move the
 * routes below from `UNCHECKED` to `CHECKED` in `contract.test.ts`. Nothing
 * outside this file may import them.
 */
interface GithubOrg {
  login: string;
  name: string | null;
}
interface GithubClassroomLink {
  org: GithubOrg;
  /** TODO(M2-01): the checks of F-GH-03, minimal until their contract exists. */
  checks: { code: string; state: "ok" | "warning" | "error" | "unknown" }[];
  connectedAt: string;
}

const ORGS: GithubOrg[] = [
  { login: "heig-tin-info", name: "HEIG-VD TIN Informatique" },
  { login: "heig-emb-lab", name: "HEIG-VD Embedded" },
];

/** The classrooms connected by default: PRG1-2026 only. */
const LINKS: Record<string, GithubClassroomLink> = {
  r1: {
    org: ORGS[0]!,
    checks: [
      { code: "app_access", state: "ok" },
      { code: "plan", state: "ok" },
      { code: "anthropic_secret", state: "ok" },
    ],
    connectedAt: iso(-20 * D),
  },
};

on("GET", "/app/api/github/orgs", () => {
  if (role === "student") throw new MockError(403, "Forbidden");
  return ORGS;
});

on("GET", "/app/api/classrooms/:id/github", (m) => {
  const id = m.groups!.id!;
  if (role === "student" || !rooms.some((r) => r.id === id)) throw new MockError(404, "Not found");
  return LINKS[id] ?? null;
});
