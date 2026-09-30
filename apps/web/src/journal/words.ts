import type { JournalSyncError, JournalWarning, JournalWarningCode } from "@quiz/contracts";

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
