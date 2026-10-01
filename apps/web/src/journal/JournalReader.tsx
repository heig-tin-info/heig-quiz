import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  ChevronDown,
  ExternalLink,
  EyeOff,
  FileClock,
  FilePlus,
  FileQuestion,
  History,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { lazy, Suspense, useEffect, useId, useState, type ReactNode } from "react";

import {
  encodeJournalPath,
  type Journal,
  type JournalNavNode,
  type JournalPage,
  type JournalPageStaff,
  type JournalRepository,
} from "@quiz/contracts";

import { api, ApiError } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { journalKey, journalPageKey } from "../queryKeys";
import { routeToPath, type Navigate } from "../router";
import {
  Actions,
  Alert,
  Badge,
  Button,
  cx,
  EmptyState,
  isoDateTime,
  LinkButton,
  PageError,
  QueryError,
  Skeleton,
  useMinWidth,
} from "../ui";
import { journalErrorText, useJournalDeletePage, useJournalRefresh } from "./api";
import { AddPageDialog } from "./editor/AddPageDialog";
import { pageFolder } from "./editor/images";
import { JournalArticle } from "./JournalArticle";
import { DeletedSheet, HistorySheet } from "./JournalHistory";
import { JournalStrip } from "./JournalStrip";
import { JournalToc, tocEntries } from "./JournalToc";
import { SyncState } from "./SyncState";
import { SYNC_ERRORS, warningText } from "./words";

/*
 * The journal of a classroom, read (F-JRN-07) — both roles, one route
 * (`/classrooms/:id/journal/<path>`), and the payload decides what is shown:
 * the staff fields (draft and visibility badges, warnings, the sync state)
 * exist only in the staff payload, so the student view cannot show them.
 *
 * The four decisions:
 * - Type: the document owns the title, its `h1` at the 28 px step inside
 *   `.md-doc`; the strip of pages is 13 px dense UI, a step under the
 *   classroom's 14 px tabs. No page title above it: two `h1`s on one screen
 *   and neither wins.
 * - Color: ONE accent, the entry being read in the strip (an `accent-soft`
 *   chip, no underline: the ink underline is the classroom tabs'). A
 *   student has no primary action here. The staff have Refresh (secondary)
 *   and Edit (primary, inside a page) in their bar above the page.
 * - Space: 4 between the strip's entries, 24 between the rows (strip, staff
 *   bar, page), 32 between the page and the TOC; the prose has its own
 *   rhythm (1.75 leading, 72 ch).
 * - Finish: the page is a sheet of paper (`surface`, hairline, card radius)
 *   on the canvas; the strip and the TOC are bare. No shadow.
 *
 * Layout: the strip of pages (`JournalStrip`) is a row of its own under the
 * classroom's tabs, above the staff bar, at every width; it scrolls sideways
 * when the entries outgrow it. The page is a centred column (48 rem, the
 * prose capped at 72 ch inside it); from `xl` the TOC is a 13 rem column at
 * its right, below `xl` a small "On this page" disclosure above it.
 *
 * The reader is always some page's tab: the teacher classroom page's Journal
 * tab (`ClassroomView`, M4-05) or the student classroom page's (M5-02, whose
 * compact header comes in as `header`). It draws no breadcrumb of its own.
 */

type View = "staff" | "student";

/** The editor (M4-06), a chunk of its own: the staff load it on Edit. */
const JournalEditor = lazy(() => import("./editor/JournalEditor").then((m) => ({ default: m.JournalEditor })));

/** The first node of the navigation, depth first, that `pred` accepts. */
function findNode(nodes: JournalNavNode[], pred: (node: JournalNavNode) => boolean): JournalNavNode | null {
  for (const node of nodes) {
    if (pred(node)) return node;
    const inner = findNode(node.children, pred);
    if (inner !== null) return inner;
  }
  return null;
}

const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

