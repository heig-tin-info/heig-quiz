/**
 * Single git CLI wrapper for the GitHub plumbing (squash, provision, sync).
 * `identity: true` sets the bot committer, needed wherever commits are
 * created; plain clone/push runners skip it.
 *
 * Asynchronous (`execFile`, never `execFileSync`): a clone or a push of a
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
 */
import { execFile } from "node:child_process";

import { redactTokens } from "../redact.js";

/** The bot's identity; it never signs, whatever the machine's own git configuration says. */
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
    // Never ask a terminal for a password when the token is refused.
    GIT_TERMINAL_PROMPT: "0",
  };
}

function run(args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { env: { ...process.env, ...env }, maxBuffer: MAX_OUTPUT_BYTES },
      (err, stdout) => {
        // execFile's message carries the command and its stderr: redact the
        // whole thing as a safety net and drop the original error, whose
        // fields (`stderr`, `cmd`) are not redacted.
        if (err) reject(new Error(redactTokens(String(err.message ?? err))));
        else resolve(String(stdout));
      },
    );
  });
}

export interface GitRunner {
  git: (cwd: string, ...args: string[]) => Promise<string>;
  /** Bare repository: explicit `--git-dir` (compatible with `safe.bareRepository=explicit`). */
  gitBare: (gitDir: string, ...args: string[]) => Promise<string>;
}

/** A runner; with `token`, every call is authenticated on github.com. */
export function gitRunner(opts: { identity?: boolean; token?: string } = {}): GitRunner {
  const extra = opts.identity ? BOT_IDENTITY : [];
  const env = opts.token ? credentialEnv(opts.token) : {};
  return {
    git: (cwd, ...args) => run(["-C", cwd, ...extra, ...args], env),
    gitBare: (gitDir, ...args) => run(["--git-dir", gitDir, ...extra, ...args], env),
  };
}

const GITHUB = "https://github.com";
let remoteBase = GITHUB;

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
