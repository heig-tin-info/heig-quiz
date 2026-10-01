import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  ChevronDown,
  EyeOff,
  FilePlus,
  FileQuestion,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

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
  PageError,
  QueryError,
  Skeleton,
  useMinWidth,
} from "../ui";
import { journalErrorText, useJournalDeletePage, useJournalRefresh } from "./api";
import { AddPageDialog } from "./editor/AddPageDialog";
import { pageFolder } from "./editor/images";
import { JournalEditor } from "./editor/JournalEditor";
import { JournalArticle } from "./JournalArticle";
import { JournalNav } from "./JournalNav";
import { JournalToc } from "./JournalToc";
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
 *   `.md-doc`; the navigation is 13 px dense UI. No page title above it: two
 *   `h1`s on one screen and neither wins.
 * - Color: ONE accent, the page being read in the navigation (an
 *   `accent-soft` chip). A student has no primary action here. The staff
 *   have Refresh (secondary, M4-05) in their bar above the page; Edit
 *   (primary, inside a page) joins it with M4-06.
 * - Space: 2 between navigation rows, 32 between the columns, 24 under the
 *   header; the prose has its own rhythm (1.75 leading, 72 ch).
 * - Finish: the page is a sheet of paper (`surface`, hairline, card radius)
 *   on the canvas; the navigation and the TOC are bare columns. No shadow.
 *
 * Layout: from `lg` a 15 rem navigation column beside the article, the TOC
 * under the navigation, at the right from `xl`; on a phone the navigation
 * (and the TOC) fold into a disclosure above the page.
 *
 * The reader is always some page's tab: the teacher classroom page's Journal
 * tab (`ClassroomView`, M4-05) or the student classroom page's (M5-02, whose
 * compact header comes in as `header`). It draws no breadcrumb of its own.
 */

type View = "staff" | "student";

/** The first node of the navigation, depth first, that `pred` accepts. */
function findNode(nodes: JournalNavNode[], pred: (node: JournalNavNode) => boolean): JournalNavNode | null {
  for (const node of nodes) {
    if (pred(node)) return node;
    const inner = findNode(node.children, pred);
    if (inner !== null) return inner;
  }
  return null;
}

/**
 * The columns, decided once in JS (`useMinWidth`) rather than again in CSS:
 * the navigation (and the TOC) beside the article from 1024 px, the TOC in
 * a column of its own from 1280 px, one column below 1024 px.
 */
const GRID = {
  phone: "grid gap-6",
  wide: "grid grid-cols-[15rem_minmax(0,1fr)] gap-8",
  extraWide: "grid grid-cols-[15rem_minmax(0,1fr)_13rem] gap-8",
} as const;
type Layout = keyof typeof GRID;

