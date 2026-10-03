/**
 * The rules of the staff's project page (F-PROJ-13, F-PROJ-14, merge task
 * M3-08a): the grade a score reads as, whether a final score moved since
 * the release, and the page's one primary action. The `project` module
 * reads the rows; these decide.
 */
import { projectGrade, type ProjectGrade, type ProjectScale } from "./projectGrade.js";

/** A score's grade by the project's scale, or null when it has no maximum to read it against. */
export function scoreGrade(points: number | null, max: number | null, scale: ProjectScale): ProjectGrade | null {
  return points !== null && max !== null && max > 0 ? projectGrade(points, max, scale) : null;
}

/**
 * Whether a final score differs from what the release wrote (D05 addendum,
 * F-PROJ-14): only once the project was released; a score that appeared,
 * vanished, or changed its points or its maximum since then.
 */
export function changedAfterRelease(
  released: boolean,
  final: { points: number; max: number | null } | null,
  snapshot: { points: number | null; max: number | null },
): boolean {
  if (!released) return false;
  return (final?.points ?? null) !== snapshot.points || (final?.max ?? null) !== snapshot.max;
}

/** The one primary action of the staff's project page (F-PROJ-13). */
export const PROJECT_PRIMARY_ACTIONS = ["publish", "sync", "release", "none"] as const;
export type ProjectPrimaryAction = (typeof PROJECT_PRIMARY_ACTIONS)[number];

export interface PrimaryActionInput {
  state: "draft" | "published" | "locked";
  archived: boolean;
  gradingMode: "auto" | "none";
  /** The source holds commits the distribution repository lacks (F-PROJ-12, M3-07). */
  sourceAhead: boolean;
  /** The repositories that take a deadline (provisioned, not deleted). */
  live: number;
  /** Of those, the ones definitively frozen. */
  frozen: number;
  released: boolean;
  /** Repositories whose final score moved since the release. */
  changedAfterRelease: number;
}

/**
 * Whether the scores are final, so the release may be asked for (product
 * owner, 2026-10-02): a graded project whose every live repository is
 * frozen, and at least one. A deleted repository, one never provisioned, or
 * any repository of an archived project does not hold it back.
 */
export function scoresFinal(p: Pick<PrimaryActionInput, "gradingMode" | "live" | "frozen">): boolean {
  return p.gradingMode === "auto" && p.live > 0 && p.frozen === p.live;
}

/**
 * Publish for a draft; Release once the scores are final and not yet
 * released, or changed since; Sync when the source is ahead; nothing for an
 * archived project. The release comes before the sync: once every
 * repository is frozen, a sync reaches nobody's score.
 */
export function projectPrimaryAction(p: PrimaryActionInput): ProjectPrimaryAction {
  if (p.archived) return "none";
  if (p.state === "draft") return "publish";
  if (scoresFinal(p) && (!p.released || p.changedAfterRelease > 0)) return "release";
  if (p.sourceAhead) return "sync";
  return "none";
}
