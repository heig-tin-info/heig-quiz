/**
 * The LLM review of the published questions (ADR-060): its pure rules — the
 * severities, the night it runs in, the share of the cap it may spend, the
 * path of a field and the exact replacement a fix makes.
 */
import { SCHOOL_TIME_ZONE, zoneOffset } from "./zone.js";

export const REVIEW_SEVERITIES = ["notice", "warn", "error"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export const REVIEW_STATES = ["clean", "findings", "ignored", "failed"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** The types whose configs are drawings, not text a model can read (ADR-060 §1). */
export const UNREVIEWED_TYPES: ReadonlySet<string> = new Set(["circuit", "diagram"]);

/** The most findings a review keeps (ADR-060 §2): a reply beyond it is noise. */
export const REVIEW_MAX_FINDINGS = 20;

/** The share of the day's cap the night's review may spend (ADR-060 §5). */
export const LLM_REVIEW_NIGHT_SHARE = 0.25;

/** The night, in Europe/Zurich hours: from 01:00 included to 06:00 excluded. */
export const REVIEW_NIGHT = { from: 1, to: 6 } as const;

/** Whether `at` falls in the review's night, on the school's clock. */
export function isReviewNight(at: Date): boolean {
  const hour = new Date(at.getTime() + zoneOffset(at, SCHOOL_TIME_ZONE)).getUTCHours();
  return hour >= REVIEW_NIGHT.from && hour < REVIEW_NIGHT.to;
}

/** The worst severity of a list, or null for none. */
export function worstSeverity(severities: readonly ReviewSeverity[]): ReviewSeverity | null {
  for (const s of ["error", "warn", "notice"] as const) if (severities.includes(s)) return s;
  return null;
}

/**
 * The pill of a review (ADR-060 §3): its state, the count of its open
 * findings — none for an ignored review — and the worst of their severities.
 */
export function reviewPill(
  state: ReviewState,
  findings: readonly { severity: ReviewSeverity }[],
): { state: ReviewState; count: number; worst: ReviewSeverity | null } {
  const open = state === "findings" ? findings : [];
  return { state, count: open.length, worst: worstSeverity(open.map((f) => f.severity)) };
}

/** `choices.2.text` as keys and indices; null for a path that is no path. */
export function parsePath(path: string): (string | number)[] | null {
  const parts = path.split(".");
  if (parts.some((p) => p === "" || p === "__proto__" || p === "constructor" || p === "prototype")) return null;
  return parts.map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

/** The value at `path` in `root`, or undefined. */
export function valueAt(root: unknown, path: readonly (string | number)[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

/** `root` with the value at `path` replaced, copied along the way; null when the path does not exist. */
export function withValueAt(root: unknown, path: readonly (string | number)[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [key, ...rest] = path as [string | number, ...(string | number)[]];
  if (root === null || typeof root !== "object" || !(key in root)) return null;
  const child = withValueAt((root as Record<string | number, unknown>)[key], rest, value);
  if (child === null && rest.length > 0) return null;
  if (Array.isArray(root)) return root.map((v, i) => (i === key ? child : v));
  return { ...(root as Record<string, unknown>), [key]: child };
}

/**
 * A fix applied to one field's value (ADR-060 §4): `from` must occur EXACTLY
 * once in the text, which becomes `to` there; a tick must read as `from`
 * (`true`, `false`) and becomes `to`. Null when the value does not hold
 * `from` once — the draft moved on since the review — or `to` is no tick.
 */
export function applyFix(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") {
    if (from === "") return null;
    const at = value.indexOf(from);
    if (at < 0 || value.indexOf(from, at + 1) >= 0) return null;
    return value.slice(0, at) + to + value.slice(at + from.length);
  }
  if (typeof value === "boolean") {
    if (String(value) !== from.trim() || (to.trim() !== "true" && to.trim() !== "false")) return null;
    return to.trim() === "true";
  }
  return null;
}
