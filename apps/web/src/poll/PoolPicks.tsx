import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Library } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PollQuestionType, type PollPoolPage } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { activeFilterCount, EMPTY_FILTERS, questionQuery, type QuestionFilters } from "../pool/filters";
import { PoolListTail } from "../pool/PoolListStates";
import { QuestionSearchBar } from "../pool/QuestionSearchBar";
import { useFilterVocabulary } from "../pool/useFilterVocabulary";
import { refName } from "../concepts/sorting";
import { pollPoolQuestionsKey } from "../queryKeys";
import { Button, EmptyState, QueryError, Segmented, Skeleton } from "../ui";
import { PickRow } from "./PickRow";

/** Where "From pools" searches when the audience is a classroom. */
export type PoolScope = "room" | "all";

/**
 * "From pools" (issue #162): any published multiple-choice or short-answer
 * question of any pool the teacher reaches, found with the pool screen's own
 * search — the same field, the same grammar (`#concept`, `type:`,
 * `difficulty:`, `version:`), the same filter sheet (`QuestionSearchBar`).
 *
 * A poll is not graded, so it may borrow from any pool. When the audience is
 * a classroom, though, the pools of its course are the likely ones, so a
 * segmented control narrows to them — "Classroom pools", the default — or
 * widens to "All pools". An anonymous poll belongs to no course, and the
 * control is absent.
 */
export function PoolPicks({
  classroomId,
  selected,
  onSelect,
  onAsk,
}: {
  /** The audience's classroom, `null` for anyone with the code. */
  classroomId: string | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Switches to "Ask a new question", the way out of an empty scope. */
  onAsk: () => void;
}) {
  const t = useT();
  const [filters, setFilters] = useState<QuestionFilters>(EMPTY_FILTERS);
  const [scope, setScope] = useState<PoolScope>("room");
  const room = classroomId !== null && scope === "room" ? classroomId : null;
  const suffix = room === null ? "" : `&classroomId=${encodeURIComponent(room)}`;
  const { vocabulary, waiting } = useFilterVocabulary(filters.q);

  const questions = useInfiniteQuery<PollPoolPage>({
    queryKey: pollPoolQuestionsKey(`${questionQuery(filters, vocabulary)}${suffix}`),
    queryFn: ({ pageParam }) =>
      api(
        `/app/api/polls/pool-questions${questionQuery(filters, vocabulary, pageParam as string | null)}${suffix}`,
      ),
    enabled: !waiting,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // The field is typed into: the rows stay while the next answer comes.
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(
    () => (questions.data?.pages ?? []).flatMap((page) => page.items),
    [questions.data],
  );
  const first = questions.data?.pages[0];

  // A question the list no longer shows is not one "Start the poll" may run.
  useEffect(() => {
    if (questions.isPlaceholderData || !questions.data) return;
    if (selected !== null && !rows.some((r) => r.id === selected)) onSelect(null);
  }, [rows, selected, onSelect, questions.isPlaceholderData, questions.data]);

  const filtered = activeFilterCount(filters) > 0;

  return (
    <div className="space-y-4">
      <QuestionSearchBar
        filters={filters}
        onChange={setFilters}
        concepts={first?.concepts ?? []}
        vocabulary={vocabulary}
        types={PollQuestionType.options}
        deleted={false}
      >
        <div className="flex flex-wrap items-center gap-2">
          {classroomId === null ? null : (
            <Segmented
              name="poll-pool-scope"
              size="sm"
              label={t("poll.scope")}
              value={scope}
              onChange={setScope}
              options={[
                { value: "all", label: t("poll.scope.all") },
                { value: "room", label: t("poll.scope.room") },
              ]}
            />
          )}
          {first === undefined ? null : (
            <span aria-live="polite" className="ml-auto text-xs tabular-nums text-fg-faint">
              {t(first.total === 1 ? "pool.results.one" : "pool.results", { n: first.total })}
            </span>
          )}
        </div>
      </QuestionSearchBar>

      {questions.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : questions.isError || !questions.data ? (
        <QueryError
          title={t("poll.poolsFailed")}
          error={questions.error}
          onRetry={() => void questions.refetch()}
          retrying={questions.isFetching}
          fallback={t("error.server")}
        />
      ) : rows.length === 0 && filtered ? (
        <div className="space-y-3 py-6 text-center">
          <p className="text-[13px] text-fg-muted">{t("poll.noMatch")}</p>
          <Button variant="secondary" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
            {t("pool.filter.clear")}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        room !== null ? (
          <EmptyState
            icon={Library}
            title={t("poll.noRoomQuestions")}
            action={
              <Button variant="secondary" onClick={() => setScope("all")}>
                {t("poll.scope.all")}
              </Button>
            }
          >
            {t("poll.noRoomQuestionsBody")}
          </EmptyState>
        ) : (
          <EmptyState
            icon={Library}
            title={t("poll.noPoolQuestions")}
            action={
              <Button variant="secondary" onClick={onAsk}>
                {t("poll.tab.new")}
              </Button>
            }
          >
            {t("poll.noPoolQuestionsBody")}
          </EmptyState>
        )
      ) : (
        <div className="space-y-3">
          <ul className="space-y-2">
            {rows.map((row) => (
              <PickRow
                key={row.id}
                type={row.type}
                name={row.internalName}
                prompt={row.prompt}
                selected={selected === row.id}
                onSelect={() => onSelect(row.id)}
                meta={
                  <>
                    {row.pool.name}
                    {" · "}
                    {t("eval.questions.version", { n: row.latestNumber })}
                    {row.concepts.length > 0 ? ` · ${row.concepts.map(refName).join(", ")}` : null}
                  </>
                }
              />
            ))}
          </ul>
          <PoolListTail
            hasNextPage={questions.hasNextPage}
            fetchingNext={questions.isFetchingNextPage}
            refetching={false}
            onLoadMore={() => void questions.fetchNextPage()}
          />
        </div>
      )}
    </div>
  );
}
