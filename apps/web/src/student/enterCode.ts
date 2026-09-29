import { JOIN_CODE_LENGTH, POLL_CODE_LENGTH } from "@quiz/contracts";

/**
 * The student's one code field (ADR-045): a poll's session code or a
 * classroom's join code, told apart by their length and nothing else. No
 * server route resolves a code: a poll code goes to the poll's own page,
 * which already answers an unknown one, and a join code to `POST /join`,
 * which writes and audits — so no silent oracle says which classroom codes
 * exist. An exam's access code is not typed here but on the exam's own page.
 */
export type CodeTarget =
  | { kind: "poll"; code: string }
  | { kind: "classroom"; code: string }
  | { kind: "invalid" };

/**
 * What the student typed, as a code: spaces and hyphens out (a code read off
 * a slide as `K7PM-Q2XR`, or pasted with a trailing space), upper-cased. No
 * correction of look-alike characters: neither alphabet has any.
 */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]+/g, "").toUpperCase();
}

/** Where a typed code leads. */
export function codeTarget(raw: string): CodeTarget {
  const code = normalizeCode(raw);
  if (code.length === POLL_CODE_LENGTH) return { kind: "poll", code };
  if (code.length === JOIN_CODE_LENGTH) return { kind: "classroom", code };
  return { kind: "invalid" };
}
