/**
 * Single git CLI wrapper for the GitHub plumbing (squash, provision, sync).
 * `identity: true` sets the throwaway committer, needed wherever git builds
 * a commit to carry a tree; plain clone/push runners skip it.
 *
 * Asynchronous (`spawn`, never `execFileSync`): a clone or a push of a
 * project's sources takes seconds, and a request that builds a distribution
 * repository must not stop the event loop — the live clock, the SSE and every
 * other request run on it (merge task M3-02).
 *
 * The installation token never appears in a URL, a file or the argv of git
 * (N-SEC-16, invariant 15). Remotes are plain
 * `https://github.com/<org>/<repo>.git`, and the token reaches git through
 * the ENVIRONMENT of the one process only, as an
 * `http.https://github.com/.extraheader` given by `GIT_CONFIG_*`. So a
 * clone's `.git/config` holds no credential (classroom wrote the token into
 * `remote.origin.url` under /tmp, where it outlived a crash), and neither
 * does `ps`.
 *
 * That environment is git's WHOLE environment (audit L20): never the API's
 * (its database URL, its secrets), and no configuration but the call's own —
 * no system file, no global file, no home.
 */
import { spawn } from "node:child_process";

import { redactTokens } from "../redact.js";

/**
 * The identity of the THROWAWAY commits that carry a tree to GitHub (the
 * squash's, the sync's): git has none of its own here (`HOME=/nonexistent`).
 * No branch ever ends on one: the platform's commits are created by the API,
 * GitHub-signed and attributed to the App (`signedCommit.ts`, #917). It
 * never signs, whatever the machine's own git configuration says.
 */
const BOT_IDENTITY = [
  "-c",
  "user.name=heig-quiz",
  "-c",
  "user.email=bot@heig-quiz.local",
  "-c",
  "commit.gpgsign=false",
];

/** What git may write on its standard output before the call fails (a `rev-parse`, a `log`). */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** The environment that hands `token` to git for github.com, and nowhere else. */
export function credentialEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/**
 * The whole environment of a git process (audit L20): the `PATH` that finds
 * git, a `HOME` that does not exist, no system nor global configuration,
 * never a terminal prompt — and `extra`, the call's credential when it has
 * one. No proxy nor CA variable is passed: production reaches github.com
 * directly and trusts the image's system store (no `HTTPS_PROXY`,
 * `SSL_CERT_FILE` or `GIT_SSL_CAINFO` in the compose files); a deployment
 * that needs one adds it here, by name.
 */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    // Never ask a terminal for a password when the token is refused.
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

/** What one call adds to git's environment, by name only: a temporary index, a commit's fixed dates. */
export type GitCallEnv = { [K in "GIT_INDEX_FILE" | "GIT_AUTHOR_DATE" | "GIT_COMMITTER_DATE"]?: string };

/**
 * One call's own options: its standard input, its variables, and `latin1`
 * to read and write bytes as they are (a path git lists need not be
 * UTF-8: one character per byte, round-tripped exactly).
 */
export interface GitCallOptions {
  input?: string | undefined;
  env?: GitCallEnv | undefined;
  latin1?: boolean | undefined;
}

function run(args: string[], env: Record<string, string>, opts: GitCallOptions & { deadline?: number | undefined } = {}): Promise<string> {
  const left = opts.deadline === undefined ? null : opts.deadline - Date.now();
  if (left !== null && left <= 0) return Promise.reject(new Error("git: out of time"));
  const encoding: BufferEncoding = opts.latin1 ? "latin1" : "utf8";
  return new Promise((resolve, reject) => {
    // Its own process group (`detached`), so that the deadline kills git's helpers too (`git-remote-https`, `index-pack`).
    const child = spawn("git", args, { env: gitEnv({ ...env, ...opts.env }), detached: left !== null, stdio: "pipe" });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let failure: string | null = null;
    const kill = (why: string) => {
      failure ??= why;
      try {
        process.kill(left !== null ? -child.pid! : child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = left === null ? undefined : setTimeout(() => kill("out of time"), left);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) kill("output too large");
      else out.push(chunk);
    });
    // Its stderr is kept up to the same bound, the rest dropped: a chatty git is never killed for it.
    let errSize = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (errSize < MAX_OUTPUT_BYTES) err.push(chunk.subarray(0, MAX_OUTPUT_BYTES - errSize));
      errSize += chunk.length;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(redactTokens(String(e.message))));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // The command and its stderr may quote a token: the message is redacted as a safety net.
      if (failure !== null || code !== 0) {
        const why = failure ?? `exit ${code ?? signal}`;
        reject(new Error(redactTokens(`Command failed (${why}): git ${args.join(" ")}\n${Buffer.concat(err).toString("utf8")}`)));
      } else resolve(Buffer.concat(out).toString(encoding));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input === undefined ? undefined : Buffer.from(opts.input, encoding));
  });
}

export interface GitRunner {
  git: (cwd: string, ...args: string[]) => Promise<string>;
  /** Bare repository: explicit `--git-dir` (compatible with `safe.bareRepository=explicit`), with the call's own options. */
  gitBare: (gitDir: string, args: string[], opts?: GitCallOptions) => Promise<string>;
}

/**
 * A runner; with `token`, every call is authenticated on github.com; with
 * `deadline` (an epoch in ms), a call still running then is killed with its
 * process group, and one started after it fails at once.
 */
export function gitRunner(opts: { identity?: boolean; token?: string; deadline?: number } = {}): GitRunner {
  const extra = opts.identity ? BOT_IDENTITY : [];
  const env = opts.token ? credentialEnv(opts.token) : {};
  const deadline = opts.deadline;
  return {
    git: (cwd, ...args) => run(["-C", cwd, ...extra, ...args], env, { deadline }),
    gitBare: (gitDir, args, call = {}) => run(["--git-dir", gitDir, ...extra, ...args], env, { ...call, deadline }),
  };
}

const GITHUB = "https://github.com";
let remoteBase = GITHUB;

/** The page of a repository on GitHub, for a link a person follows (never a remote: no credential, no `.git`). */
export const htmlUrl = (fullName: string): string => `${GITHUB}/${fullName}`;

/**
 * The one seam of the remotes, for the tests: every repository URL is
 * `<base>/<org>/<repo>.git`, GitHub's unless a test points it at a directory
 * of local bare repositories (`file:///…`). Null puts GitHub back. The
 * credential header stays scoped to github.com, so a local remote is never
 * sent the token.
 */
export function setRemoteBaseForTests(base: string | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setRemoteBaseForTests: never in production");
  remoteBase = base ?? GITHUB;
}

/** A repository's remote URL: no credential in it, ever (GH-03). */
export const repoUrl = (org: string, repo: string) => `${remoteBase}/${org}/${repo}.git`;