export function JournalReader({
  classroomId,
  path,
  navigate,
  studentView,
  header: outerHeader,
}: {
  classroomId: string;
  /** The page named by the address; absent for the journal's home. */
  path?: string;
  navigate: Navigate;
  /**
   * The student UI is on — a student, or a teacher in the student view
   * (ADR-018), who asks for the student payload (`?view=student`, which can
   * only narrow).
   */
  studentView: boolean;
  /**
   * Drawn above the reader in every state: the student classroom page's
   * compact header and tabs (§5.2), under which the reader is that page's
   * Journal tab. The teacher's page draws its header itself, above.
   */
  header?: ReactNode;
}) {
  const t = useT();
  const toast = useToast();
  const view: View = studentView ? "student" : "staff";
  const base = `/app/api/classrooms/${classroomId}/journal`;
  const narrow = studentView ? "?view=student" : "";

  const journal = useQuery<Journal>({
    queryKey: journalKey(classroomId, view),
    queryFn: () => api(`${base}${narrow}`),
  });
  const data: Journal | undefined = journal.data;
  const staffJournal = data && data.view === "staff" ? data : null;
  // The staff payload says "no journal" by its mode (ADR-057); a student without one gets a 404.
  const hasJournal = data !== undefined && (staffJournal === null || staffJournal.mode !== null);
  const target =
    path ?? (data ? (data.homePath ?? findNode(data.nav, (n) => n.pagePath !== null)?.pagePath ?? null) : null);

  const page = useQuery<JournalPage>({
    queryKey: journalPageKey(classroomId, view, target ?? ""),
    queryFn: () => api(`${base}/pages/${encodeJournalPath(target!)}${narrow}`),
    enabled: hasJournal && target !== null,
    // The page being left stays up, dimmed, until the next one arrives.
    placeholderData: keepPreviousData,
  });

  // The home is shown at its own address, so that the relative links of its
  // HTML resolve for the browser too (a middle click, a copied link).
  useEffect(() => {
    if (path === undefined && target !== null && hasJournal) {
      navigate({ view: "classroomJournal", id: classroomId, path: target }, { replace: true });
    }
  }, [path, target, hasJournal, classroomId, navigate]);

  const hrefOf = (pagePath: string) => routeToPath({ view: "classroomJournal", id: classroomId, path: pagePath });
  const open = (pagePath: string, hash = "") => {
    navigate({ view: "classroomJournal", id: classroomId, path: pagePath });
    if (hash) window.history.replaceState(null, "", `${window.location.pathname}${hash}`);
  };

  const repository = staffJournal?.repository ?? null;
  const { refresh, refreshing } = useJournalRefresh(classroomId, repository, (error) =>
    toast(journalErrorText(error, t), "error"),
  );

  // The staff's writes, Quiz mode only (ADR-057): the editor swaps the page
  // on this very route, by local state, and is left as soon as another page
  // is on view. The history and the deleted pages are sheets over the page.
  const confirm = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sheet, setSheet] = useState<"history" | "deleted" | null>(null);
  /** Bumped by the conflict's reload: the editor reopens on the page as read again. */
  const [reloads, setReloads] = useState(0);
  const remove = useJournalDeletePage(classroomId);
  useEffect(() => {
    if (editing !== null && editing !== target) setEditing(null);
  }, [editing, target]);
  const staffPage: JournalPageStaff | null =
    page.data?.view === "staff" && !page.isPlaceholderData && page.data.path === target ? page.data : null;
  const editingPage = editing !== null && staffPage !== null && editing === staffPage.path ? staffPage : null;

  const deletePage = async (doomed: JournalPageStaff) => {
    const ok = await confirm({
      title: t("journalPage.deleteConfirm", { name: doomed.title ?? doomed.path }),
      message: t("journalPage.deleteBody", { path: doomed.path }),
      confirmLabel: t("journalPage.deleteAction"),
      danger: true,
    });
    if (!ok) return;
    remove.mutate(doomed.path, {
      onSuccess: () => {
        toast(t("journalPage.deleted"), "success");
        navigate({ view: "classroomJournal", id: classroomId }, { replace: true });
      },
      onError: (error) => toast(journalErrorText(error, t), "error"),
    });
  };

  /** The table of contents has a column of its own from 1280 px; above the page below that. */
  const tocBeside = useMinWidth(1280);

  if (journal.isPending) return <ReaderSkeleton header={outerHeader} />;

  const staffBar = (
    <>
      {staffJournal?.mode === "github" ? (
        <GithubBar
          repository={repository}
          refreshing={refreshing}
          onRefresh={refresh}
          editUrl={staffPage?.editUrl ?? null}
        />
      ) : null}
      {staffJournal?.mode === "quiz" ? (
        <QuizBar
          page={staffPage}
          deleting={remove.isPending}
          onEdit={() => setEditing(staffPage?.path ?? null)}
          onAdd={() => setAdding(true)}
          onDelete={(doomed) => void deletePage(doomed)}
          onHistory={() => setSheet("history")}
          onDeleted={() => setSheet("deleted")}
        />
      ) : null}
      {sheet === "history" && staffPage ? (
        <HistorySheet
          classroomId={classroomId}
          path={staffPage.path}
          title={staffPage.title}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "deleted" ? (
        <DeletedSheet
          classroomId={classroomId}
          onClose={() => setSheet(null)}
          onRestored={(restored) => {
            setSheet(null);
            navigate({ view: "classroomJournal", id: classroomId, path: restored });
          }}
        />
      ) : null}
      {adding ? (
        <AddPageDialog
          classroomId={classroomId}
          folder={target ? pageFolder(target) : ""}
          onClose={() => setAdding(false)}
          onAdded={(added) => {
            setAdding(false);
            toast(t("journalPage.added"), "success");
            setEditing(added);
            navigate({ view: "classroomJournal", id: classroomId, path: added });
          }}
        />
      ) : null}
    </>
  );
  const header = (
    <>
      {outerHeader}
      {staffBar}
    </>
  );

  if (journal.isError) {
    if (isNotFound(journal.error)) {
      return (
        <Frame header={header}>
          <EmptyState icon={BookOpen} titleAs="h1" title={t("journal.notFound")}>
            {t("journal.notFoundHint")}
          </EmptyState>
        </Frame>
      );
    }
    return (
      <Frame header={header}>
        <PageError
          title={t("journal.loadError")}
          error={journal.error}
          onRetry={() => void journal.refetch()}
          retrying={journal.isFetching}
        />
      </Frame>
    );
  }

  if (!hasJournal) {
    return (
      <Frame header={header}>
        <EmptyState icon={BookOpen} titleAs="h1" title={t("journal.none")}>
          {t("journal.noneHint")}
        </EmptyState>
      </Frame>
    );
  }

  const loaded = journal.data;
  const syncAlert =
    repository?.syncStatus === "error" ? (
      <Alert tone="danger" icon={AlertTriangle} title={t("journal.sync.errorTitle")}>
        {repository.syncError ? `${t(SYNC_ERRORS[repository.syncError])} ` : ""}
        {t("journal.sync.errorHint")}
      </Alert>
    ) : null;

  if (target === null) {
    let emptyHint: "journal.emptyHint.quiz" | "journal.emptyHint.staff" | "journal.emptyHint" = "journal.emptyHint";
    if (staffJournal?.mode === "quiz") emptyHint = "journal.emptyHint.quiz";
    else if (staffJournal) emptyHint = "journal.emptyHint.staff";
    return (
      <Frame header={header}>
        {syncAlert}
        <EmptyState
          icon={BookOpen}
          titleAs="h1"
          title={t("journal.empty")}
          action={
            staffJournal?.mode === "quiz" ? (
              <Button variant="secondary" onClick={() => setAdding(true)}>
                <FilePlus /> {t("journalPage.add")}
              </Button>
            ) : undefined
          }
        >
          {t(emptyHint)}
        </EmptyState>
      </Frame>
    );
  }

  const strip = (
    <JournalStrip
      nodes={loaded.nav}
      homePath={loaded.homePath}
      current={target}
      hiddenPaths={new Set(staffJournal?.hiddenPaths ?? [])}
      hrefOf={hrefOf}
      onOpen={(p) => open(p)}
    />
  );

  /**
   * The rows above the page (the caller's header, the strip, `bar`), then the
   * page centred, its table of contents beside it or above it. The editor has
   * none: it would go stale as the teacher types.
   */
  const columns = (bar: ReactNode, main: ReactNode, withToc: boolean) => {
    const toc = withToc && page.data ? tocEntries(page.data.toc) : [];
    return (
      <Frame
        header={
          <>
            {outerHeader}
            {strip}
            {bar}
          </>
        }
      >
        {syncAlert}
        {/* From 1280 px the TOC's column is kept even empty: the page stays in place from one page to the next. */}
        <div className={cx("mx-auto", tocBeside ? "grid max-w-[63rem] grid-cols-[minmax(0,1fr)_13rem] gap-8" : "max-w-3xl")}>
          <div className="min-w-0 space-y-4">
            {toc.length > 0 && !tocBeside ? (
              <TocDisclosure>
                <JournalToc entries={toc} titled={false} />
              </TocDisclosure>
            ) : null}
            {main}
          </div>
          {toc.length > 0 && tocBeside ? (
            <aside className="sticky top-8 max-h-[calc(100dvh-4rem)] self-start overflow-y-auto">
              <JournalToc entries={toc} />
            </aside>
          ) : null}
        </div>
      </Frame>
    );
  };

  if (editingPage) {
    return (
      // The editor is loaded on Edit, never with the reader: Tiptap, marked
      // and yaml stay out of what a student downloads.
      <Suspense fallback={columns(staffBar, <ArticleSkeleton />, false)}>
        <JournalEditor
          key={`${editingPage.path}:${reloads}`}
          classroomId={classroomId}
          page={editingPage}
          onClose={() => setEditing(null)}
          onReload={() => void page.refetch().then(() => setReloads((n) => n + 1))}
        >
          {(bar, body) => columns(bar, body, false)}
        </JournalEditor>
      </Suspense>
    );
  }

  return columns(
    staffBar,
    <PageSlot
      page={page}
      classroomId={classroomId}
      onOpen={open}
      onHome={loaded.homePath && loaded.homePath !== target ? () => open(loaded.homePath!) : null}
    />,
    true,
  );
}

