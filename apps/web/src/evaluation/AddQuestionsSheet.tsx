import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, Search } from "lucide-react";
import { useState } from "react";

import type { EvaluationDetail, PoolSummary, QuestionPage } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { DifficultyDots } from "../pool/QuestionTable";
import { QUESTION_TYPE_IDS, typeLabel } from "../questionTypes";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  QueryError,
  SearchInput,
  Select,
  Sheet,
  Skeleton,
  Tip,
} from "../ui";
import { evaluationKey } from "./common";

/**
 * The question picker (F-EVAL-01): a pool on the left of the filter bar, a
 * search, a type and a difficulty, and a list of checkboxes.
 *
 * It is a Sheet and not a dialog because it is a long form that must not hide
 * the list it feeds — the teacher ticks five questions, closes, and sees them
 * land in order. The list is deliberately flat (no category tree here): the
 * tree belongs to the pool screen, where a teacher is organising; here they
 * are shopping, and a search box is faster than a tree.
 *
 * A question with no published version is shown and disabled rather than
 * hidden: "where is my question?" is a worse five minutes than "ah, I never
 * published it" (the server would answer `422 no_published_version` anyway).
 */
export function AddQuestionsSheet({
  evaluationId,
  existing,
  onClose,
}: {
  evaluationId: string;
  /** Question ids already in the evaluation; they are ticked and disabled. */
  existing: Set<string>;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [poolId, setPoolId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  const pools = useQuery<PoolSummary[]>({
    queryKey: ["pools"],
    queryFn: () => api("/app/api/pools"),
  });
  const current = poolId ?? pools.data?.[0]?.id ?? null;

  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (type) params.set("type", type);
  if (difficulty) params.set("difficulty", difficulty);
  const search = params.toString();
  const questions = useQuery<QuestionPage>({
    queryKey: ["pool-questions", current, search],
    enabled: current !== null,
    queryFn: () => api(`/app/api/pools/${current}/questions${search ? `?${search}` : ""}`),
  });

  const add = useMutation({
    mutationFn: () =>
      api<EvaluationDetail>(`/app/api/evaluations/${evaluationId}/items`, {
        method: "POST",
        body: JSON.stringify({ questionIds: picked }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: evaluationKey(evaluationId) });
      onClose();
    },
  });

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <Sheet
      title={t("picker.title")}
      subtitle={picked.length > 0 ? t("picker.selected", { n: picked.length }) : undefined}
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => add.mutate()}
            loading={add.isPending}
            disabled={picked.length === 0}
          >
            {picked.length === 0
              ? t("picker.title")
              : picked.length === 1
                ? t("picker.addOne")
                : t("picker.add", { n: picked.length })}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t("picker.pool")}
            value={current ?? ""}
            onChange={(e) => {
              setPoolId(e.target.value);
              setPicked([]);
            }}
            width="w-56"
          >
            {(pools.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select
            label={t("picker.type")}
            value={type}
            onChange={(e) => setType(e.target.value)}
            width="w-40"
          >
            <option value="">{t("picker.allTypes")}</option>
            {QUESTION_TYPE_IDS.map((id) => (
              <option key={id} value={id}>
                {typeLabel(t, id)}
              </option>
            ))}
          </Select>
          <Select
            label={t("picker.difficulty")}
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            width="w-40"
          >
            <option value="">{t("picker.allDifficulties")}</option>
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d} value={String(d)}>
                {"●".repeat(d)}
              </option>
            ))}
          </Select>
        </div>
        <SearchInput
          className="w-full"
          aria-label={t("picker.search")}
          placeholder={t("picker.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        {pools.isLoading || questions.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : pools.isError ? (
          <QueryError
            title={t("picker.noPool.title")}
            error={pools.error}
            onRetry={() => void pools.refetch()}
            retrying={pools.isFetching}
            fallback={t("error.server")}
          />
        ) : (pools.data ?? []).length === 0 ? (
          <EmptyState icon={Library} title={t("picker.noPool.title")}>
            {t("picker.noPool.body")}
          </EmptyState>
        ) : questions.isError ? (
          <QueryError
            title={t("picker.empty.title")}
            error={questions.error}
            onRetry={() => void questions.refetch()}
            retrying={questions.isFetching}
            fallback={t("error.server")}
          />
        ) : (questions.data?.items ?? []).length === 0 ? (
          <EmptyState icon={Search} title={t("picker.empty.title")}>
            {t("picker.empty.body")}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line rounded-field border border-line">
            {questions.data!.items.map((row) => {
              const unpublished = row.latestNumber === null;
              const already = existing.has(row.id);
              return (
                <li key={row.id} className="flex items-center gap-3 px-3 py-2">
                  <Checkbox
                    checked={already || picked.includes(row.id)}
                    disabled={unpublished || already}
                    onChange={() => toggle(row.id)}
                    label={
                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate font-medium">{row.internalName}</span>
                        <span className="text-xs text-fg-faint">{typeLabel(t, row.type)}</span>
                        <DifficultyDots value={row.difficulty} />
                        {row.deprecated ? (
                          <Badge tone="amber">{t("eval.questions.deprecated")}</Badge>
                        ) : null}
                        {unpublished ? (
                          <Tip label={t("picker.unpublishedHint")}>
                            <Badge tone="zinc">{t("picker.unpublished")}</Badge>
                          </Tip>
                        ) : null}
                      </span>
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}

        {add.isError ? (
          <Alert tone="danger" title={t("eval.saveFailed")}>
            {apiErrorMessage(add.error, t("error.server"))}
          </Alert>
        ) : null}
      </div>
    </Sheet>
  );
}