/** A column beside the article: it stays in view while the page scrolls. */
const SIDE_COLUMN = "sticky top-8 max-h-[calc(100dvh-4rem)] self-start overflow-y-auto";

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
  const hasJournal = data !== undefined && (staffJournal === null || staffJournal.repository !== null);
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

  // The staff's writes (M4-06): the editor swaps the page on this very route,
  // by local state, and is left as soon as another page is on view.
  const confirm = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
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

  const wide = useMinWidth(1024);
  const extraWide = useMinWidth(1280);
  const layout: Layout = extraWide ? "extraWide" : wide ? "wide" : "phone";

  if (journal.isPending) return <ReaderSkeleton layout={layout} header={outerHeader} />;

  const header = (
    <>
      {outerHeader}
      {repository ? (
        <StaffBar
          repository={repository}
          refreshing={refreshing}
          onRefresh={refresh}
          page={staffPage}
          deleting={remove.isPending}
          onEdit={() => setEditing(staffPage?.path ?? null)}
          onAdd={() => setAdding(true)}
          onDelete={(doomed) => void deletePage(doomed)}
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
    return (
      <Frame header={header}>
        {syncAlert}
        <EmptyState icon={BookOpen} titleAs="h1" title={t("journal.empty")}>
          {staffJournal ? t("journal.emptyHint.staff") : t("journal.emptyHint")}
        </EmptyState>
      </Frame>
    );
  }

  const hiddenPaths = new Set(staffJournal?.hiddenPaths ?? []);
  const nav = (
    <nav aria-label={t("journal.nav")}>
      <JournalNav
        nodes={loaded.nav}
        homePath={loaded.homePath}
        current={target}
        hiddenPaths={hiddenPaths}
        hrefOf={hrefOf}
        onOpen={(p) => open(p)}
      />
    </nav>
  );
  const toc = page.data ? <JournalToc toc={page.data.toc} /> : null;
  const currentTitle =
    target === loaded.homePath
      ? t("journal.home")
      : (findNode(loaded.nav, (n) => n.pagePath === target)?.title ?? page.data?.title ?? t("journal.untitled"));

  /** The columns around `main`; the editor has no table of contents (it would go stale as it types). */
  const columns = (frameHeader: ReactNode, main: ReactNode, withToc: boolean) => {
    const grid: Layout = !withToc && layout === "extraWide" ? "wide" : layout;
    const sideToc = withToc ? toc : null;
    return (
      <Frame header={frameHeader}>
        {syncAlert}
        <div className={GRID[grid]}>
          {grid === "phone" ? (
            <PhoneDisclosure title={currentTitle}>
              {nav}
              {sideToc}
            </PhoneDisclosure>
          ) : (
            <aside className={cx("space-y-8", SIDE_COLUMN)}>
              {nav}
              {grid === "wide" ? sideToc : null}
            </aside>
          )}

          <div className="min-w-0 space-y-4">{main}</div>

          {grid === "extraWide" && sideToc ? <aside className={SIDE_COLUMN}>{sideToc}</aside> : null}
        </div>
      </Frame>
    );
  };

  if (editingPage) {
    return (
      <JournalEditor
        key={`${editingPage.path}:${reloads}`}
        classroomId={classroomId}
        page={editingPage}
        onClose={() => setEditing(null)}
        onReload={() =>
          void page.refetch().then(() => setReloads((n) => n + 1))
        }
      >
        {(bar, body) =>
          columns(
            <>
              {outerHeader}
              {bar}
            </>,
            body,
            false,
          )
        }
      </JournalEditor>
    );
  }

  return columns(
    header,
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

/**
 * The staff's bar above the page: where the copy of the repository stands,
 * Refresh (F-JRN-05, secondary), add and delete a page (two icon buttons),
 * and Edit, the primary inside a page (M4-06). The writes wait for a copy
 * that knows the head it writes over (`editable`); a student's payload has
 * no repository, so no bar.
 */
function StaffBar({
  repository,
  refreshing,
  onRefresh,
  page,
  deleting,
  onEdit,
  onAdd,
  onDelete,
}: {
  repository: JournalRepository;
  refreshing: boolean;
  onRefresh: () => void;
  /** The page on view, when one is. */
  page: JournalPageStaff | null;
  deleting: boolean;
  onEdit: () => void;
  onAdd: () => void;
  onDelete: (page: JournalPageStaff) => void;
}) {
  const t = useT();
  const writable = repository.editable;
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
      <SyncState repository={repository} refreshing={refreshing} />
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" loading={refreshing} onClick={onRefresh}>
          {refreshing ? null : <RefreshCw />} {t("journal.refresh")}
        </Button>
        <Actions
          size="sm"
          label={t("journalPage.actions")}
          items={[
            { label: t("journalPage.add"), icon: FilePlus, disabled: !writable, onSelect: onAdd },
            {
              label: t("journalPage.delete"),
              icon: Trash2,
              danger: true,
              disabled: !writable || page === null || deleting,
              onSelect: () => (page ? onDelete(page) : undefined),
            },
          ]}
        />
        <Button size="sm" disabled={!writable || page === null} onClick={onEdit}>
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

/** On a phone, the navigation folds above the page, named by the page being read. */
function PhoneDisclosure({ title, children }: { title: string; children: ReactNode }) {
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
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-fg-faint">{t("journal.pages")}</span>
          <span className="block truncate text-sm font-medium">{title}</span>
        </span>
        <ChevronDown className={cx("size-4 shrink-0 text-fg-faint transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        // Any link followed from the panel (a page, a heading) folds it again.
        <div
          id={panel}
          className="space-y-6 border-t border-line px-2 py-3"
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
function ReaderSkeleton({ layout, header }: { layout: Layout; header: ReactNode }) {
  const t = useT();
  return (
    <div className="space-y-6">
      {header ?? <Skeleton className="h-4 w-40" />}
      <div className={GRID[layout]} role="status" aria-label={t("common.loading")}>
        {layout === "phone" ? (
          <Skeleton className="h-14 w-full" />
        ) : (
          <div className="space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-6 w-36" />
          </div>
        )}
        <ArticleSkeleton />
      </div>
    </div>
  );
}