/** The page's place beside the navigation: loading, not found, failed, or the page. */
function PageSlot({
  page,
  classroomId,
  onOpen,
  onHome,
}: {
  page: UseQueryResult<JournalPage>;
  classroomId: string;
  onOpen: (pagePath: string, hash: string) => void;
  /** Back to the journal's home, when the page is not it. */
  onHome: (() => void) | null;
}) {
  const t = useT();
  if (page.isPending) return <ArticleSkeleton />;
  if (page.isError) {
    if (!isNotFound(page.error)) {
      return (
        <QueryError
          title={t("journal.pageError")}
          error={page.error}
          onRetry={() => void page.refetch()}
          retrying={page.isFetching}
        />
      );
    }
    return (
      <EmptyState
        icon={FileQuestion}
        titleAs="h1"
        title={t("journal.pageNotFound")}
        action={
          onHome ? (
            <Button variant="secondary" onClick={onHome}>
              {t("journal.backHome")}
            </Button>
          ) : undefined
        }
      >
        {t("journal.pageNotFoundHint")}
      </EmptyState>
    );
  }
  return <PageBody page={page.data} classroomId={classroomId} stale={page.isPlaceholderData} onOpen={onOpen} />;
}

/** The header row and what follows it, 24 px apart (DESIGN.md › Spacing). */
function Frame({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-6">
      {header}
      {children}
    </div>
  );
}

