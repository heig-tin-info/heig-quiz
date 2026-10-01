import type { JournalErrorCode, JournalSyncError, JournalWarning, JournalWarningCode } from "@quiz/contracts";

import type { Dict, TFunction } from "../i18n";

/*
 * The journal's codes, worded (fix J5, invariant 1): the server says WHAT
 * happened as a code with parameters, the reader says it in the interface
 * language. Both tables are keyed by the contract's closed unions, so a code
 * added to `@quiz/contracts` is a compile error here until it has its `en`
 * and `fr` strings.
 */

type WarningOf<C extends JournalWarningCode> = Extract<JournalWarning, { code: C }>;

const WARNINGS: { [C in JournalWarningCode]: (w: WarningOf<C>, t: TFunction) => string } = {
  front_matter_yaml: (w, t) =>
    w.line === undefined
      ? t("journal.warning.front_matter_yaml")
      : t("journal.warning.front_matter_yaml.line", { line: w.line }),
  front_matter_not_mapping: (_, t) => t("journal.warning.front_matter_not_mapping"),
  visible_from_invalid: (w, t) => t("journal.warning.visible_from_invalid", { value: w.value }),
  raw_html: (_, t) => t("journal.warning.raw_html"),
  external_image: (w, t) => t("journal.warning.external_image", { href: w.href }),
  target_missing: (w, t) => t("journal.warning.target_missing", { href: w.href, path: w.path }),
  asset_too_large: (w, t) => t("journal.warning.asset_too_large", { href: w.href, path: w.path }),
  math_error: (w, t) => t("journal.warning.math_error", { source: w.source }),
};

/** One warning of a page, in the interface language. */
export function warningText(warning: JournalWarning, t: TFunction): string {
  // The one cast: the compiler cannot correlate `warning.code` with the entry it selects.
  return (WARNINGS[warning.code] as (w: JournalWarning, t: TFunction) => string)(warning, t);
}

/** Why the last synchronisation failed, by its code. */
export const SYNC_ERRORS: Record<JournalSyncError, keyof Dict> = {
  repo_not_found: "journal.syncError.repo_not_found",
  ref_not_found: "journal.syncError.ref_not_found",
  root_not_found: "journal.syncError.root_not_found",
  github_unavailable: "journal.syncError.github_unavailable",
  too_large: "journal.syncError.too_large",
  forbidden: "journal.syncError.forbidden",
};

/**
 * Why a write of the journal was refused (M4-03's `JournalErrorCode`): what
 * GitHub answered, then the refusals of a write. A missing repository,
 * branch or folder is worded for the one who just typed it ("Use a
 * repository"), not as one that went missing since; the rest as above.
 * Keyed by the contract's enum, so a new code is a compile error until it
 * is worded.
 */
export const JOURNAL_ERRORS: Record<JournalErrorCode, keyof Dict> = {
  ...SYNC_ERRORS,
  repo_not_found: "journal.error.repo_not_found",
  ref_not_found: "journal.error.ref_not_found",
  root_not_found: "journal.error.root_not_found",
  not_connected: "journal.error.not_connected",
  journal_exists: "journal.error.journal_exists",
  no_journal: "journal.error.no_journal",
  name_taken: "journal.error.name_taken",
  conflict: "journal.error.conflict",
  page_exists: "journal.error.page_exists",
  type_mismatch: "journal.error.type_mismatch",
  empty_upload: "journal.error.empty_upload",
  read_only: "journal.error.read_only",
};
