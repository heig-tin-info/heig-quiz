import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileQuestion, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import type { PoolDetail, QuestionDetail, QuestionPage, QuestionRow } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { QUESTION_TYPE_IDS, typeHint, typeIcon, typeLabel } from "../questionTypes";
import type { Route } from "../router";
import { useSearchParam } from "../router";
import { useScreenCommands } from "../screenCommands";
import {
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  Modal,
  PageError,
  PageHeader,
  QueryError,
  Skeleton,
  Spinner,
} from "../ui";
import { BulkBar } from "./BulkBar";
import { EMPTY_FILTERS, questionQuery, type QuestionFilters } from "./filters";
import { FilterBar } from "./FilterBar";
import { QuestionTable, QuestionTableSkeleton } from "./QuestionTable";

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
 */

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
    <Modal
      title={t("pool.newQuestion")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={name.trim() === ""}
          >
            {t("pool.newQuestionAction")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">{t("pool.questionType")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {QUESTION_TYPE_IDS.map((id) => {
              const Icon = typeIcon(id);
              const active = type === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setType(id)}
                  className={cx(
                    "flex items-start gap-2.5 rounded-field border p-3 text-left transition-colors",
                    active
                      ? "border-accent bg-accent-soft"
                      : "border-line-strong bg-surface hover:bg-surface-2",
                  )}
                >
                  <Icon className={cx("mt-0.5 size-4 shrink-0", active ? "text-accent" : "text-fg-faint")} />
                  <span className="min-w-0">
                    <span className={cx("block text-sm font-medium", active && "text-accent")}>
                      {typeLabel(t, id)}
                    </span>
                    <span className="block text-xs text-fg-muted">{typeHint(t, id)}</span>
                  </span>
                </button>
              );
            })}
          </div>
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
        {create.isError ? (
          <p className="text-[13px] text-danger">
            {apiErrorMessage(create.error, t("pool.createFailed"))}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

export function PoolView({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // Everything but the category is local to the screen; the category is the
  // sidebar's selection, and "" means "all questions".
  const [filters, setFilters] = useState<QuestionFilters>(EMPTY_FILTERS);
  const [categoryParam] = useSearchParam("category", "");
  const categoryId = categoryParam === "" ? null : categoryParam;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState<string | null>(null);

  // What this screen adds to the command palette while it is open
  // (docs/spec/08 §8.3): one entry per question type, so an expert never
  // touches the type picker.
  useScreenCommands(
    QUESTION_TYPE_IDS.map((typeId) => ({
      id: `question:new:${typeId}`,
      label: t("palette.newQuestion", { type: typeLabel(t, typeId) }),
      icon: typeIcon(typeId),
      group: "action" as const,
      run: () => setCreating(typeId),
    })),
  );

  const pool = useQuery<PoolDetail>({
    queryKey: ["pool", id],
    queryFn: () => api(`/app/api/pools/${id}`),
  });

  const search = useMemo<QuestionFilters>(() => ({ ...filters, categoryId }), [filters, categoryId]);
  const query = questionQuery(search);
  const questions = useInfiniteQuery<QuestionPage>({
    queryKey: ["pool", id, "questions", query],
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

  const toggleCheck = (questionId: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });

  const duplicate = useMutation({
    mutationFn: (row: QuestionRow) =>
      api<QuestionDetail>(`/app/api/questions/${row.id}/copy`, {
        method: "POST",
        body: JSON.stringify({ targetPoolId: id }),
      }),
    onSuccess: async () => {
      toast(t("question.duplicated"), "success");
      await qc.invalidateQueries({ queryKey: ["pool", id] });
    },
    onError: (error) => toast(apiErrorMessage(error, t("error.save")), "error"),
  });

  const remove = useMutation({
    mutationFn: (row: QuestionRow) => api(`/app/api/questions/${row.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["pool", id] });
    },
    onError: (error) => toast(apiErrorMessage(error, t("question.deleteFailed")), "error"),
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

  return (
    <div className="space-y-6">
      <PageHeader
        help="pool"
        eyebrow={
          <button
            type="button"
            className="text-fg-muted transition-colors hover:text-fg"
            onClick={() => navigate({ view: "pools" })}
          >
            {t("pools.title")}
          </button>
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
          <Button onClick={() => setCreating(QUESTION_TYPE_IDS[0]!)}>
            <Plus /> {t("pool.newQuestion")}
          </Button>
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
        />

        {questions.isLoading ? (
          <Card>
            <QuestionTableSkeleton />
          </Card>
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
                  <Button onClick={() => setCreating(QUESTION_TYPE_IDS[0]!)}>
                    <Plus /> {t("pool.newQuestion")}
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
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
            <QuestionTable
              rows={rows}
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
            />
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

      {checkedIds.length > 0 ? (
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
            await qc.invalidateQueries({ queryKey: ["pool", id] });
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
