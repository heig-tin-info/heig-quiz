import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  EyeOff,
  FileQuestion,
} from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import {
  encodeJournalPath,
  type Journal,
  type JournalNavNode,
  type JournalPage,
  type JournalRepository,
} from "@quiz/contracts";

import { api, ApiError } from "../api";
import { useT } from "../i18n";
import { journalKey, journalPageKey } from "../queryKeys";
import { routeToPath, type Navigate } from "../router";
import {
  Alert,
  Badge,
  Button,
  cx,
  EmptyState,
  isoDateTime,
  PageError,
  ParentLink,
  QueryError,
  RelativeTime,
  Skeleton,
  useMinWidth,
} from "../ui";
import { JournalArticle } from "./JournalArticle";
import { JournalNav } from "./JournalNav";
import { JournalToc } from "./JournalToc";
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
 *   `accent-soft` chip). A student has no primary action here. The staff's
 *   Edit (primary, inside a page) and Refresh arrive with M4-05 and M4-06.
 * - Space: 2 between navigation rows, 32 between the columns, 24 under the
 *   header; the prose has its own rhythm (1.75 leading, 72 ch).
 * - Finish: the page is a sheet of paper (`surface`, hairline, card radius)
 *   on the canvas; the navigation and the TOC are bare columns. No shadow.
 *
 * Layout: from `lg` a 15 rem navigation column beside the article, the TOC
 * under the navigation, at the right from `xl`; on a phone the navigation
 * (and the TOC) fold into a disclosure above the page.
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
}) {
  const t = useT();
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

  const wide = useMinWidth(1024);
  const extraWide = useMinWidth(1280);
  const layout: Layout = extraWide ? "extraWide" : wide ? "wide" : "phone";

  if (journal.isPending) return <ReaderSkeleton layout={layout} />;

  const header = (
    <ReaderHeader
      onClassroom={() => navigate({ view: "classroom", id: classroomId })}
      aside={staffJournal?.repository ? <SyncState repository={staffJournal.repository} /> : null}
    />
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
      <PageError
        title={t("journal.loadError")}
        error={journal.error}
        onRetry={() => void journal.refetch()}
        retrying={journal.isFetching}
      />
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
  const repository = staffJournal?.repository ?? null;
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

  return (
    <Frame header={header}>
      {syncAlert}
      <div className={GRID[layout]}>
        {layout === "phone" ? (
          <PhoneDisclosure title={currentTitle}>
            {nav}
            {toc}
          </PhoneDisclosure>
        ) : (
          <aside className={cx("space-y-8", SIDE_COLUMN)}>
            {nav}
            {layout === "wide" ? toc : null}
          </aside>
        )}

        <div className="min-w-0 space-y-4">
          <PageSlot
            page={page}
            classroomId={classroomId}
            onOpen={open}
            onHome={loaded.homePath && loaded.homePath !== target ? () => open(loaded.homePath!) : null}
          />
        </div>

        {layout === "extraWide" && toc ? <aside className={SIDE_COLUMN}>{toc}</aside> : null}
      </div>
    </Frame>
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
 * The compact header: where the reader is (the classroom, then the journal)
 * and, for the staff, where the copy of the repository stands. No title: the
 * document owns it. The staff's actions (Edit, Refresh) join `aside` with
 * M4-05 and M4-06.
 */
function ReaderHeader({ onClassroom, aside }: { onClassroom: () => void; aside: ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <nav aria-label={t("journal.breadcrumb")} className="flex items-center gap-1.5 text-[13px] text-fg-muted">
        <ParentLink onClick={onClassroom}>{t("journal.classroom")}</ParentLink>
        <ChevronRight className="size-3.5 text-fg-faint" aria-hidden />
        <span className="text-fg">{t("journal.crumb")}</span>
      </nav>
      {aside}
    </div>
  );
}

/** Where the copy of the repository stands: synced when, being read, or failed (the alert says why). */
function SyncState({ repository }: { repository: JournalRepository }) {
  const t = useT();
  const text =
    repository.syncStatus === "pending" ? (
      t("journal.sync.pending")
    ) : repository.syncStatus === "error" ? (
      <span className="text-danger">{t("journal.sync.errorTitle")}</span>
    ) : repository.lastSyncedAt ? (
      <>
        {t("journal.sync.ok")} <RelativeTime iso={repository.lastSyncedAt} />
      </>
    ) : (
      t("journal.sync.never")
    );
  return <p className="text-xs text-fg-faint">{text}</p>;
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

function ReaderSkeleton({ layout }: { layout: Layout }) {
  const t = useT();
  return (
    <div className="space-y-6" role="status" aria-label={t("common.loading")}>
      <Skeleton className="h-4 w-40" />
      <div className={GRID[layout]}>
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
