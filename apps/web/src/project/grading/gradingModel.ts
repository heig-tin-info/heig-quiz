import type { ProjectGradingRepo } from "@quiz/contracts";

/**
 * The pure rules of the grading screen of a project graded by criteria
 * (ADR-106 §8): which repository comes next, and the screen's ONE primary
 * action — the evaluation grading screen's pattern (`grading/rows.ts`):
 * Validate this repository → Next → Release.
 */

/** A repository still to validate: frozen for good, and not every criterion validated. */
export const toValidate = (repo: ProjectGradingRepo): boolean => repo.frozen && !repo.validation.validated;

/**
 * The index of the next repository to validate after `from`, wrapping
 * around and skipping `from` itself; null when none is left.
 */
export function nextToValidate(repos: readonly ProjectGradingRepo[], from: number): number | null {
  for (let step = 1; step < repos.length; step += 1) {
    const i = (from + step) % repos.length;
    if (toValidate(repos[i]!)) return i;
  }
  return null;
}

export type GradingPrimary =
  /** Mark this repository's proposals validated. */
  | { kind: "validate" }
  /** Validate waits: a criterion with no row (a teacher-only one), or a repository not frozen yet. */
  | { kind: "blocked"; reason: "missing" | "notFrozen" }
  /** This one is validated: on to the next one to validate. */
  | { kind: "next"; index: number }
  /** Every repository is frozen and validated: the release, on the project page. */
  | { kind: "release" };

/**
 * The single accent action of the screen for the repository at `index`:
 * Validate while it has proposals and no criterion without a row; held,
 * saying why, while one has none (never defaulted to 0) or it is not
 * frozen; then Next to the following repository to validate; Release only
 * once every repository is frozen and validated — held otherwise.
 */
export function gradingPrimary(repos: readonly ProjectGradingRepo[], index: number): GradingPrimary {
  const repo = repos[index];
  if (repo && !repo.validation.validated) {
    if (!repo.frozen) return { kind: "blocked", reason: "notFrozen" };
    if (repo.validation.missing.length > 0) return { kind: "blocked", reason: "missing" };
    return { kind: "validate" };
  }
  const next = nextToValidate(repos, index);
  if (next !== null) return { kind: "next", index: next };
  return repos.every((r) => r.frozen && r.validation.validated) ? { kind: "release" } : { kind: "blocked", reason: "notFrozen" };
}
