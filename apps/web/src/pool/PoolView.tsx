import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Plus } from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";

import type { CategoryNode, PoolDetail, QuestionPage, QuestionRow } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { QUESTION_TYPE_IDS, typeIcon, typeLabel } from "../questionTypes";
import type { Route } from "../router";
import { useSearchParam } from "../router";
import { useScreenCommands } from "../screenCommands";
import {
  Badge,
  Button,
  PageError,
  PageHeader,
  PageSkeleton,
  ParentLink,
  QueryError,
  usePersistentChoice,
} from "../ui";
import { BulkBar } from "./BulkBar";
import { categoryPaths, findCategory } from "./categories";
import { setQuestionDrag } from "./move";
import {
  EMPTY_FILTERS,
  questionQuery,
  type QuestionFilters,
  type QuestionSort,
} from "./filters";
import { FilterBar, type ListView } from "./FilterBar";
import { NewQuestionModal } from "./NewQuestionModal";
import { PoolEmpty, PoolListSkeleton, PoolListTail } from "./PoolListStates";
import { QuestionCards } from "./QuestionCards";
import { groupQuestions, isGroupBy, type GroupBy } from "./QuestionGroups";
import { QuestionTable } from "./QuestionTable";
import { useQuestionActions } from "../question/useQuestionActions";
import { poolKey, poolQuestionsKey } from "../queryKeys";

