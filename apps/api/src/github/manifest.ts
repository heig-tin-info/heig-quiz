/**
 * The settings of Quiz's GitHub App (D23, merge task M2-06): what it may do,
 * what it hears and where GitHub reaches it. The ONE source of truth of the
 * App's registration: `scripts/github-app.ts` builds the manifest of GitHub's
 * App Manifest flow from it, the routes take their paths from it, and
 * `docs/development/github-app.md` is kept in step with it (both directions
 * checked by `manifest.test.ts`, which also checks that the events are
 * exactly those the modules register a handler for).
 *
 * The permissions are heig-classroom's App's plus the organization's
 * `Secrets: read` of the LLM secret probe (03 §3.4). A permission added
 * later makes every organization owner re-approve the installation: decide
 * it here, at registration.
 */
import { GITHUB_CALLBACK_PATH } from "../auth/paths.js";
import type { AppConfig } from "../config.js";

/** The App's webhook (`modules/github/routes.ts`, N-SEC-17). */
export const WEBHOOK_PATH = "/webhooks/github";
/** The App's Setup URL: GitHub's return after an install or its update (M3-14b). */
export const SETUP_PATH = "/setup/github/installed";

type Access = "read" | "write";
interface Permission {
  access: Access;
  /** Where GitHub's settings list it: on the repositories, or on the organization. */
  on: "repository" | "organization";
  /** What in Quiz needs it. */
  why: string;
}

/**
 * Every permission the App asks for, by the manifest's name. Nothing else:
 * `metadata: read` is GitHub's mandatory baseline and listed for clarity.
 */
export const APP_PERMISSIONS = {
  actions: {
    access: "read",
    on: "repository",
    why: "the grading workflow's runs (`GET …/actions/runs`): the pipeline, the reconciliation, the live state",
  },
  administration: {
    access: "write",
    on: "repository",
    why: "the students' repositories created (`POST /orgs/{org}/repos`), the rulesets `hgc-protect` and `hgc-deadline-lock`, collaborators and invitations, the archive that stands for a lock",
  },
  checks: {
    access: "read",
    on: "repository",
    why: "a run's check runs and their annotations: the score lines the grading parses",
  },
  contents: {
    access: "write",
    on: "repository",
    why: "git clone and push (provisioning, the deadline commit, protected-file reverts, the sync branches), commits and refs, the reviews' `repository_dispatch`, the journal's reads and page writes",
  },
  metadata: {
    access: "read",
    on: "repository",
    why: "GitHub's mandatory baseline: repositories by id, listings, a collaborator's permission",
  },
  pull_requests: {
    access: "write",
    on: "repository",
    why: "the source sync's pull requests (opened, commented, their state read)",
  },
  workflows: {
    access: "write",
    on: "repository",
    why: "pushing `.github/workflows/*` (the grading workflow) into the distribution, the students' repositories and the sync branches",
  },
  members: {
    access: "read",
    on: "organization",
    why: "the `member` and `organization` events (an invitation accepted, an organization renamed or deleted)",
  },
  organization_plan: {
    access: "read",
    on: "organization",
    why: "the Free-plan check (`plan` of `GET /orgs/{org}`): no organization secrets for private repositories, no rulesets",
  },
  organization_secrets: {
    access: "read",
    on: "organization",
    why: "the presence of the `ANTHROPIC_API_KEY` organization secret (the review tier's probe; until M3-14f drops it)",
  },
} as const satisfies Record<string, Permission>;

/** The events the App subscribes to, each with what handles it. */
export const APP_EVENTS = {
  push: "a student's repository (last commit, bot commits, protected files; the receipt is the intake's, ADR-012), a source repository ahead, a journal repository to ingest",
  workflow_run: "a grading run pending or completed (`ingestCompletedRun`)",
  pull_request: "the state of the sync's pull requests",
  member: "a student accepted the repository invitation",
  repository: "a repository renamed or deleted (projects, journals)",
  organization: "an organization renamed or deleted",
} as const;

/** Delivered to every App without a subscription (GitHub refuses them in a manifest). */
export const ALWAYS_DELIVERED = {
  installation: "an installation created, deleted, suspended or unsuspended: re-read from GitHub",
  installation_repositories: "the repositories the App reaches changed: the organization's healing re-runs",
} as const;

export interface ManifestOptions {
  /** The environment's public origin, `https://quiz.chevallier.io`. */
  url: string;
  name: string;
  /** Installable on any account (production: the teachers' organizations), or on its owner only. */
  public: boolean;
  /** Where GitHub sends the browser with the code to convert. */
  redirectUrl: string;
}

/** The manifest of GitHub's App Manifest flow, for one environment. */
export function appManifest(opts: ManifestOptions) {
  const at = (path: string) => new URL(path, opts.url).href;
  return {
    name: opts.name,
    url: opts.url,
    description:
      "HEIG Quiz drives the student repositories of this organization: one repository per student or group and project, " +
      "the protected files, the CI results, the lock at the deadline. Operated by HEIG-VD. Platform: " +
      opts.url,
    hook_attributes: { url: at(WEBHOOK_PATH), active: true },
    redirect_url: opts.redirectUrl,
    // The account link (F-GH-05): the App's own user-to-server OAuth.
    callback_urls: [at(GITHUB_CALLBACK_PATH)],
    // Linking stays a separate act, never a step of the install.
    request_oauth_on_install: false,
    setup_url: at(SETUP_PATH),
    // A re-configured installation returns to Quiz too (M3-14b).
    setup_on_update: true,
    public: opts.public,
    default_permissions: Object.fromEntries(Object.entries(APP_PERMISSIONS).map(([name, p]) => [name, p.access])),
    default_events: Object.keys(APP_EVENTS),
  };
}

/** What `POST /app-manifests/{code}/conversions` answers, as far as the environment needs it. */
export interface ManifestConversion {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
}

type GithubVariable = Extract<keyof AppConfig, `GITHUB_${string}`>;

/**
 * The environment's `GITHUB_*` lines (config.ts), the key named by its path
 * ON THE SERVER, relative to the app's directory like the edu-ID key.
 */
export function envLines(app: ManifestConversion, keyPath: string, webhookSecret: string): Record<GithubVariable, string> {
  return {
    GITHUB_APP_ID: String(app.id),
    GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    GITHUB_APP_SLUG: app.slug,
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    GITHUB_APP_CLIENT_ID: app.client_id,
    GITHUB_APP_CLIENT_SECRET: app.client_secret,
  };
}
