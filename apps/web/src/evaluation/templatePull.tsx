import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import {
  TransitionRefusal,
  type TemplatePull,
  type TemplatePullItem,
  type TemplatePullPreview,
  type TemplatePullResult,
} from "@quiz/contracts";
import { isEmptyDiff } from "@quiz/domain";

import { api, ApiError } from "../api";
import { useT, type TFunction } from "../i18n";
import { useToast } from "../notify";
import { Badge, ErrorText, FormDialog, FormError, QueryError, Skeleton } from "../ui";
import { evaluationKey, evaluationsKey, templatePullKey } from "../queryKeys";
import { instantiateError, itemNames } from "./templates";

/**
 * Pulling a template revision into an instance (F-EVAL-26, ADR-031 PR B):
 * the badge of the classroom's list, and the confirmation it opens — the one
 * the launch checklist's warning opens too.
 *
 * A pull replaces the evaluation's QUESTIONS and nothing else, so the
 * confirmation is a two-way summary of the question list, read from the
 * server (`GET /evaluations/:id/pull-template`), which alone can say which
 * pools the course still links. It is offered only where the server would
 * accept it (`templatePullable`, the item-list rule, which the callers
 * test), never as a warning nobody can act on.
 */

/**
 * "template rev. 2 → 3", as a button: the row of the list is itself a
 * button, so the badge stops its click from opening the evaluation. Shown by
 * a caller that has checked the pull is offered (`templatePullable`).
 */
export function TemplateBehindBadge({
  from,
  to,
  title,
  onOpen,
}: {
  from: number;
  to: number;
  title: string;
  onOpen: () => void;
}) {
  const t = useT();
  const revisions = { from, to };
  return (
    <button
      type="button"
      aria-label={t("templatePull.badge.action", { ...revisions, name: title })}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className="rounded-full transition-opacity hover:opacity-80"
    >
      <Badge tone="amber" icon={RefreshCw}>
        {t("templatePull.badge", revisions)}
      </Badge>
    </button>
  );
}

/** What moved on one item: its version, its points, its section break, its bonus flag. */
function changeOf(from: TemplatePullItem, to: TemplatePullItem, t: TFunction): string {
  const parts = [
    ...(from.versionNumber !== to.versionNumber
      ? [t("templatePull.change.version", { from: from.versionNumber, to: to.versionNumber })]
      : []),
    ...(from.points !== to.points ? [t("templatePull.change.points", { from: from.points, to: to.points })] : []),
    ...(from.milestone !== to.milestone
      ? [t(to.milestone ? "templatePull.change.milestoneOn" : "templatePull.change.milestoneOff")]
      : []),
    ...(from.bonus !== to.bonus
      ? [t(to.bonus ? "templatePull.change.bonusOn" : "templatePull.change.bonusOff")]
      : []),
  ];
  return `${to.internalName} (${parts.join(", ")})`;
}

/** The lines of the two-way summary, one per kind of change; none when nothing differs. */
function summaryLines(p: TemplatePullPreview, t: TFunction): string[] {
  return [
    ...(p.added.length > 0 ? [t("templatePull.added", { n: p.added.length, names: itemNames(p.added) })] : []),
    ...(p.removed.length > 0
      ? [t("templatePull.removed", { n: p.removed.length, names: itemNames(p.removed) })]
      : []),
    ...(p.changed.length > 0
      ? [
          t("templatePull.changed", {
            n: p.changed.length,
            names: p.changed.map((c) => changeOf(c.from, c.to, t)).join(", "),
          }),
        ]
      : []),
    ...(p.reordered ? [t("templatePull.reordered")] : []),
  ];
}

/** A refused pull, in the teacher's words; null for anything the fallback covers. */
function refusalOf(error: unknown, t: TFunction): string | null {
  if (!(error instanceof ApiError)) return null;
  const unlinked = instantiateError(error, t);
  if (unlinked !== null) return unlinked;
  if (TransitionRefusal.safeParse(error.body).data?.reason === "no_items") return t("templatePull.noItems");
  if (TransitionRefusal.safeParse(error.body).data?.reason === "no_graded_points") {
    return t("eval.launch.needGradedPoints");
  }
  const code = (error.body as { error?: string } | null)?.error;
  if (code === "template_moved") return t("templatePull.moved");
  if (code === "no_template") return t("templatePull.gone");
  if (code === "items_frozen" || code === "locked") return t("templatePull.frozen");
  return null;
}

