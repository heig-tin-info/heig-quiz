import { useQuery } from "@tanstack/react-query";
import { FileClock, History, RotateCcw } from "lucide-react";
import { useState } from "react";

import type { JournalDeletedPage, JournalRevision } from "@quiz/contracts";

import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { journalRevisionRenderedKey } from "../queryKeys";
import { Badge, Button, cx, EmptyState, isoDateTime, QueryError, Segmented, Sheet, Skeleton } from "../ui";
import {
  journalErrorText,
  previewJournalPage,
  useJournalDeleted,
  useJournalRestore,
  useJournalRevision,
  useJournalRevisions,
} from "./api";
import { JournalArticle } from "./JournalArticle";

/*
 * The history of a Quiz-mode journal (ADR-057): one revision per save, and
 * the pages deleted since, which a revision brings back. Staff only; no
 * student route reads a revision.
 *
 * Both are sheets (DESIGN.md: histories go in a sheet), opened from the
 * Pages menu of the reader's staff bar. A restore is a save like any
 * other, confirmed, and it never loses anything: the version it replaces
 * stays in the history.
 *
 * The four decisions:
 * - Type: a revision is named by its date (13 px, tabular) and its author
 *   (12 px muted); the revision on view is read in the page's own long-form
 *   type, or as its markdown in mono.
 * - Color: ONE accent, the sheet's footer button (Restore this version);
 *   the selected revision is an `accent-soft` row, as the reader's strip
 *   marks the page being read.
 * - Space: rows 2 apart inside the list, 20 between the list and the
 *   revision on view.
 * - Finish: the list is bare rows on the sheet; the revision sits on
 *   `surface-2`, recessed, like a preview.
 */

/** A revision's author, or the words for none. */
const authorOf = (revision: JournalRevision, t: ReturnType<typeof useT>) =>
  revision.author ?? t("journalHistory.unknownAuthor");

