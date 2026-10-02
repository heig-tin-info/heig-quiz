import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Pencil, ScanSearch, Sparkles, Undo2, Wand2 } from "lucide-react";

import type { QuestionReview, ReviewFinding, ReviewFixBody, ReviewList, ReviewToggle } from "@quiz/contracts";

import { api } from "../api";
import { MarkdownView } from "../markdown/MarkdownView";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { poolQuestionListsKey, poolReviewsKey } from "../queryKeys";
import { typeLabel } from "../questionTypes";
import type { Route } from "../router";
import { Button, Card, cx, EmptyState, QueryError, SettingRow, Skeleton, Switch } from "../ui";
import { SEVERITY } from "./ReviewBadge";


/**
 * The pool's "LLM review" tab (ADR-060 §6): the owner's switch, how far the
 * night has got, and the open findings of the latest versions — each with
 * Fix (and its Undo), Edit and Ignore for a contributor.
 */
export function ReviewTab({
  poolId,
  role,
  navigate,
}: {
  poolId: string;
  role: "reader" | "contributor" | "owner";
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const reviews = useQuery<ReviewList>({
    queryKey: poolReviewsKey(poolId),
    queryFn: () => api(`/app/api/pools/${poolId}/reviews`),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: poolReviewsKey(poolId) });
    void qc.invalidateQueries({ queryKey: poolQuestionListsKey(poolId) });
  };
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api<ReviewList>(`/app/api/pools/${poolId}/review`, {
        method: "PUT",
        body: JSON.stringify({ enabled } satisfies ReviewToggle),
      }),
    onSuccess: (list) => qc.setQueryData(poolReviewsKey(poolId), list),
    onError: toastError("error.save"),
  });
  const act = useMutation({
    mutationFn: ({ questionId, path, body }: { questionId: string; path: "fix" | "ignore"; body?: ReviewFixBody }) =>
      api<QuestionReview>(`/app/api/questions/${questionId}/review/${path}`, {
        method: "POST",
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    onSuccess: refresh,
    onError: toastError("error.save"),
  });

  if (reviews.isLoading) return <Skeleton className="h-48 w-full" />;
  if (reviews.isError || !reviews.data) {
    return (
      <QueryError
        title={t("review.title")}
        error={reviews.error}
        onRetry={() => void reviews.refetch()}
        retrying={reviews.isFetching}
        fallback={t("error.server")}
      />
    );
  }
  const list = reviews.data;
  const mayAct = role !== "reader";

  return (
    <div className="space-y-5">
      <Card className="px-5 py-1">
        <SettingRow
          title={t("review.enabled")}
          desc={t(list.enabled ? "review.enabled.on" : "review.enabled.off", { reviewed: list.reviewed, pending: list.pending })}
        >
          <Switch
            checked={list.enabled}
            disabled={role !== "owner" || toggle.isPending}
            onChange={(enabled) => toggle.mutate(enabled)}
            label={t("review.enabled")}
          />
        </SettingRow>
      </Card>

      {list.items.length === 0 ? (
        <Card>
          <EmptyState icon={ScanSearch} title={t("review.empty.title")}>
            {t(list.reviewed > 0 ? "review.empty.clean" : "review.empty.none")}
          </EmptyState>
        </Card>
      ) : (
        <ul className="space-y-3">
          {list.items.map((item) => (
            <li key={item.questionId}>
              <Card className="p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button
                    type="button"
                    className="font-semibold text-fg hover:underline"
                    onClick={() => navigate({ view: "question", id: item.questionId })}
                  >
                    {item.internalName}
                  </button>
                  <span className="text-xs text-fg-faint">
                    {typeLabel(t, item.type)} · {t("question.versions.number", { n: item.review.versionNumber })}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate({ view: "question", id: item.questionId })}
                    >
                      <Pencil /> {t("review.edit")}
                    </Button>
                    {mayAct ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={act.isPending}
                        onClick={() => act.mutate({ questionId: item.questionId, path: "ignore" })}
                      >
                        {t("review.ignore")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <ul className="mt-3 space-y-2">
                  {item.review.findings.map((finding, index) => (
                    <FindingRow
                      key={index}
                      finding={finding}
                      onFix={
                        mayAct && finding.fix
                          ? (undo) =>
                              act.mutate({ questionId: item.questionId, path: "fix", body: { finding: index, undo } })
                          : undefined
                      }
                      pending={act.isPending}
                    />
                  ))}
                </ul>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <p className="flex items-center gap-1.5 text-xs text-fg-faint">
        <Sparkles className="size-3.5" aria-hidden /> {t("review.footer")}
      </p>
    </div>
  );
}

function FindingRow({
  finding,
  onFix,
  pending,
}: {
  finding: ReviewFinding;
  onFix: ((undo: boolean) => void) | undefined;
  pending: boolean;
}) {
  const t = useT();
  const { icon: Icon, className, label } = SEVERITY[finding.severity];
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-field bg-surface-2 px-3 py-2 text-sm">
      <Icon className={cx("mt-0.5 size-4 shrink-0", className)} aria-label={t(label)} />
      <div className="min-w-0 flex-1 basis-60 space-y-1">
        <p>
          <code className="mr-2 rounded bg-surface-3 px-1 text-xs text-fg-muted">{finding.path}</code>
          {/* The model writes Markdown (a `p` in code); rendered, never as HTML of its own. */}
          <MarkdownView as="span" size="sm" source={finding.message} />
        </p>
        {finding.fix ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
            <span className="rounded bg-danger-soft px-1 line-through">{finding.fix.from}</span>
            <ArrowRight className="size-3" aria-hidden />
            <span className="rounded bg-success-soft px-1">{finding.fix.to}</span>
          </p>
        ) : null}
      </div>
      {onFix ? (
        finding.applied ? (
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => onFix(true)}>
            <Undo2 /> {t("review.undo")}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => onFix(false)}>
            <Wand2 /> {t("review.fix")}
          </Button>
        )
      ) : null}
    </li>
  );
}
