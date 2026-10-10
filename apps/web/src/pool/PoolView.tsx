import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BellPlus,
  Eye,
  ListChecks,
  Plus,
  ScanSearch,
  Settings as SettingsIcon,
  StarOff,
  Tags,
} from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";


import type { CategoryNode, PoolQuestionStats, QuestionPage, QuestionRow } from "@quiz/contracts";
import { poolRoleAllows, type POOL_TABS } from "@quiz/domain";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useToast } from "../notify";
import { useT } from "../i18n";
import { QUESTION_TYPE_IDS, typeIcon, typeLabel } from "../questionTypes";
import type { Route } from "../router";
import { useSearchParam } from "../router";
import { Trail, useRootCrumb } from "../Trail";
import { useScreenCommands } from "../screenCommands";
import { useShortcuts } from "../shortcuts";
import {
  Actions,
  ASIDE_MIN_WIDTH,
  Badge,
  Button,
  pageBox,
  PANE_GAP,
  PageError,
  PageHeader,
  PageSkeleton,
  QueryError,
  useCoarsePointer,
  useMinWidth,
  usePersistentChoice,
  TabPanel,
  Tabs,
} from "../ui";
import { BulkBar } from "./BulkBar";
import { categoryPaths, findCategory } from "./categories";
import { setQuestionDrag } from "./move";
import {
  EMPTY_FILTERS,
  NO_FILTERS,
  hasStatsFilter,
  matchesStats,
  questionQuery,
  type QuestionFilters,
  type QuestionSort,
} from "./filters";
import { FilterBar, type ListView } from "./FilterBar";
import { parseSearch } from "./searchSyntax";
import { NewQuestionModal } from "./NewQuestionModal";
import { PoolEmpty, PoolListSkeleton, PoolListTail } from "./PoolListStates";
import { QuestionCards } from "./QuestionCards";
import { groupQuestions, isGroupBy, type GroupBy } from "./QuestionGroups";
import { QuestionStatsSheet } from "./QuestionStatsSheet";
import { QuestionTable, type StatsFor } from "./QuestionTable";
import { useSetStars, useStarredQuestions } from "./stars";
import { useQuestionBrowse } from "./useQuestionBrowse";
import { QuestionPreview } from "../question/QuestionPreview";
import { useQuestionActions } from "../question/useQuestionActions";
import { useLlmAvailability } from "../llmAvailability";
import { poolKey, poolQuestionStatsKey, poolQuestionsKey } from "../queryKeys";
import { PoolSettings } from "./PoolSettings";
import { usePoolSubscription } from "./subscription";
import { ReviewTab } from "./ReviewTab";
import { ConceptsTab } from "./ConceptsTab";
import { useFilterVocabulary } from "./useFilterVocabulary";
import { usePool } from "./api";

type PoolTab = (typeof POOL_TABS)[number];

/** The search box with an old `?tag=word` typed into it, as `#word` (quoted when it holds a space). */
const withTagWord = (q: string, tag: string): string => {
  if (tag === "") return q;
  const word = /\s/.test(tag) ? `#"${tag}"` : `#${tag}`;
  return q.trim() === "" ? word : `${q} ${word}`;
};

/** `?concept=a,b` → the ids it carries. */
const idsOf = (param: string): string[] => (param === "" ? [] : param.split(",").filter((id) => id !== ""));

