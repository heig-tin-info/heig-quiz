/**
 * The settings of Quiz's GitHub App (D23, merge task M2-06): what it may do,
 * what it hears and where GitHub reaches it. The ONE source of truth of the
 * App's registration: `scripts/github-app.ts` builds the manifest of GitHub's
 * App Manifest flow from it and the routes take their paths from it.
 * `docs/development/github-app.md` holds the reason of each row, kept in
 * step by hand; `manifest.test.ts` fails when its tables and this module
 * differ, or when the events differ from those a module handles.
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

interface Permission {
  access: "read" | "write";
  /** Where GitHub's settings list it. */
  on: "repository" | "organization";
}

/** Every permission the App asks for, by the manifest's name (`metadata` is GitHub's mandatory baseline). */
export const APP_PERMISSIONS = {
  actions: { access: "read", on: "repository" },
  administration: { access: "write", on: "repository" },
  checks: { access: "read", on: "repository" },
  contents: { access: "write", on: "repository" },
  metadata: { access: "read", on: "repository" },
  pull_requests: { access: "write", on: "repository" },
  workflows: { access: "write", on: "repository" },
  members: { access: "read", on: "organization" },
  organization_plan: { access: "read", on: "organization" },
  organization_secrets: { access: "read", on: "organization" },
} as const satisfies Record<string, Permission>;

/** The events the App subscribes to. */
export const APP_EVENTS = ["push", "workflow_run", "pull_request", "member", "repository", "organization"] as const;

/** Delivered to every App without a subscription (GitHub refuses them in a manifest). */
export const ALWAYS_DELIVERED = ["installation", "installation_repositories"] as const;

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
    default_events: [...APP_EVENTS],
  };
}

type GithubVariable = Extract<keyof AppConfig, `GITHUB_${string}`>;

/**
 * The environment's `GITHUB_*` lines (config.ts) from GitHub's conversion
 * of the manifest, the key named by its path ON THE SERVER, relative to the
 * app's directory like the edu-ID key.
 */
export function envLines(
  app: { id: number; slug?: string; client_id: string; client_secret: string; webhook_secret: string | null },
  keyPath: string,
): Record<GithubVariable, string> {
  return {
    GITHUB_APP_ID: String(app.id),
    GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    GITHUB_APP_SLUG: app.slug ?? "",
    GITHUB_WEBHOOK_SECRET: app.webhook_secret ?? "",
    GITHUB_APP_CLIENT_ID: app.client_id,
    GITHUB_APP_CLIENT_SECRET: app.client_secret,
  };
}
