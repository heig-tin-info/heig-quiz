import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  EyeOff,
  FileQuestion,
  Pencil,
  RefreshCw,
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
  Tip,
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
 *   `accent-soft` chip). A student has no primary action here; the staff's
 *   Edit is the one accent control, inside a page.
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

/** The first page of the navigation, depth first: the journal's front when it has no home page. */
function firstPage(nodes: JournalNavNode[]): string | null {
  for (const node of nodes) {
    if (node.pagePath !== null) return node.pagePath;
    const inner = firstPage(node.children);
    if (inner !== null) return inner;
  }
  return null;
}

/** The navigation's title of a page, when it names it. */
function navTitle(nodes: JournalNavNode[], pagePath: string): string | null {
  for (const node of nodes) {
    if (node.pagePath === pagePath) return node.title;
    const inner = navTitle(node.children, pagePath);
    if (inner !== null) return inner;
  }
  return null;
}

/** The navigation column beside the article; the TOC's column too from `xl`. */
const GRID = "grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8";
const GRID_XL = "xl:grid-cols-[15rem_minmax(0,1fr)_13rem]";

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
  const target = path ?? (data ? (data.homePath ?? firstPage(data.nav)) : null);

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

  if (journal.isPending) return <ReaderSkeleton wide={wide} extraWide={extraWide} />;

  const header = (
    <ReaderHeader
      onClassroom={() => navigate({ view: "classroom", id: classroomId })}
      actions={
        staffJournal?.repository ? (
          <StaffActions repository={staffJournal.repository} canEdit={page.data !== undefined} />
        ) : null
      }
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
      : (navTitle(loaded.nav, target) ?? page.data?.title ?? t("journal.untitled"));

  return (
    <Frame header={header}>
      {syncAlert}
      <div className={cx(GRID, extraWide && GRID_XL)}>
        {wide ? (
          <aside className="space-y-8 lg:sticky lg:top-8 lg:max-h-[calc(100dvh-4rem)] lg:self-start lg:overflow-y-auto">
            {nav}
            {extraWide ? null : toc}
          </aside>
        ) : (
          <PhoneDisclosure title={currentTitle}>
            {nav}
            {toc}
          </PhoneDisclosure>
        )}

        <div className="min-w-0 space-y-4">
          {page.isPending ? (
            <ArticleSkeleton />
          ) : page.isError ? (
            isNotFound(page.error) ? (
              <EmptyState
                icon={FileQuestion}
                titleAs="h1"
                title={t("journal.pageNotFound")}
                action={
                  loaded.homePath && loaded.homePath !== target ? (
                    <Button variant="secondary" onClick={() => open(loaded.homePath!)}>
                      {t("journal.backHome")}
                    </Button>
                  ) : undefined
                }
              >
                {t("journal.pageNotFoundHint")}
              </EmptyState>
            ) : (
              <QueryError
                title={t("journal.pageError")}
                error={page.error}
                onRetry={() => void page.refetch()}
                retrying={page.isFetching}
              />
            )
          ) : (
            <PageBody
              page={page.data}
              classroomId={classroomId}
              stale={page.isPlaceholderData}
              onOpen={open}
            />
          )}
        </div>

        {wide && extraWide && toc ? (
          <aside className="lg:sticky lg:top-8 lg:max-h-[calc(100dvh-4rem)] lg:self-start lg:overflow-y-auto">
            {toc}
          </aside>
        ) : null}
      </div>
    </Frame>
  );
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
 * and, for the staff, what they can do about the journal. No title: the
 * document owns it.
 */
function ReaderHeader({ onClassroom, actions }: { onClassroom: () => void; actions: ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <nav aria-label={t("journal.crumb")} className="flex items-center gap-1.5 text-[13px] text-fg-muted">
        <ParentLink onClick={onClassroom}>{t("journal.classroom")}</ParentLink>
        <ChevronRight className="size-3.5 text-fg-faint" aria-hidden />
        <span className="text-fg">{t("journal.crumb")}</span>
      </nav>
      {actions}
    </div>
  );
}

/**
 * The staff's controls: the sync state, Refresh (secondary) and, inside a
 * page, Edit (primary). The writes arrive with the journal's settings and
 * editor (M4-05, M4-06): until then both buttons are shown disabled, with
 * a tooltip saying they are coming, so the layout they will take is the
 * one already on screen.
 */
function StaffActions({ repository, canEdit }: { repository: JournalRepository; canEdit: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <SyncState repository={repository} />
      <Tip label={t("soon.title")}>
        <Button variant="secondary" size="sm" disabled>
          <RefreshCw /> {t("journal.refresh")}
        </Button>
      </Tip>
      {canEdit ? (
        <Tip label={t("soon.title")}>
          <Button variant="primary" size="sm" disabled>
            <Pencil /> {t("journal.edit")}
          </Button>
        </Tip>
      ) : null}
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

function ReaderSkeleton({ wide, extraWide }: { wide: boolean; extraWide: boolean }) {
  const t = useT();
  return (
    <div className="space-y-6" role="status" aria-label={t("common.loading")}>
      <Skeleton className="h-4 w-40" />
      <div className={cx(GRID, extraWide && GRID_XL)}>
        {wide ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-6 w-36" />
          </div>
        ) : (
          <Skeleton className="h-14 w-full" />
        )}
        <ArticleSkeleton />
      </div>
    </div>
  );
}