/** `HistorySheet`: a page's revisions, one on view, and Restore. */
export function HistorySheet({
  classroomId,
  path,
  title,
  onClose,
}: {
  classroomId: string;
  path: string;
  /** The page's title, for the sheet's; null when nothing names it. */
  title: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const revisions = useJournalRevisions(classroomId, path);
  const [picked, setPicked] = useState<string | null>(null);
  const list = revisions.data ?? [];
  const selected = picked ?? list[0]?.id ?? null;
  const current = list[0]?.id ?? null;
  const restore = useJournalRestore(classroomId);

  const onRestore = async () => {
    const revision = list.find((r) => r.id === selected);
    if (!revision) return;
    const ok = await confirm({
      title: t("journalHistory.restoreTitle"),
      message: t("journalHistory.restoreBody", { date: isoDateTime(revision.createdAt) }),
      confirmLabel: t("journalHistory.restore"),
    });
    if (!ok) return;
    restore.mutate(revision.id, {
      onSuccess: () => {
        toast(t("journalHistory.restored"), "success");
        onClose();
      },
      onError: (error) => toast(journalErrorText(error, t), "error"),
    });
  };

  let body;
  if (revisions.isPending) {
    body = (
      <div className="space-y-2" role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  } else if (revisions.isError) {
    body = (
      <QueryError title={t("journalHistory.loadFailed")} query={revisions} />
    );
  } else if (list.length === 0) {
    body = (
      <EmptyState icon={History} title={t("journalHistory.empty")}>
        {t("journalHistory.emptyHint")}
      </EmptyState>
    );
  } else {
    body = (
      <div className="space-y-5">
        <ol aria-label={t("journalHistory.list")} className="space-y-0.5">
          {list.map((revision) => (
            <li key={revision.id}>
              <button
                type="button"
                aria-current={revision.id === selected ? "true" : undefined}
                onClick={() => setPicked(revision.id)}
                className={cx(
                  "flex w-full items-center gap-3 rounded-field px-3 py-2 text-left",
                  revision.id === selected ? "bg-accent-soft" : "hover:bg-surface-2",
                )}
              >
                <span className="text-[13px] font-medium tabular-nums text-fg">{isoDateTime(revision.createdAt)}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{authorOf(revision, t)}</span>
                {revision.id === current ? <Badge tone="zinc">{t("journalHistory.current")}</Badge> : null}
              </button>
            </li>
          ))}
        </ol>
        {selected ? <RevisionView classroomId={classroomId} path={path} revisionId={selected} /> : null}
      </div>
    );
  }

  return (
    <Sheet
      title={t("journalHistory.title", { name: title ?? path })}
      subtitle={<span className="font-mono text-xs">{path}</span>}
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button
            disabled={selected === null || selected === current}
            loading={restore.isPending}
            onClick={() => void onRestore()}
          >
            {restore.isPending ? null : <RotateCcw />} {t("journalHistory.restore")}
          </Button>
        </>
      }
    >
      {body}
    </Sheet>
  );
}

/** One revision: rendered as the page would read (the server's renderer), or its markdown. */
function RevisionView({ classroomId, path, revisionId }: { classroomId: string; path: string; revisionId: string }) {
  const t = useT();
  const [as, setAs] = useState<"rendered" | "source">("rendered");
  const revision = useJournalRevision(classroomId, revisionId);
  const markdown = revision.data?.markdown ?? null;
  const rendered = useQuery({
    queryKey: journalRevisionRenderedKey(classroomId, revisionId),
    queryFn: () => previewJournalPage(classroomId, path, markdown!),
    enabled: markdown !== null && as === "rendered",
    staleTime: Infinity,
  });

  let content;
  if (revision.isPending || (as === "rendered" && rendered.isPending)) {
    content = (
      <div className="space-y-2" role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    );
  } else if (revision.isError || (as === "rendered" && rendered.isError)) {
    const failed = revision.isError ? revision : rendered;
    content = (
      <QueryError title={t("journalHistory.revisionFailed")} query={failed} />
    );
  } else if (as === "source") {
    content = (
      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-fg">{markdown}</pre>
    );
  } else {
    content = (
      <JournalArticle html={rendered.data!.html} classroomId={classroomId} pagePath={path} onOpen={() => {}} keepScroll />
    );
  }

  return (
    <section aria-label={t("journalHistory.revision")} className="space-y-3 border-t border-line pt-5">
      <Segmented
        name="journal-revision-view"
        size="sm"
        label={t("journalHistory.view")}
        value={as}
        onChange={setAs}
        options={[
          { value: "rendered", label: t("journalHistory.rendered") },
          { value: "source", label: t("journalHistory.source") },
        ]}
      />
      <div className="rounded-field bg-surface-2 px-4 py-3">{content}</div>
    </section>
  );
}

/** `DeletedSheet`: the pages deleted from the journal, each brought back by its last revision. */
export function DeletedSheet({
  classroomId,
  onClose,
  onRestored,
}: {
  classroomId: string;
  onClose: () => void;
  /** The page is back: the reader opens it. */
  onRestored: (path: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const deleted = useJournalDeleted(classroomId);
  const restore = useJournalRestore(classroomId);
  const restoring = (page: JournalDeletedPage) => restore.isPending && restore.variables === page.revisionId;

  // The page comes back as it was last saved: its newest revision.
  const bringBack = async ({ path, title, revisionId }: JournalDeletedPage) => {
    const ok = await confirm({
      title: t("journalDeleted.restoreTitle", { name: title ?? path }),
      message: t("journalDeleted.restoreBody", { path }),
      confirmLabel: t("journalDeleted.restore"),
    });
    if (!ok) return;
    restore.mutate(revisionId, {
      onSuccess: (written) => {
        toast(t("journalDeleted.restored"), "success");
        onRestored(written.path);
      },
      onError: (error) => toast(journalErrorText(error, t), "error"),
    });
  };

  let body;
  if (deleted.isPending) {
    body = (
      <div className="space-y-2" role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  } else if (deleted.isError) {
    body = (
      <QueryError title={t("journalDeleted.loadFailed")} query={deleted} />
    );
  } else if (deleted.data.length === 0) {
    body = (
      <EmptyState icon={FileClock} title={t("journalDeleted.empty")}>
        {t("journalDeleted.emptyHint")}
      </EmptyState>
    );
  } else {
    body = (
      <ul className="divide-y divide-line">
        {deleted.data.map((page) => (
          <li key={page.path} className="flex items-center gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{page.title ?? page.path}</p>
              <p className="truncate text-xs text-fg-muted">
                <span className="font-mono">{page.path}</span>
                {" · "}
                {t("journalDeleted.savedAt", { date: isoDateTime(page.savedAt) })}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              loading={restoring(page)}
              disabled={restore.isPending && !restoring(page)}
              onClick={() => void bringBack(page)}
            >
              {restoring(page) ? null : <RotateCcw />} {t("journalDeleted.restore")}
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Sheet title={t("journalDeleted.title")} onClose={onClose}>
      {body}
    </Sheet>
  );
}
