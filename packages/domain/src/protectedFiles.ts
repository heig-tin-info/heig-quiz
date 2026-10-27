/**
 * A project's protected files (F-PROJ-08, ADR-119 §9): the names the
 * platform reads in a repository, what the list protects, and what the
 * `criteria` mode forces into it.
 */
import type { ProjectGradingModeName } from "./projectView.js";
import { pathWithin } from "./studentIgnore.js";

/** The criteria file, at the repository's root (ADR-106 §2, ADR-119 §3). */
export const CRITERIA_FILE = "criteria.yml";
/** The repository's workflows: the CI that answers the platform's dispatch (ADR-119 §6). */
export const WORKFLOWS_DIR = ".github/workflows";
/** The student repositories' grading workflow (schema 2's `tests-criterion`; F-PROJ-01's warning). */
export const GRADING_WORKFLOW = `${WORKFLOWS_DIR}/grading.yml` as const;

/**
 * What the `criteria` mode protects whatever the staff pick (ADR-119 §9,
 * choice k): the workflows, a directory, and the criteria. A directory
 * protects its content.
 */
export const CRITERIA_PROTECTED = [WORKFLOWS_DIR, CRITERIA_FILE] as const;

/** The forced entries that are directories: a picker draws them as such even where the tree lacks them. */
export const PROTECTED_DIRECTORIES: readonly string[] = [WORKFLOWS_DIR];

/** The entries a grading mode forces into the protected list. */
export const forcedProtected = (gradingMode: ProjectGradingModeName): readonly string[] =>
  gradingMode === "criteria" ? CRITERIA_PROTECTED : [];

/** The protected list with the entries `gradingMode` forces added at its end, the others kept in their order. */
export function withForcedProtected(files: readonly string[], gradingMode: ProjectGradingModeName): string[] {
  return [...files, ...forcedProtected(gradingMode).filter((path) => !files.includes(path))];
}

/** Whether `path` is protected by `entries`: listed, or under a listed directory. */
export const isProtected = (path: string, entries: readonly string[]): boolean => entries.some((entry) => pathWithin(path, entry));
