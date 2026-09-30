/**
 * The `github` module's payloads (spec 02 F-GH-01 to F-GH-05, spec 05 §5.11,
 * docs/merge/03-github-projects.md §3.3, docs/merge/05-web.md §5.3). Written
 * by merge task M2-01; served by M2-02 (organizations, a classroom's link)
 * and M2-03 (the user's account link), read by M2-07 (the classroom's
 * Settings, the user Settings card).
 *
 * Every status and check value is a closed enum: the web app words each one
 * through `t()` (invariant 1), the API never sends a sentence.
 *
 * No payload here carries a token, a secret, or an address the browser would
 * load from github.com: an organization's avatar is a same-origin URL
 * (M2-02 serves it), so a viewer's IP never reaches GitHub.
 */
import { z } from "zod";

// ---------------------------------------------------------- organizations

/**
 * What Quiz knows of an organization's installation of its App (D23):
 *   - `installed` — the App is installed and active;
 *   - `suspended` — installed, but suspended by the organization's owner;
 *   - `uninstalled` — known to Quiz (a link, an import, a past installation)
 *     without an installation of Quiz's App, including a staging copy whose
 *     installation ids were cleared (N-SEC-18);
 *   - `deleted` — the organization no longer exists on GitHub.
 * An installation id is held exactly when the status is `installed` or
 * `suspended` (a CHECK of `github_organizations`).
 */
export const GITHUB_ORG_STATUSES = ["installed", "suspended", "uninstalled", "deleted"] as const;
export const GithubOrgStatus = z.enum(GITHUB_ORG_STATUSES);
export type GithubOrgStatus = z.infer<typeof GithubOrgStatus>;

/** A same-origin address (`/app/api/...`): never an absolute URL, never github.com. */
const SameOriginUrl = z.string().regex(/^\/(?!\/)/, "a same-origin path");

/** An organization known to Quiz's App: an entry of the picker, the connected one. */
export const GithubOrg = z.object({
  id: z.uuid(),
  login: z.string().min(1),
  /** Served by the API itself (M2-02); null ⇒ the web draws the initials (`OrgAvatar`). */
  avatarUrl: SameOriginUrl.nullable(),
  status: GithubOrgStatus,
  /** GitHub's billing plan (`free`, `team`, ...); null while unread. */
  plan: z.string().nullable(),
});
export type GithubOrg = z.infer<typeof GithubOrg>;

// ---------------------------------------------------------- a classroom's link

/**
 * The installation check, the only blocking one (F-GH-03): the App installed
 * with access to every repository.
 *   - `ok` — installed, active, "All repositories";
 *   - `not_installed` — the organization has no installation of Quiz's App;
 *   - `suspended` — installed but suspended;
 *   - `selected_repositories` — installed on a selection only;
 *   - `org_deleted` — the organization is gone from GitHub.
 */
export const GITHUB_APP_CHECK_STATES = [
  "ok",
  "not_installed",
  "suspended",
  "selected_repositories",
  "org_deleted",
] as const;
export const GithubAppCheck = z.enum(GITHUB_APP_CHECK_STATES);
export type GithubAppCheck = z.infer<typeof GithubAppCheck>;

/**
 * The plan check, a warning at most: on `free`, no rulesets and no
 * organization secrets for private repositories. `unknown` when GitHub did
 * not answer.
 */
export const GITHUB_PLAN_CHECK_STATES = ["ok", "free", "unknown"] as const;
export const GithubPlanCheck = z.enum(GITHUB_PLAN_CHECK_STATES);
export type GithubPlanCheck = z.infer<typeof GithubPlanCheck>;

/**
 * The `ANTHROPIC_API_KEY` organization secret, for the LLM review of
 * projects: `unknown` when the App cannot read the organization's secrets.
 */
export const GITHUB_SECRET_CHECK_STATES = ["present", "missing", "unknown"] as const;
export const GithubSecretCheck = z.enum(GITHUB_SECRET_CHECK_STATES);
export type GithubSecretCheck = z.infer<typeof GithubSecretCheck>;

/** The checks of a connected classroom (F-GH-03), re-read when its Settings open. */
export const GithubChecks = z.object({
  app: GithubAppCheck,
  plan: GithubPlanCheck,
  llmSecret: GithubSecretCheck,
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

/** `PUT /app/api/classrooms/:id/github`: connect the classroom to an organization Quiz knows. */
export const GithubConnectBody = z.strictObject({
  orgId: z.uuid(),
});
export type GithubConnectBody = z.infer<typeof GithubConnectBody>;

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

/**
 * How the account-linking round trip ended, as `/app/auth/github/callback`
 * returns it to the page it started from (`?github=<outcome>`, F-GH-05):
 * linked, the GitHub account already linked to another user, or failed.
 */
export const GITHUB_LINK_OUTCOMES = ["linked", "conflict", "error"] as const;
export const GithubLinkOutcome = z.enum(GITHUB_LINK_OUTCOMES);
export type GithubLinkOutcome = z.infer<typeof GithubLinkOutcome>;
