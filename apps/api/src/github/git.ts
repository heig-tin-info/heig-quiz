/**
 * Single git CLI wrapper for the GitHub plumbing (squash, provision, sync).
 * `identity: true` sets the bot committer, needed wherever commits are
 * created; plain clone/push runners skip it.
 *
 * The installation token never appears in a URL, a file or the argv of git
 * (N-SEC-16). Remotes are plain `https://github.com/<org>/<repo>.git`, and
 * the token reaches git through the ENVIRONMENT of the one process only, as
 * an `http.https://github.com/.extraheader` given by `GIT_CONFIG_*`. So a
 * clone's `.git/config` holds no credential (classroom wrote the token into
 * `remote.origin.url` under /tmp, where it outlived a crash), and neither
 * does `ps`.
 */
import { execFileSync } from "node:child_process";

import { redactTokens } from "../redact.js";

const BOT_IDENTITY = ["-c", "user.name=heig-quiz", "-c", "user.email=bot@heig-quiz.local"];

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

function run(args: string[], env: Record<string, string>): string {
  try {
    return execFileSync("git", args, { stdio: "pipe", env: { ...process.env, ...env } })?.toString() ?? "";
  } catch (err) {
    // execFileSync appends the captured stderr to the message: redact the
    // whole thing as a safety net and drop the original error, whose fields
    // (`stderr`, `cmd`) are not redacted.
    throw new Error(redactTokens(String((err as Error).message ?? err)));
  }
}

export interface GitRunner {
  git: (cwd: string, ...args: string[]) => string;
  /** Bare repository: explicit `--git-dir` (compatible with `safe.bareRepository=explicit`). */
  gitBare: (gitDir: string, ...args: string[]) => string;
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

/** A repository's remote URL: no credential in it, ever (GH-03). */
export const repoUrl = (org: string, repo: string) => `https://github.com/${org}/${repo}.git`;
