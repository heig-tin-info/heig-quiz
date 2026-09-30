/**
 * 8. GitHub (F-GH-01 to F-GH-05; M1-05, for the screens of M2-07): the
 * organizations where Quiz's App is installed, a classroom's link to one of
 * them with its checks, and the persona's own linked GitHub account.
 *
 * By default the classroom PRG1-2026 (`r1`) is connected to the course's
 * organization, every check green, and the persona's account is linked; the
 * other classrooms are plain Quiz classrooms (a link of `null`).
 *
 * Scene flag `?unlinked=1`: the persona has no linked GitHub account — the
 * "Link my GitHub account" states of the settings card and of a project row.
 */
import { rooms } from "./org";
import { D, flags, iso, MockError, on, role } from "./runtime";

/*
 * TODO(M2-01): replace these local shapes with the `github` contracts
 * (`packages/contracts/src/github.ts`) once M2-01 writes them, and move the
 * routes below from `UNCHECKED` to `CHECKED` in `contract.test.ts`. The
 * route of the persona's own account is a guess of this skeleton: M2-01
 * settles where the link is read (`/me` or a route of its own), and this file
 * follows. Nothing outside this file may import these types.
 */
interface GithubOrg {
  login: string;
  name: string | null;
  avatarUrl: string;
  plan: "free" | "team" | "enterprise" | null;
}
type CheckState = "ok" | "warning" | "error" | "unknown";
interface GithubClassroomLink {
  org: GithubOrg;
  checks: { appAccess: CheckState; plan: CheckState; anthropicSecret: CheckState };
  connectedAt: string;
}
interface GithubAccount {
  login: string;
  avatarUrl: string;
  linkedAt: string;
}

const ORGS: GithubOrg[] = [
  {
    login: "heig-tin-info",
    name: "HEIG-VD TIN Informatique",
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    plan: "team",
  },
  {
    login: "heig-emb-lab",
    name: "HEIG-VD Embedded",
    avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
    plan: "free",
  },
];

/** The classrooms connected by default: PRG1-2026 only. */
const LINKS: Record<string, GithubClassroomLink> = {
  r1: {
    org: ORGS[0]!,
    checks: { appAccess: "ok", plan: "ok", anthropicSecret: "ok" },
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

on("GET", "/app/api/me/github", (): GithubAccount | null =>
  flags.unlinked
    ? null
    : {
        login: role === "student" ? "alice-dupont" : "ychevallier",
        avatarUrl: "https://avatars.githubusercontent.com/u/3?v=4",
        linkedAt: iso(-60 * D),
      },
);
