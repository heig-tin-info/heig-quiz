/**
 * Two pure rules the GitHub adapters (`apps/api/src/github/`) apply, ported
 * from classroom's `github/studentize.ts` and `github/metrics.ts`. The file
 * system and HTTP work around them stays in the adapters.
 */

/**
 * Relative paths listed in a `.studentignore` (teacher-only paths removed
 * from a project's student handout): one per line, `#` for comments, no
 * globs. Anything that could leave the tree or touch the git metadata (`..`,
 * `.`, `.git`) is dropped, not honored.
 */
export function parseStudentIgnore(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const path = line.replace(/^\/+/, "").replace(/\/+$/, "");
    const parts = path.split("/");
    if (path === "" || parts.some((p) => p === "" || p === "." || p === "..")) continue;
    if (parts[0] === ".git") continue;
    out.push(path);
  }
  return out;
}

/**
 * Epoch ms at which a request GitHub refused for its rate limit may be
 * retried, or null when `err` is not a rate-limit refusal. Reads the shape of
 * an Octokit `RequestError`: 403 or 429, then either an exhausted quota with
 * its reset time (seconds) or a `retry-after` delay (seconds) counted from
 * `now`.
 */
export function rateLimitReset(err: unknown, now: number): number | null {
  const e = err as { status?: number; response?: { headers?: Record<string, string> } } | null;
  if (e?.status !== 403 && e?.status !== 429) return null;
  const headers = e.response?.headers ?? {};
  if (headers["x-ratelimit-remaining"] === "0" && headers["x-ratelimit-reset"]) {
    return Number(headers["x-ratelimit-reset"]) * 1000;
  }
  if (headers["retry-after"]) return now + Number(headers["retry-after"]) * 1000;
  return null;
}
