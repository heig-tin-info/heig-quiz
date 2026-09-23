import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, FileQuestion, Plus } from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";

import type { PoolDetail, QuestionDetail, QuestionPage, QuestionRow } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { QUESTION_TYPE_IDS, typeIcon, typeLabel } from "../questionTypes";
import type { Route } from "../router";
import { useSearchParam } from "../router";
import { useScreenCommands } from "../screenCommands";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FormDialog,
  FormError,
  PageError,
  PageHeader,
  ParentLink,
  QueryError,
  Skeleton,
  Spinner,
  usePersistentChoice,
} from "../ui";
import { BulkBar } from "./BulkBar";
import { setQuestionDrag } from "./move";
import {
  EMPTY_FILTERS,
  questionQuery,
  type QuestionFilters,
  type QuestionSort,
} from "./filters";
import { FilterBar, type ListView } from "./FilterBar";
import { QuestionCards, QuestionCardsSkeleton } from "./QuestionCards";
import { groupQuestions, isGroupBy, type GroupBy } from "./QuestionGroups";
import { QuestionTable, QuestionTableSkeleton } from "./QuestionTable";
import { QuestionTypePicker } from "./QuestionTypePicker";
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

/** "Pointeurs / Arithmétique" for every node, and the tree's own order. */
function categoryPaths(
  nodes: PoolDetail["categories"],
  prefix = "",
): { id: string; label: string }[] {
  return nodes.flatMap((node) => {
    const label = prefix ? `${prefix} / ${node.name}` : node.name;
    return [{ id: node.id, label }, ...categoryPaths(node.children, label)];
  });
}

function NewQuestionModal({
  poolId,
  categoryId,
  initialType,
  onClose,
  onCreated,
}: {
  poolId: string;
  categoryId: string | null;
  /** The palette can ask for a type ("New question — Code"). */
  initialType: string;
  onClose: () => void;
  onCreated: (question: QuestionDetail) => void;
}) {
  const t = useT();
  const [type, setType] = useState<string>(initialType);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api<QuestionDetail>(`/app/api/pools/${poolId}/questions`, {
        method: "POST",
        body: JSON.stringify({
          type,
          internalName: name.trim(),
          ...(categoryId ? { categoryId } : {}),
        }),
      }),
    onSuccess: onCreated,
  });
  return (
    <FormDialog
      title={t("pool.newQuestion")}
      onClose={onClose}
      onSubmit={() => create.mutate()}
      submitLabel={t("pool.newQuestionAction")}
      submitting={create.isPending}
      canSubmit={name.trim() !== ""}
      error={<FormError error={create.error} fallback={t("pool.createFailed")} />}
    >
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium">{t("pool.questionType")}</legend>
        <QuestionTypePicker types={QUESTION_TYPE_IDS} value={type} onChange={setType} />
      </fieldset>
      <Field
        label={t("pool.questionName")}
        hint={t("pool.questionNameHint")}
        fullWidth
        autoFocus
        placeholder={t("pool.questionNamePlaceholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
    </FormDialog>
  );
}

export function PoolView({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const confirm = useConfirm();
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

  const duplicate = useMutation({
    mutationFn: (row: QuestionRow) =>
      api<QuestionDetail>(`/app/api/questions/${row.id}/copy`, {
        method: "POST",
        body: JSON.stringify({ targetPoolId: id }),
      }),
    onSuccess: async () => {
      toast(t("question.duplicated"), "success");
      await qc.invalidateQueries({ queryKey: poolKey(id) });
    },
    onError: toastError("error.save"),
  });

  const remove = useMutation({
    mutationFn: (row: QuestionRow) => api(`/app/api/questions/${row.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: poolKey(id) });
    },
    onError: toastError("question.deleteFailed"),
  });

  const askDelete = async (row: QuestionRow) => {
    const ok = await confirm({
      title: t("question.delete"),
      message: t("question.deleteConfirm", { name: row.internalName }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (ok) remove.mutate(row);
  };

  if (pool.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
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
  const category = categoryId ? findCategory(detail.categories, categoryId) : null;
  // `reader` is the one role that may not write (F-POOL-05). An API that does
  // not say (the mock of an older shape) is treated as the role it used to
  // imply, so the screen never silently loses its actions.
  const readOnly = detail.role === "reader";
  const paths = categoryPaths(detail.categories);
  const groups = groupQuestions(
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
  );

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
          view === "cards" ? (
            <QuestionCardsSkeleton />
          ) : (
            <Card>
              <QuestionTableSkeleton />
            </Card>
          )
        ) : questions.isError ? (
          <QueryError
            title={t("pool.title")}
            error={questions.error}
            onRetry={() => void questions.refetch()}
            retrying={questions.isFetching}
            fallback={t("error.server")}
          />
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState
              icon={FileQuestion}
              title={t(detail.questionCount === 0 ? "pool.empty.title" : "pool.emptyFiltered.title")}
              action={
                detail.questionCount === 0 ? (
                  readOnly ? undefined : (
                    <Button onClick={() => setCreating(QUESTION_TYPE_IDS[0]!)}>
                      <Plus /> {t("pool.newQuestion")}
                    </Button>
                  )
                ) : (
                  <Button
                    variant="secondary"
                    // The sort is not a filter: clearing what hides the rows
                    // must not also change the order they come back in.
                    onClick={() => setFilters((f) => ({ ...EMPTY_FILTERS, sort: f.sort, dir: f.dir }))}
                  >
                    {t("pool.filter.clear")}
                  </Button>
                )
              }
            >
              {t(detail.questionCount === 0 ? "pool.empty.body" : "pool.emptyFiltered.body")}
            </EmptyState>
          </Card>
        ) : (
          <>
            {view === "cards" ? (
              <QuestionCards
                groups={groups}
                checked={checked}
                onToggleCheck={toggleCheck}
                onEdit={(row) => navigate({ view: "question", id: row.id })}
                onDuplicate={(row) => duplicate.mutate(row)}
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
                onDuplicate={(row) => duplicate.mutate(row)}
                onDelete={(row) => void askDelete(row)}
                sort={filters.sort}
                dir={filters.dir}
                onSort={sortBy}
                onDragStart={readOnly ? undefined : startDrag}
                readOnly={readOnly}
              />
            )}
            {questions.hasNextPage ? (
              <div className="flex justify-center">
                <Button
                  variant="secondary"
                  loading={questions.isFetchingNextPage}
                  onClick={() => void questions.fetchNextPage()}
                >
                  {t("pool.loadMore")}
                </Button>
              </div>
            ) : null}
            {questions.isFetching && !questions.isFetchingNextPage ? (
              <Spinner className="py-2" />
            ) : null}
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

/** The node of `id` anywhere in the tree. */
function findCategory(
  nodes: PoolDetail["categories"],
  id: string,
): PoolDetail["categories"][number] | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findCategory(node.children, id);
    if (found) return found;
  }
  return null;
}
