/**
 * The `github` module's payloads (spec 02 F-GH-01 to F-GH-05, spec 05 §5.11,
 * docs/merge/03-github-projects.md §3.3, docs/merge/05-web.md §5.3). Written
 * by merge task M2-01; served by M2-02 (organizations, a classroom's link)
 * and M2-03 (the user's account link), read by M2-07 (the classroom's
 * Settings, the user Settings card). The connect body belongs to M2-02 and
 * the link's return outcome to M2-03, each written with its handler.
 *
 * Every state is a closed value: the web app words it through `t()`
 * (invariant 1), the API never sends a sentence. Each fact is sent once: the
 * installation line and the plan line of the checks (F-GH-03) are derived by
 * the web from the organization itself (`installed`, `status`, `plan`).
 *
 * No payload here carries a token, a secret, or an address the browser would
 * load from github.com: an organization's avatar is served by the API itself,
 * so a viewer's IP never reaches GitHub.
 */
import { z } from "zod";

// ---------------------------------------------------------- organizations

/**
 * Whether the organization still exists on GitHub. Whether Quiz's App is
 * installed on it is another fact, `GithubOrg.installed`.
 */
export const GITHUB_ORG_STATUSES = ["active", "deleted"] as const;
export const GithubOrgStatus = z.enum(GITHUB_ORG_STATUSES);
export type GithubOrgStatus = z.infer<typeof GithubOrgStatus>;

/**
 * The one address of an organization's avatar: the API's own route (M2-02),
 * `/app/api/github/orgs/<id>/avatar`. Nothing else is accepted, so no
 * payload can make the browser load an image from elsewhere.
 */
export const GITHUB_ORG_AVATAR_PATH = /^\/app\/api\/github\/orgs\/[0-9a-f-]{36}\/avatar$/;

/** An organization known to Quiz's App: an entry of the picker, the connected one. */
export const GithubOrg = z.object({
  id: z.uuid(),
  login: z.string().min(1),
  /** Null ⇒ the web draws the initials (`OrgAvatar`). */
  avatarUrl: z.string().regex(GITHUB_ORG_AVATAR_PATH).nullable(),
  /** Quiz's App holds an installation on the organization. */
  installed: z.boolean(),
  status: GithubOrgStatus,
  /** GitHub's billing plan (`free`, `team`, ...); null while unread. */
  plan: z.string().nullable(),
});
export type GithubOrg = z.infer<typeof GithubOrg>;

// ---------------------------------------------------------- a classroom's link

/**
 * What the organization alone does not say (F-GH-03), read from GitHub when
 * the classroom's Settings open:
 *   - `allRepositories` — the installation covers every repository; null
 *     when it could not be read (not installed, GitHub silent);
 *   - `llmSecret` — the `ANTHROPIC_API_KEY` organization secret for the LLM
 *     review of projects; `unknown` when the App cannot read secrets.
 */
export const GithubChecks = z.object({
  allRepositories: z.boolean().nullable(),
  llmSecret: z.enum(["present", "missing", "unknown"]),
});
export type GithubChecks = z.infer<typeof GithubChecks>;

/** A classroom's connection to its organization (at most one, D02). */
export const GithubClassroomLink = z.object({
  org: GithubOrg,
  linkedAt: z.iso.datetime(),
  checks: GithubChecks,
});
export type GithubClassroomLink = z.infer<typeof GithubClassroomLink>;

/**
 * `GET /app/api/classrooms/:id/github` (staff, `staffAccess`): the
 * classroom's link, or null for a plain Quiz classroom, with what the
 * connect sheet needs to offer one.
 */
export const GithubClassroom = z.object({
  link: GithubClassroomLink.nullable(),
  /** The organization of the course's other classrooms, suggested first (F-GH-02); null if none. */
  suggestedOrgId: z.uuid().nullable(),
  /**
   * Where to install Quiz's App: GitHub's `installations/new` of the App,
   * `state` = this classroom, to which the setup return sends the teacher.
   * A navigation, not a resource the page loads.
   */
  installUrl: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }),
});
export type GithubClassroom = z.infer<typeof GithubClassroom>;

// ---------------------------------------------------------- the user's account

/** A user's linked GitHub account (F-GH-05): the login is followed when it changes. */
export const GithubAccount = z.object({
  login: z.string().min(1),
  linkedAt: z.iso.datetime(),
});
export type GithubAccount = z.infer<typeof GithubAccount>;

/**
 * `GET /app/api/me/github`: the caller's account link, for the user Settings
 * card. `relevant` says whether the card shows (F-GH-05: staff of a
 * connected classroom, or a user who has or had a project); a linked
 * account is shown whatever it says, so it can be unlinked.
 */
export const GithubAccountState = z.object({
  account: GithubAccount.nullable(),
  relevant: z.boolean(),
});
export type GithubAccountState = z.infer<typeof GithubAccountState>;