/**
 * The pool screen: the questions across the full
 * content width. Clicking a row SHOWS the question as a student reads it;
 * Enter, a double-click and the row's pencil open the editor, and the row
 * carries its three actions (edit, duplicate, delete) at its end.
 *
 * The question shown sits in a master/detail pane, not in a Sheet: the list
 * stays where it is and keeps working (↑/↓ walk it, the pane follows, P shows
 * the focused row). From `ASIDE_MIN_WIDTH` the pane docks to the right and
 * the page widens past its reading cap by exactly the pane's width
 * (`pageBox`); under it, the pane takes the list's place with a Back
 * button, as in the question picker. There is no empty pane: it appears on
 * the first look, and which question it shows is the screen's state, never
 * the URL's.
 *
 * The category tree is NOT here: it lives in the app sidebar, beside the
 * other navigation, and the category it selects travels in the `category`
 * query-string parameter. A tree is navigation, and navigation belongs in
 * one place; the page then keeps its whole width for the table, which is
 * what a screen made of seven columns needs.
 *
 * The "Settings" tab holds the pool's name, icon, sharing, and the ways out
 * of it (`PoolSettings`): the pools list keeps no menu.
 *
 * The "Concepts" tab lists the concepts the pool's questions use, with their
 * counts (`ConceptsTab`); a concept there opens this list filtered on it
 * through the `concept` query-string parameter, which mirrors the ticked
 * concepts (ids, comma-separated), so the link survives a reload and clearing
 * the chip drops it. An address of the tags' time still works: `?tab=tags`
 * is the Concepts tab, and `?tag=word` becomes the typed `#word` of the
 * search box (ADR-081 third addendum §7) — resolved like any typed word, its
 * chip saying so when it names no concept — and leaves the address with the
 * first change of the filters.
 *
 * The ONE primary action is "New question". Importing, exporting and adding
 * to an evaluation are later work packages; nothing else here competes with
 * the single red button.
 *
 * Two readings of the same list — the table and the cards — and four ways of
 * cutting it (`QuestionGroups.ts`). Which one is a HABIT, not a state of the
 * data, so it is remembered per viewer in `localStorage` and never in the URL
 * or on the server; a browser that refuses storage simply starts on the table
 * every time, which is why every access is wrapped.
 *
 * Sorting belongs to the API (`sort` / `dir` of `QuestionSearch`). A page of
 * 25 rows sorted in the browser sorts the rows that happen to be loaded, and
 * "Load more" would then append a second, differently ordered page under the
 * first. Changing the sort therefore changes the query key, which is what
 * makes TanStack drop the cursor and start again at page one. The column
 * headers of the table are the only sort control; the cards follow the same
 * sort, which starts on the newest change and lives as long as the screen.
 *
 * A row (and a card) can be DRAGGED onto a pool, or onto a category of the
 * pool being read, in the application sidebar: that MOVES the question there
 * (ADR-017). The gesture obeys the tick boxes — dragging a ticked row takes
 * the whole selection — and the bulk bar carries the same action for anyone
 * without a mouse.
 *
 * A pool the caller only READS (`PoolDetail.role === "reader"`, F-POOL-05)
 * loses the create, edit, duplicate, delete and bulk actions and the tick
 * boxes that feed them: what is not permitted is not drawn greyed out, it is
 * absent. Looking at a question and opening it still work — the pane is how
 * a reader browses, the editor where a question is read in full — and it is
 * the editor's own business to refuse a save.
 *
 * A question can be STARRED (F-POOL-10): the caller's own favourite, to find
 * it again in the question picker. The star is on every row and card, Space
 * toggles it on the focused one, the bulk bar stars a selection, and "Clear
 * favourites" — an icon on the filter bar's second row, the list's tertiary
 * action, drawn only while the caller has stars in this pool — takes them
 * all off. Starring is a preference, not an
 * edit, so a reader has all of it but the bulk bar, which needs tick boxes.
 *
 * The item analysis (ADR-038) is fetched apart from the rows, in one call for
 * the whole pool: a question with ten answers or more gets a chart icon after
 * its name, which opens its statistics in a side panel — for a reader too;
 * only the reset is kept from them. Statistics that fail to load draw no
 * icon and never hold the list back.
 *
 * The same statistics FILTER the list (F-STAT-03), in the page: the filter
 * sheet's last block bounds the success rate and the median time. A bound
 * can only be judged on every row, so while one is set the screen asks for
 * pages of `STATS_PAGE_SIZE` and follows the cursor to the end by itself —
 * no "Load more" — then counts the rows that pass rather than the API's
 * `total`, which knows nothing of the bounds.
 */

