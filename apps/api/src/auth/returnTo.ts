/**
 * Where to land after a login round trip — the ONE validator both login
 * paths use (the OIDC callback and the development persona picker).
 *
 * A poll invites a phone to `/p/ABC123` (F-LIVE-13). When the poll is not
 * anonymous that phone has to sign in first, and it must come back to the
 * poll rather than to the home page, so the URL it was sent to travels
 * through the login as `?next=`.
 *
 * Only a same-origin, absolute PATH is accepted: anything else — a full URL,
 * a protocol-relative `//evil.example`, a backslash Windows browsers once
 * folded to a slash — falls back to the home page. That is what keeps the
 * parameter from ever becoming an open redirect.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  return raw;
}

/** `?next=` wins; `?returnTo=` is the name the SPA already sends. */
export function returnToOf(query: unknown): string {
  const q = (query ?? {}) as { next?: unknown; returnTo?: unknown };
  return safeReturnTo(q.next ?? q.returnTo);
}