/**
 * The pool screen (mockup `08-pool.html`): the questions across the full
 * content width. Clicking a row opens the question; the row also carries its
 * three actions (edit, duplicate, delete) at its end.
 *
 * The category tree is NOT here: it lives in the app sidebar, beside the
 * other navigation, and the category it selects travels in the `category`
 * query-string parameter. A tree is navigation, and navigation belongs in
 * one place; the page then keeps its whole width for the table, which is
 * what a screen made of seven columns needs.
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
 * makes TanStack drop the cursor and start again at page one.
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
 * absent. Opening a question still works — the editor is where a question is
 * read — and it is the editor's own business to refuse a save.
 */

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
          noTag: t("pool.group.noTag"),
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
  const [filters, setFilters] = useState<QuestionFilters>(EMPTY_FILTERS);
  const [categoryParam] = useSearchParam("category", "");
  const categoryId = categoryParam === "" ? null : categoryParam;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState<string | null>(null);
  const [view, setView] = usePersistentChoice(VIEW_KEY, VIEWS, "list");
  const [group, setGroup] = usePersistentChoice<GroupBy>(GROUP_KEY, isGroupBy, "none");

  const pool = useQuery<PoolDetail>({
    queryKey: poolKey(id),
    queryFn: () => api(`/app/api/pools/${id}`),
  });
  const mayWrite = pool.data?.role !== "reader";

  // What this screen adds to the command palette while it is open
  // (docs/spec/08 §8.3): one entry per question type, so an expert never
  // touches the type picker. A reader gets none of them — the palette must
  // not offer what the screen has taken away.
  useScreenCommands(
    mayWrite
      ? QUESTION_TYPE_IDS.map((typeId) => ({
          id: `question:new:${typeId}`,
          label: t("palette.newQuestion", { type: typeLabel(t, typeId) }),
          icon: typeIcon(typeId),
          group: "action" as const,
          run: () => setCreating(typeId),
        }))
      : [],
  );

  const search = useMemo<QuestionFilters>(() => ({ ...filters, categoryId }), [filters, categoryId]);
  const query = questionQuery(search);
  const questions = useInfiniteQuery<QuestionPage>({
    queryKey: poolQuestionsKey(id, query),
    queryFn: ({ pageParam }) =>
      api(`/app/api/pools/${id}/questions${questionQuery(search, pageParam as string | null)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const rows = useMemo(
    () => (questions.data?.pages ?? []).flatMap((page) => page.items),
    [questions.data],
  );
  const checkedIds = rows.filter((r) => checked.has(r.id)).map((r) => r.id);

  /**
   * A new column restarts the pagination — the cursor encodes the order it was
   * cut in — and drops the selection, which was made on rows the reader is
   * about to stop seeing in that place. The first click on a column takes the
   * order a reader expects of it: a name ascends, a date starts at the newest.
   */
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
  const { category, groups } = useListing(pool.data?.categories, categoryId, rows, group);

  if (pool.isLoading) {
    return <PageSkeleton />;
  }
  if (pool.isError) {
    return (
      <PageError
        title={t("pools.notFound")}
        error={pool.error}
        onRetry={() => void pool.refetch()}
        retrying={pool.isFetching}
        fallback={t("error.server")}
      />
    );
  }

  const detail = pool.data!;
  // `reader` is the one role that may not write (F-POOL-05). An API that does
  // not say (the mock of an older shape) is treated as the role it used to
  // imply, so the screen never silently loses its actions.
  const readOnly = detail.role === "reader";

  return (
    <div className="space-y-6">
      <PageHeader
        help="pool"
        eyebrow={
          <ParentLink onClick={() => navigate({ view: "pools" })}>{t("pools.title")}</ParentLink>
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
          ) : (
            <Button onClick={() => setCreating(QUESTION_TYPE_IDS[0]!)}>
              <Plus /> {t("pool.newQuestion")}
            </Button>
          )
        }
      />

      <div className="min-w-0 space-y-4">
        <FilterBar
          filters={filters}
          onChange={(next) => {
            setChecked(new Set());
            setFilters(next);
          }}
          tags={detail.tags}
          total={rows.length}
          view={view}
          onView={setView}
          group={group}
          onGroup={setGroup}
        />

        {questions.isLoading ? (
          <PoolListSkeleton view={view} />
        ) : questions.isError ? (
          <QueryError
            title={t("pool.title")}
            error={questions.error}
            onRetry={() => void questions.refetch()}
            retrying={questions.isFetching}
            fallback={t("error.server")}
          />
        ) : rows.length === 0 ? (
          <PoolEmpty
            questionCount={detail.questionCount}
            readOnly={readOnly}
            onCreate={() => setCreating(QUESTION_TYPE_IDS[0]!)}
            // The sort is not a filter: clearing what hides the rows must not
            // also change the order they come back in.
            onClearFilters={() => setFilters((f) => ({ ...EMPTY_FILTERS, sort: f.sort, dir: f.dir }))}
          />
        ) : (
          <>
            {view === "cards" ? (
              <QuestionCards
                groups={groups}
                checked={checked}
                onToggleCheck={toggleCheck}
                onEdit={(row) => navigate({ view: "question", id: row.id })}
                onDuplicate={(row) => duplicate(row)}
                onDelete={(row) => void askDelete(row)}
                onDragStart={readOnly ? undefined : startDrag}
                readOnly={readOnly}
              />
            ) : (
              <QuestionTable
                groups={groups}
                checked={checked}
                onToggleCheck={toggleCheck}
                onToggleAll={() =>
                  setChecked((prev) =>
                    rows.every((r) => prev.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id)),
                  )
                }
                onEdit={(row) => navigate({ view: "question", id: row.id })}
                onDuplicate={(row) => duplicate(row)}
                onDelete={(row) => void askDelete(row)}
                sort={filters.sort}
                dir={filters.dir}
                onSort={sortBy}
                onDragStart={readOnly ? undefined : startDrag}
                readOnly={readOnly}
              />
            )}
            <PoolListTail
              hasNextPage={questions.hasNextPage}
              fetchingNext={questions.isFetchingNextPage}
              refetching={questions.isFetching && !questions.isFetchingNextPage}
              onLoadMore={() => void questions.fetchNextPage()}
            />
          </>
        )}
      </div>

      {checkedIds.length > 0 && !readOnly ? (
        <BulkBar
          poolId={id}
          ids={checkedIds}
          rows={rows}
          categories={detail.categories}
          onClear={() => setChecked(new Set())}
        />
      ) : null}

      {creating !== null ? (
        <NewQuestionModal
          poolId={id}
          categoryId={categoryId}
          initialType={creating}
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