/** The docked question pane's width; the page widens by it (`pageBox`). */
const PANE_WIDTH = "30rem";

const VIEW_KEY = "quiz-pool-view";
const VIEWS: readonly ListView[] = ["cards", "list"];
const GROUP_KEY = "quiz-pool-group";

/**
 * What the list is drawn from, derived once per change of its inputs rather
 * than on every render: the selected category's node, every category's
 * "Parent / Child" path, and the rows cut into the chosen groups. A tally of
 * checked rows or a keystroke in the filter bar re-renders the screen; none of
 * them changes the tree or the page of rows.
 */
function useListing(
  categories: readonly CategoryNode[] | undefined,
  categoryId: string | null,
  rows: QuestionRow[],
  group: GroupBy,
) {
  const t = useT();
  const tree = categories ?? NO_CATEGORIES;
  const category = useMemo(
    () => (categoryId ? findCategory(tree, categoryId) : null),
    [tree, categoryId],
  );
  const paths = useMemo(() => categoryPaths(tree), [tree]);
  const groups = useMemo(
    () =>
      groupQuestions(
        rows,
        group,
        {
          type: (typeId) => typeLabel(t, typeId),
          category: (catId) => paths.find((p) => p.id === catId)?.label ?? catId,
          noConcept: t("pool.group.noConcept"),
          noCategory: t("pool.bulk.root"),
        },
        QUESTION_TYPE_IDS,
        paths.map((p) => p.id),
      ),
    [rows, group, paths, t],
  );
  return { category, groups };
}

const NO_CATEGORIES: readonly CategoryNode[] = [];