/*
 * The staff's bar above the page, one per journal mode (ADR-057), chosen by
 * the mode at the call site. A student's payload has no mode, so no bar.
 */

/**
 * GitHub mode, read-only in the platform: where the copy of the repository
 * stands, Refresh (F-JRN-05, secondary), and **Edit on GitHub**, the bar's
 * one primary: github.com's editor of the page's file, in a new tab.
 */
function GithubBar({
  repository,
  refreshing,
  onRefresh,
  editUrl,
}: {
  repository: JournalRepository | null;
  refreshing: boolean;
  onRefresh: () => void;
  /** The page on view's `editUrl`, null when no page is. */
  editUrl: string | null;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
      {repository ? <SyncState repository={repository} refreshing={refreshing} /> : null}
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" loading={refreshing} onClick={onRefresh}>
          {refreshing ? null : <RefreshCw />} {t("journal.refresh")}
        </Button>
        {editUrl ? (
          <LinkButton variant="primary" size="sm" href={editUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink /> {t("journalEditor.editOnGithub")}
            <span className="sr-only"> {t("common.newTab")}</span>
          </LinkButton>
        ) : (
          <Button size="sm" disabled>
            <ExternalLink /> {t("journalEditor.editOnGithub")}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Quiz mode: the Pages menu (add a page, this page's history, the deleted
 * pages, delete this page) and **Edit**, the bar's one primary, which opens
 * the editor on this route.
 */
function QuizBar({
  page,
  deleting,
  onEdit,
  onAdd,
  onDelete,
  onHistory,
  onDeleted,
}: {
  /** The page on view, when one is. */
  page: JournalPageStaff | null;
  deleting: boolean;
  onEdit: () => void;
  onAdd: () => void;
  onDelete: (page: JournalPageStaff) => void;
  onHistory: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
      <div className="flex items-center gap-2">
        <Actions
          size="sm"
          menu
          label={t("journalPage.actions")}
          items={[
            { label: t("journalPage.add"), icon: FilePlus, onSelect: onAdd },
            { label: t("journalHistory.open"), icon: History, disabled: page === null, onSelect: onHistory },
            { label: t("journalDeleted.open"), icon: FileClock, onSelect: onDeleted },
            {
              label: t("journalPage.delete"),
              icon: Trash2,
              danger: true,
              separator: true,
              disabled: page === null || deleting,
              onSelect: () => (page ? onDelete(page) : undefined),
            },
          ]}
        />
        <Button size="sm" disabled={page === null} onClick={onEdit}>
          <Pencil /> {t("journalEditor.edit")}
        </Button>
      </div>
    </div>
  );
}

/** The page: the staff's badges and warnings, then the document. */
function PageBody({
  page,
  classroomId,
  stale,
  onOpen,
}: {
  page: JournalPage;
  classroomId: string;
  /** The page being left, shown while the next one loads. */
  stale: boolean;
  onOpen: (pagePath: string, hash: string) => void;
}) {
  const t = useT();
  // The title is the document's own `h1` when it has one; a page titled by
  // its front matter alone gets it here, as React text (plain by contract).
  const ownTitle = page.title !== null && !/<h1[\s>]/i.test(page.html);
  return (
    <>
      {page.view === "staff" ? (
        <>
          {page.draft || (page.hidden && page.visibleFrom) ? (
            <div className="flex flex-wrap items-center gap-2">
              {page.draft ? (
                <Badge tone="zinc" icon={EyeOff}>
                  {t("journal.draft")}
                </Badge>
              ) : null}
              {page.hidden && page.visibleFrom ? (
                <Badge tone="amber" icon={CalendarClock}>
                  {t("journal.visibleFrom", { date: isoDateTime(page.visibleFrom) })}
                </Badge>
              ) : null}
            </div>
          ) : null}
          {page.warnings.length > 0 ? (
            <Alert tone="warning" icon={AlertTriangle} title={t("journal.warnings")}>
              <ul className="list-disc space-y-0.5 pl-4">
                {page.warnings.map((w, i) => (
                  <li key={i}>{warningText(w, t)}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </>
      ) : null}
      <article
        aria-busy={stale || undefined}
        className={cx(
          "rounded-card border border-line bg-surface px-5 py-6 transition-opacity sm:px-10 sm:py-8",
          stale && "opacity-60",
        )}
      >
        {ownTitle ? (
          <h1 className="mb-3 text-[28px] font-bold leading-tight tracking-[-0.02em]">{page.title}</h1>
        ) : null}
        <JournalArticle html={page.html} classroomId={classroomId} pagePath={page.path} onOpen={onOpen} />
      </article>
    </>
  );
}

/** Below `xl`, the table of contents folds above the page; a link followed from it folds it again. */
function TocDisclosure({ children }: { children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className="rounded-card border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] font-medium text-fg-muted"
      >
        <span className="min-w-0 flex-1">{t("journal.toc")}</span>
        <ChevronDown className={cx("size-4 shrink-0 text-fg-faint transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div
          id={panel}
          className="border-t border-line px-2 py-3"
          onClick={(e) => {
            if ((e.target as Element).closest("a")) setOpen(false);
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function ArticleSkeleton() {
  return (
    <div className="space-y-3 rounded-card border border-line bg-surface px-5 py-6 sm:px-10 sm:py-8">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  );
}

/**
 * `role="status"` sits on the placeholder, not on the whole: a caller's
 * `header` is live content (a breadcrumb, tabs), and a status region is
 * announced as a whole and holds no controls.
 */
function ReaderSkeleton({ header }: { header: ReactNode }) {
  const t = useT();
  return (
    <div className="space-y-6">
      {header ?? <Skeleton className="h-4 w-40" />}
      <div className="space-y-6" role="status" aria-label={t("common.loading")}>
        <div className="flex gap-2">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-24" />
        </div>
        <div className="mx-auto max-w-3xl">
          <ArticleSkeleton />
        </div>
      </div>
    </div>
  );
}
