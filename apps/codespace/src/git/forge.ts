/**
 * The forge the staging repository is relayed to: Forgejo with a personal
 * access token (development), or GitHub without credentials (public clone
 * URLs only, no relay). heig-classroom's App-backed GitHub forge was not
 * imported (ADR-047, M6-03 amendment).
 *
 * A `Forge` never hands out a URL with a credential in it. The token leaves
 * this module only as an `Authorization` header value, which relay.ts passes
 * to `git` through the environment — never in argv, never on disk
 * (milestone-0 P3).
 */
import type { RepoRef } from "./types.js";

export interface Forge {
  readonly kind: "forgejo" | "github";
  /** Credential-free HTTPS remote. */
  pushUrl(repo: RepoRef): string;
  /**
   * Fresh `Authorization` header value. GitHub installation tokens expire
   * after an hour, so this is called per relay attempt, not cached by the
   * caller.
   */
  authorization(repo: RepoRef): Promise<string>;
  /** Creates the repository if it does not exist yet. */
  ensureRepo(repo: RepoRef): Promise<void>;
}

export interface ForgejoOptions {
  /** e.g. `http://localhost:3300` */
  baseUrl: string;
  /** Personal access token. Stays in memory. */
  token: string;
  fetchImpl?: typeof fetch;
}

export function createForgejoForge(opts: ForgejoOptions): Forge {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const api = (path: string, init: RequestInit = {}) =>
    doFetch(`${base}/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: `token ${opts.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  return {
    kind: "forgejo",
    pushUrl: (repo) => `${base}/${repo.owner}/${repo.name}.git`,
    authorization: async () => `token ${opts.token}`,
    async ensureRepo(repo) {
      const head = await api(`/repos/${repo.owner}/${repo.name}`);
      if (head.ok) return;
      if (head.status !== 404) {
        throw new Error(`forgejo: GET /repos answered ${head.status}`);
      }
      // `/user/repos` creates under the token's owner; `/orgs/<o>/repos`
      // under an organisation. Try the first, fall back to the second.
      const body = JSON.stringify({ name: repo.name, private: true, auto_init: false });
      let created = await api("/user/repos", { method: "POST", body });
      if (!created.ok && created.status !== 409) {
        created = await api(`/orgs/${repo.owner}/repos`, { method: "POST", body });
      }
      if (!created.ok && created.status !== 409) {
        throw new Error(
          `forgejo: creation of ${repo.owner}/${repo.name} refused (${created.status})`,
        );
      }
    },
  };
}

/**
 * A relay **configuration** error, as opposed to a forge outage. `relay.ts`
 * tells them apart: a forge that is down eventually exhausts the attempt
 * budget and the row turns `failed`; a forge that is not configured is not an
 * outage, the row must stay `pending` until a forge is configured, and the
 * relay will resume on its own.
 */
export class ForgeUnconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeUnconfiguredError";
  }
}

/**
 * GitHub **without** App credentials, the only GitHub forge this portal has
 * (ADR-047, M6-03 amendment): everything that does not need a token works
 * (the clone URL of a public repository, from which the staging repository
 * bootstraps in lab-work mode), and the relay refuses explicitly.
 *
 * The portal starts, sessions open, the `PushEvent`s are written (invariant
 * 10 of this app's CLAUDE.md) and stay `pending` with the message below in
 * `last_error`. Nothing is lost. Bootstrapping a staging repository from a
 * private repository does not work: the session is refused with a named
 * cause rather than opened on an empty workspace.
 *
 * heig-classroom's App-backed forge was not imported: `loadConfig` refuses
 * any GitHub App credential (root invariant 15), and whether Quiz's own App
 * reaches the engine VM is an ADR of M6-04/M6-05.
 */
export const UNCONFIGURED_GITHUB_MESSAGE =
  "No GitHub App on this portal (ADR-047, M6-03): only public repositories are reachable, " +
  "and nothing is relayed.";

export function createUnconfiguredGithubForge(opts: { baseUrl?: string } = {}): Forge {
  const host = (opts.baseUrl ?? "https://github.com").replace(/\/+$/, "");
  return {
    kind: "github",
    pushUrl: (repo) => `${host}/${repo.owner}/${repo.name}.git`,
    async authorization() {
      throw new ForgeUnconfiguredError(UNCONFIGURED_GITHUB_MESSAGE);
    },
    async ensureRepo() {
      // Repositories are provisioned by the platform (analyse.md D3).
    },
  };
}