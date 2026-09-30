/**
 * Single git CLI wrapper for the GitHub plumbing (squash, provision, sync).
 * `identity: true` sets the bot committer, needed wherever commits are
 * created; plain clone/push runners skip it.
 */
import { execFileSync } from "node:child_process";

import { redactTokens } from "../redact.js";

const BOT_IDENTITY = ["-c", "user.name=heig-quiz", "-c", "user.email=bot@heig-quiz.local"];

function run(args: string[]): string {
  try {
    return execFileSync("git", args, { stdio: "pipe" })?.toString() ?? "";
  } catch (err) {
    // Git failures echo the remote URL, which embeds the installation token
    // (authUrl below), and execFileSync appends the captured stderr to the
    // message: redact the whole thing before it can reach a log, a stored
    // error or a teacher-facing tooltip, and drop the original error (its
    // `cmd`/`stderr` fields still carry the token). N-SEC-16.
    throw new Error(redactTokens(String((err as Error).message ?? err)));
  }
}

export interface GitRunner {
  git: (cwd: string, ...args: string[]) => string;
  /** Bare repository: explicit `--git-dir` (compatible with `safe.bareRepository=explicit`). */
  gitBare: (gitDir: string, ...args: string[]) => string;
}

export function gitRunner(opts: { identity?: boolean } = {}): GitRunner {
  const extra = opts.identity ? BOT_IDENTITY : [];
  return {
    git: (cwd, ...args) => run(["-C", cwd, ...extra, ...args]),
    gitBare: (gitDir, ...args) => run(["--git-dir", gitDir, ...extra, ...args]),
  };
}

/** Installation-token remote URL (GH-03). */
export const authUrl = (token: string, org: string, repo: string) =>
  `https://x-access-token:${token}@github.com/${org}/${repo}.git`;
