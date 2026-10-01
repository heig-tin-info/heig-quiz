import type { JournalRepository } from "@quiz/contracts";

import { useT } from "../i18n";
import { cx, RelativeTime, type CheckLevel } from "../ui";

/*
 * Where a classroom's copy of its repository stands (F-JRN-05), said the same
 * way in the reader's staff bar and in the Settings' Journal section: being
 * refreshed, being read, failed, or synced when.
 */

/** The check level of the sync state (DESIGN.md › The launch checklist): a failure is the one blocker. */
export function syncLevel(repository: JournalRepository, refreshing: boolean): CheckLevel {
  if (refreshing || repository.syncStatus === "pending") return "unknown";
  return repository.syncStatus === "error" ? "blocker" : "ok";
}

/** The state in words; "Refreshing…" from the click until the row moves (`useJournalRefresh`). */
export function SyncText({ repository, refreshing }: { repository: JournalRepository; refreshing: boolean }) {
  const t = useT();
  if (refreshing) return <>{t("journal.sync.refreshing")}</>;
  if (repository.syncStatus === "pending") return <>{t("journal.sync.pending")}</>;
  if (repository.syncStatus === "error") return <>{t("journal.sync.errorTitle")}</>;
  if (!repository.lastSyncedAt) return <>{t("journal.sync.never")}</>;
  return (
    <>
      {t("journal.sync.ok")} <RelativeTime iso={repository.lastSyncedAt} />
    </>
  );
}

/** The reader's compact form: one quiet line, red when the last synchronisation failed. */
export function SyncState({ repository, refreshing }: { repository: JournalRepository; refreshing: boolean }) {
  return (
    <p
      aria-live="polite"
      className={cx("text-xs", !refreshing && repository.syncStatus === "error" ? "text-danger" : "text-fg-faint")}
    >
      <SyncText repository={repository} refreshing={refreshing} />
    </p>
  );
}