/**
 * The confirmation: "rev. N → M", what changes in the questions, what does
 * not, and the one action. Nothing differs → it says the revision alone is
 * recorded. A pool the course no longer links would refuse the pull: the
 * dialog says so and does not offer it.
 */
export function PullTemplateDialog({
  evaluationId,
  classroomId,
  onClose,
}: {
  evaluationId: string;
  classroomId: string;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const preview = useQuery<TemplatePullPreview>({
    queryKey: templatePullKey(evaluationId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/pull-template`),
    staleTime: 0,
  });
  const pull = useMutation({
    mutationFn: (revision: number) =>
      api<TemplatePullResult>(`/app/api/evaluations/${evaluationId}/pull-template`, {
        method: "POST",
        body: JSON.stringify({ revision } satisfies TemplatePull),
      }),
    onSuccess: async (result, revision) => {
      qc.setQueryData(evaluationKey(evaluationId), result.detail);
      await Promise.all([
        qc.invalidateQueries({ queryKey: evaluationKey(evaluationId) }),
        qc.invalidateQueries({ queryKey: evaluationsKey(classroomId) }),
      ]);
      toast(
        result.deprecatedItems.length > 0
          ? t("templatePull.doneDeprecated", { revision, names: itemNames(result.deprecatedItems) })
          : t("templatePull.done", { revision }),
        result.deprecatedItems.length > 0 ? "warning" : "success",
      );
      onClose();
    },
    // The template moved again: show the summary of the revision that is there now.
    onError: () => void qc.invalidateQueries({ queryKey: templatePullKey(evaluationId) }),
  });

  const data = preview.data;
  const lines = data ? summaryLines(data, t) : [];
  const nothing = data !== undefined && isEmptyDiff(data);
  const blocked = (data?.unlinkedItems.length ?? 0) > 0;
  const refusal = pull.error ? refusalOf(pull.error, t) : null;

  return (
    <FormDialog
      title={t("templatePull.title")}
      onClose={onClose}
      onSubmit={() => data && pull.mutate(data.to)}
      submitLabel={nothing ? t("templatePull.submitRecord") : t("templatePull.submit")}
      submitting={pull.isPending}
      canSubmit={data !== undefined && !blocked}
      error={
        refusal ? (
          <ErrorText>{refusal}</ErrorText>
        ) : (
          <FormError error={pull.error} fallback={t("templatePull.failed")} />
        )
      }
    >
      {preview.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : preview.isError || !data ? (
        <QueryError
          title={t("templatePull.loadFailed")}
          error={preview.error}
          onRetry={() => void preview.refetch()}
          retrying={preview.isFetching}
        />
      ) : (
        <>
          <p className="text-sm">
            {t("templatePull.lead", { title: data.templateTitle })}{" "}
            <span className="font-semibold tabular-nums">
              {t("templatePull.revisions", { from: data.from ?? "—", to: data.to })}
            </span>
          </p>
          {nothing ? (
            <p className="text-sm text-fg-muted">{t("templatePull.nothing")}</p>
          ) : (
            <>
              <ul className="space-y-1.5 rounded-field bg-surface-2 p-3 text-[13px]">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="text-[13px] text-fg-muted">{t("templatePull.replaces")}</p>
            </>
          )}
          {data.deprecatedItems.length > 0 ? (
            <p className="text-[13px] text-warning">
              {t("templatePull.deprecated", { names: itemNames(data.deprecatedItems) })}
            </p>
          ) : null}
          {blocked ? (
            <ErrorText>
              {t("templates.unlinked", { names: itemNames(data.unlinkedItems) })}
            </ErrorText>
          ) : null}
        </>
      )}
    </FormDialog>
  );
}
