import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";

import type { PreviewResult, QuestionDetail, QuestionRow } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { typeIcon, typeLabel } from "../questionTypes";
import { Badge, Button, isoDateTime, QueryError, Sheet, Skeleton } from "../ui";

/**
 * The inspection panel of the pool screen (mockup `08-pool.html`): what the
 * selected question actually says, so a teacher can recognise it without
 * opening the editor.
 *
 * The statement comes from `POST /questions/:id/preview`, never from the
 * stored config: the panel renders what a student would be served
 * (invariant 4), through the one sanitised `MarkdownView`.
 */

/** Where a student view keeps its statement: `prompt`, or `template` for a cloze. */
export function statementOf(student: unknown): string {
  if (typeof student !== "object" || student === null) return "";
  const record = student as Record<string, unknown>;
  const value = record.prompt ?? record.template;
  return typeof value === "string" ? value : "";
}

export function QuestionSidePanel({
  row,
  onClose,
  onEdit,
}: {
  row: QuestionRow;
  onClose: () => void;
  onEdit: () => void;
}) {
  const t = useT();
  const Icon = typeIcon(row.type);
  const preview = useQuery<PreviewResult>({
    queryKey: ["question", row.id, "preview", "draft"],
    queryFn: () =>
      api(`/app/api/questions/${row.id}/preview`, {
        method: "POST",
        body: JSON.stringify({ source: "draft" }),
      }),
  });
  const detail = useQuery<QuestionDetail>({
    queryKey: ["question", row.id],
    queryFn: () => api(`/app/api/questions/${row.id}`),
  });

  return (
    <Sheet
      title={row.internalName}
      subtitle={
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone="zinc" icon={Icon}>
            {typeLabel(t, row.type)}
          </Badge>
          {row.tags.map((tag) => (
            <span key={tag} className="text-xs text-fg-muted">
              #{tag}
            </span>
          ))}
        </span>
      }
      onClose={onClose}
      footer={
        <Button onClick={onEdit}>
          <Pencil /> {t("pool.panel.edit")}
        </Button>
      }
    >
      <div className="space-y-6">
        <section className="space-y-2">
          <h3 className="text-[13px] font-semibold text-fg-muted">{t("pool.panel.statement")}</h3>
          {preview.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : preview.isError ? (
            <QueryError
              title={t("question.previewFailed")}
              error={preview.error}
              onRetry={() => void preview.refetch()}
              retrying={preview.isFetching}
              fallback={t("error.server")}
            />
          ) : (
            <MarkdownView source={statementOf(preview.data?.student)} size="sm" />
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-[13px] font-semibold text-fg-muted">{t("pool.panel.versions")}</h3>
          {detail.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : detail.isError ? (
            <QueryError
              title={t("question.versions.title")}
              error={detail.error}
              onRetry={() => void detail.refetch()}
              retrying={detail.isFetching}
              fallback={t("error.server")}
            />
          ) : (detail.data?.versions.length ?? 0) === 0 ? (
            <p className="text-sm text-fg-muted">{t("pool.panel.noVersion")}</p>
          ) : (
            <ul className="space-y-1.5">
              {detail.data!.versions.map((v) => (
                <li key={v.number} className="flex items-baseline gap-2 text-[13px]">
                  <span className="font-mono tabular-nums">
                    {t("question.versions.number", { n: v.number })}
                  </span>
                  <span className="text-fg-muted">{isoDateTime(v.publishedAt)}</span>
                  {v.deprecatedAt ? (
                    <Badge tone="amber">{t("question.versions.deprecated")}</Badge>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-fg-faint">{v.changeNote ?? "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Sheet>
  );
}