export function PoolView({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  // Everything but the category is local to the screen; the category is the
  // sidebar's selection, and "" means "all questions".
  // `?concept=` seeds the concept chips, and the chips write it back.
  // `seenConcept` exists for a `?concept=` that changes while this page
  // stays mounted — an in-app link to `/pools/:id?concept=…` from this very
  // pool (the router's `SEARCH_PARAM_EVENT`) — where the `useState` seed
  // above would not run again: the chips follow the new value.
  // `?q=` is the search box as typed (`searchSyntax.ts`), kept in the
  // address the same way: a reload keeps it, and the assistant opens the
  // pool already searched (`#printf`, ADR-080 P2b).
  const [conceptParam, setConceptParam] = useSearchParam("concept", "");
  const [tagParam, setTagParam] = useSearchParam("tag", "");
  const [qParam, setQParam] = useSearchParam("q", "");
  const [filters, setFilters] = useState<QuestionFilters>(() => ({
    ...EMPTY_FILTERS,
    concepts: idsOf(conceptParam),
    q: withTagWord(qParam, tagParam),
  }));
  const [seenConcept, setSeenConcept] = useState(conceptParam);
  const [seenTag, setSeenTag] = useState(tagParam);
  const [seenQ, setSeenQ] = useState(qParam);
  if (seenConcept !== conceptParam) {
    setSeenConcept(conceptParam);
    setFilters((f) => ({ ...f, concepts: idsOf(conceptParam) }));
  }
  if (seenQ !== qParam) {
    setSeenQ(qParam);
    setFilters((f) => ({ ...f, q: qParam }));
  }
  if (seenTag !== tagParam) {
    setSeenTag(tagParam);
    setFilters((f) => ({ ...f, q: withTagWord(f.q, tagParam) }));
  }
  const applyFilters = (next: QuestionFilters) => {
    setFilters(next);
    setConceptParam(next.concepts.join(","));
    setQParam(next.q);
    // The search box now carries the old tag as `#word`.
    setTagParam("");
  };
  const { vocabulary, waiting } = useFilterVocabulary(filters.q);
  const [categoryParam, setCategory] = useSearchParam("category", "");
  // The "LLM review" tab (ADR-060), offered while the platform has a model.
  const [tabParam, setTab] = useSearchParam("tab", "questions");
  const llm = useLlmAvailability();
  const poolsRoot = useRootCrumb("pools");
  const reviewTab = llm.data?.available === true;
  const tab: PoolTab =
    tabParam === "concepts" || tabParam === "tags"
      ? "concepts"
      : tabParam === "settings"
        ? "settings"
      : tabParam === "review" && reviewTab
        ? "review"
        : "questions";
  const categoryId = categoryParam === "" ? null : categoryParam;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState<{ type: string | null } | null>(null);
  const [view, setView] = usePersistentChoice(VIEW_KEY, VIEWS, "list");
  const [statsRow, setStatsRow] = useState<QuestionRow | null>(null);
  const [group, setGroup] = usePersistentChoice<GroupBy>(GROUP_KEY, isGroupBy, "none");

  const pool = usePool(id);
  const subscription = usePoolSubscription(id);
  const mayWrite = pool.data === undefined || poolRoleAllows(pool.data.role, "contributor");
  const poolConceptIds = useMemo(() => (pool.data?.concepts ?? []).map((c) => c.concept.id), [pool.data]);

  // What this screen adds to the command palette while it is open
  // (docs/spec/08 §8.3): one entry per question type, so an expert never
  // touches the type picker. A reader gets none of them — the palette must
  // not offer what the screen has taken away.
  useScreenCommands(
    mayWrite
      ? QUESTION_TYPE_IDS.map((typeId) => ({
          id: `question:new:${typeId}`,
          // Opens the creation sheet; nothing exists until the teacher saves it.
          effect: "none" as const,
          label: t("palette.newQuestion", { type: typeLabel(t, typeId) }),
          icon: typeIcon(typeId),
          group: "action" as const,
          run: () => setCreating({ type: typeId }),
        }))
      : [],
  );

  const search = useMemo<QuestionFilters>(() => ({ ...filters, categoryId }), [filters, categoryId]);
  // The courses the list can be filtered by (the pool detail's `filterCourses`); a typed `course:` waits for them.
  const courses = pool.data?.filterCourses;
  const courseWaiting = courses === undefined && parseSearch(filters.q).courseWord !== null;
  const query = questionQuery(search, vocabulary, null, courses);
  const questions = useInfiniteQuery<QuestionPage>({
    queryKey: poolQuestionsKey(id, query),
    queryFn: ({ pageParam }) =>
      api(`/app/api/pools/${id}/questions${questionQuery(search, vocabulary, pageParam as string | null, courses)}`),
    enabled: !waiting && !courseWaiting,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const questionStats = useQuery<PoolQuestionStats>({
    queryKey: poolQuestionStatsKey(id),
    queryFn: () => api(`/app/api/pools/${id}/question-stats`),
  });
  const statsById = useMemo(
    () => new Map((questionStats.data?.items ?? []).map((s) => [s.questionId, s])),
    [questionStats.data],
  );
  const statsFor: StatsFor = (row) => (statsById.has(row.id) ? () => setStatsRow(row) : undefined);
  const shownStats = statsRow ? statsById.get(statsRow.id) : undefined;

  const byStats = hasStatsFilter(filters);
  const rows = useMemo(() => {
    const loaded = (questions.data?.pages ?? []).flatMap((page) => page.items);
    return byStats ? loaded.filter((row) => matchesStats(statsById.get(row.id), filters)) : loaded;
  }, [questions.data, byStats, statsById, filters]);
  // A statistics bound judges every row: follow the cursor to the end.
  const { hasNextPage, isFetchingNextPage, isError: listFailed, fetchNextPage } = questions;
  useEffect(() => {
    if (byStats && hasNextPage && !isFetchingNextPage && !listFailed) void fetchNextPage();
  }, [byStats, hasNextPage, isFetchingNextPage, listFailed, fetchNextPage]);
  // Rows filtered by bounds still missing a page or the statistics are not an answer yet.
  const gathering = byStats && (hasNextPage || questionStats.isPending);
  // The count: the rows that pass once all are in under a bound, the API's
  // `total` otherwise; unknown (nothing drawn) meanwhile.
  const apiTotal = questions.data?.pages[0]?.total ?? null;
  const passedTotal = gathering || !questions.data ? null : rows.length;
  const total = byStats ? passedTotal : apiTotal;
  const checkedIds = rows.filter((r) => checked.has(r.id)).map((r) => r.id);

  /**
   * A new column restarts the pagination — the cursor encodes the order it was
   * cut in — and drops the selection, which was made on rows the reader is
   * about to stop seeing in that place. The first click on a column takes the
   * order a reader expects of it: a name ascends, a date starts at the newest.
   */
  /**
   * A concept of the Concepts tab: the whole pool's questions under it — its
   * counts are the pool's, so the category and every other filter go; the
   * sort stays, as it does when the filters are cleared.
   */
  const openConcept = (conceptId: string) => {
    setChecked(new Set());
    applyFilters({ ...filters, ...NO_FILTERS, q: "", concepts: [conceptId] });
    setCategory("");
    setTab("questions");
  };

  const sortBy = (key: QuestionSort) => {
    setChecked(new Set());
    setFilters((f) =>
      f.sort === key
        ? { ...f, dir: f.dir === "asc" ? "desc" : "asc" }
        : { ...f, sort: key, dir: key === "updated" || key === "version" ? "desc" : "asc" },
    );
  };

  const toggleCheck = (questionId: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });

  /**
   * Starting a drag from a row or a card. What travels is the SELECTION when
   * the dragged question is part of it, and that one question otherwise: the
   * gesture obeys what is ticked, exactly as the bulk bar does, and dragging
   * an unticked row never silently takes twenty others with it.
   */
  const startDrag = (event: DragEvent, row: QuestionRow) => {
    const ids = checked.has(row.id) && checkedIds.length > 0 ? checkedIds : [row.id];
    setQuestionDrag(event, {
      questionIds: ids,
      label: ids.length === 1 ? row.internalName : String(ids.length),
    });
  };

  const { duplicate, askDelete } = useQuestionActions(id);
  const confirm = useConfirm();
  const toast = useToast();
  const { setStars, clearAll } = useSetStars(id);
  const toggleStar = (row: QuestionRow) => void setStars([row.id], !row.starred);
  const starredCount = useStarredQuestions(id).data?.total ?? 0;
  const clearFavourites = async () => {
    const ok = await confirm({
      title: t("pool.stars.clearTitle"),
      message: t(starredCount === 1 ? "pool.stars.clearConfirm.one" : "pool.stars.clearConfirm", {
        n: starredCount,
      }),
      confirmLabel: t("pool.stars.clear"),
    });
    if (ok && (await clearAll()) !== null) toast(t("pool.stars.cleared"), "success");
  };
  const { category, groups } = useListing(pool.data?.categories, categoryId, rows, group);
  const edit = (row: QuestionRow) => navigate({ view: "question", id: row.id });
  const docked = useMinWidth(ASIDE_MIN_WIDTH);
  const browse = useQuestionBrowse(groups, edit, docked, useCoarsePointer(), toggleStar);
  const shown = browse.shown;
  // P and Space are the keys of the list the strip cannot guess; the arrows
  // and Enter do what they do everywhere.
  useShortcuts(
    [
      { keys: "P", label: t("question.preview.shortcut") },
      { keys: "Space", label: t("pool.star.shortcut") },
    ],
    rows.length > 0,
  );
  const closeOnEscape = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    browse.close();
  };

  if (pool.isLoading) {
    return <PageSkeleton />;
  }
  if (pool.isError) {
    return (
      <PageError title={t("pools.notFound")} query={pool} />
    );
  }

  const detail = pool.data!;
  // `reader` is the one role that may not write (F-POOL-05).
  const readOnly = !poolRoleAllows(detail.role, "contributor");

  return (
    <div className="w-full space-y-6" style={pageBox(shown && docked ? PANE_WIDTH : null)}>
      <PageHeader
        help="pool"
        eyebrow={
          <Trail navigate={navigate} items={[poolsRoot, { label: detail.pool.name }]} />
        }
        title={detail.pool.name}
        description={
          category
            ? category.name
            : t(detail.questionCount === 1 ? "pools.questions.one" : "pools.questions", {
                n: detail.questionCount,
              })
        }
        actions={
          readOnly ? (
            <Badge tone="zinc" icon={Eye}>
              {t("pool.readOnly")}
            </Badge>
          ) : undefined
        }
        primary={
          // A public pool the caller reads without a seat: following it is
          // the one thing to do here (ADR-095). Else the questions' list
          // only: the other tabs create nothing.
          detail.subscription === "available"
            ? { icon: BellPlus, label: t("pool.subscribe"), onClick: () => subscription.subscribe.mutate() }
            : readOnly || tab !== "questions"
            ? undefined
            : {
                icon: Plus,
                label: t("pool.newQuestion"),
                onClick: () => setCreating({ type: null }),
                coach: "pool.new-question",
              }
        }
      />

      <Tabs<PoolTab>
        value={tab}
        onChange={setTab}
        idPrefix="pool"
        items={[
          { value: "questions", label: t("pool.tab.questions"), icon: ListChecks },
          { value: "concepts", label: t("pool.tab.concepts"), icon: Tags },
          ...(reviewTab
            ? [{ value: "review" as const, label: t("review.title"), icon: ScanSearch }]
            : []),
          { value: "settings", label: t("pool.tab.settings"), icon: SettingsIcon },
        ]}
      />

      {tab === "settings" ? (
        <TabPanel idPrefix="pool" value="settings">
          <PoolSettings detail={detail} navigate={navigate} />
        </TabPanel>
      ) : tab === "review" ? (
        <TabPanel idPrefix="pool" value="review">
          <ReviewTab poolId={id} role={detail.role} navigate={navigate} />
        </TabPanel>
      ) : tab === "concepts" ? (
        <TabPanel idPrefix="pool" value="concepts">
          <ConceptsTab concepts={detail.concepts} onOpenConcept={openConcept} />
        </TabPanel>
      ) : (
      /* Escape closes the pane from anywhere in the list or the pane. */
      <div onKeyDown={closeOnEscape}>
        {shown && !docked ? (
          <div className="space-y-4">
            <Button variant="secondary" size="sm" onClick={browse.close} autoFocus>
              <ArrowLeft /> {t("question.preview.back")}
            </Button>
            <QuestionPreview row={shown} mode="browse" onOpenEditor={() => edit(shown)} />
          </div>
        ) : (
          <div className="flex items-start" style={{ gap: PANE_GAP }}>
            <div className="min-w-0 flex-1 space-y-4">
              <FilterBar
                filters={filters}
                onChange={(next) => {
                  setChecked(new Set());
                  applyFilters(next);
                }}
                concepts={detail.concepts.map((c) => c.concept)}
                vocabulary={vocabulary}
                courses={detail.filterCourses}
                stats={questionStats}
                total={total}
                view={view}
                onView={setView}
                group={group}
                onGroup={setGroup}
                actions={
                  <Actions
                    size="sm"
                    items={
                      starredCount > 0
                        ? [
                            {
                              label: t("pool.stars.clear"),
                              icon: StarOff,
                              onSelect: () => void clearFavourites(),
                            },
                          ]
                        : []
                    }
                  />
                }
              />

              {questions.isLoading || waiting || (gathering && rows.length === 0 && !questions.isError) ? (
                <PoolListSkeleton view={view} />
              ) : questions.isError ? (
                <QueryError title={t("pool.title")} query={questions} />
              ) : rows.length === 0 ? (
                <PoolEmpty
                  questionCount={detail.questionCount}
                  readOnly={readOnly}
                  onCreate={() => setCreating({ type: null })}
                  // The sort is not a filter: clearing what hides the rows must not
                  // also change the order they come back in.
                  onClearFilters={() =>
                    applyFilters({ ...EMPTY_FILTERS, sort: filters.sort, dir: filters.dir })
                  }
                />
              ) : (
                <>
                  {view === "cards" ? (
                    <QuestionCards
                      groups={groups}
                      checked={checked}
                      onToggleCheck={toggleCheck}
                      rowProps={browse.rowProps}
                      onEdit={edit}
                      onDuplicate={(row) => duplicate(row)}
                      onDelete={(row) => void askDelete(row)}
                      onDragStart={readOnly ? undefined : startDrag}
                      readOnly={readOnly}
                      statsFor={statsFor}
                      onStar={toggleStar}
                    />
                  ) : (
                    <QuestionTable
                      groups={groups}
                      checked={checked}
                      onToggleCheck={toggleCheck}
                      onToggleAll={() =>
                        setChecked((prev) =>
                          rows.every((r) => prev.has(r.id))
                            ? new Set()
                            : new Set(rows.map((r) => r.id)),
                        )
                      }
                      rowProps={browse.rowProps}
                      onEdit={edit}
                      onDuplicate={(row) => duplicate(row)}
                      onDelete={(row) => void askDelete(row)}
                      sort={filters.sort}
                      dir={filters.dir}
                      onSort={sortBy}
                      onDragStart={readOnly ? undefined : startDrag}
                      readOnly={readOnly}
                      statsFor={statsFor}
                      onStar={toggleStar}
                    />
                  )}
                  <PoolListTail
                    hasNextPage={hasNextPage && !byStats}
                    fetchingNext={isFetchingNextPage}
                    refetching={
                      (questions.isFetching && !isFetchingNextPage) || (gathering && !listFailed)
                    }
                    onLoadMore={() => void questions.fetchNextPage()}
                  />
                </>
              )}
            </div>
            {shown ? (
              <aside
                aria-label={t("question.preview.show", { name: shown.internalName })}
                style={{ width: PANE_WIDTH }}
                className="sticky top-8 max-h-[calc(100dvh-4rem)] shrink-0 overflow-y-auto rounded-card border border-line bg-surface-2 p-5"
              >
                <QuestionPreview
                  row={shown}
                  mode="browse"
                  onOpenEditor={() => edit(shown)}
                  onClose={browse.close}
                />
              </aside>
            ) : null}
          </div>
        )}
      </div>
      )}

      {checkedIds.length > 0 && !readOnly ? (
        <BulkBar
          poolId={id}
          ids={checkedIds}
          rows={rows}
          categories={detail.categories}
          poolConceptIds={poolConceptIds}
          onStar={setStars}
          onClear={() => setChecked(new Set())}
        />
      ) : null}

      {statsRow !== null && shownStats ? (
        <QuestionStatsSheet
          poolId={id}
          row={statsRow}
          stats={shownStats}
          canReset={!readOnly}
          onClose={() => setStatsRow(null)}
        />
      ) : null}

      {creating !== null ? (
        <NewQuestionModal
          poolId={id}
          categoryId={categoryId}
          initialType={creating.type}
          onClose={() => setCreating(null)}
          onCreated={async (question) => {
            setCreating(null);
            await qc.invalidateQueries({ queryKey: poolKey(id) });
            navigate({ view: "question", id: question.meta.id });
          }}
        />
      ) : null}
    </div>
  );
}
