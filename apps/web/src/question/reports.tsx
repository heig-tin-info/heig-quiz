import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Flag } from "lucide-react";
import { useState } from "react";

import {
  REPORT_MESSAGE_MAX,
  REPORT_REPLY_MAX,
  type QuestionReports,
  type QuestionReportRow,
  type ReportCreate,
} from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { questionReportsKey, poolKey, questionKey } from "../queryKeys";
import { Badge, Button, Card, EmptyState, FormDialog, QueryError, RelativeTime, Skeleton, Textarea } from "../ui";

/** The reports the caller may read on a question (issue #680): all for a writer, their own otherwise. */
export function useQuestionReports(questionId: string) {
  return useQuery({
    queryKey: questionReportsKey(questionId),
    queryFn: () => api<QuestionReports>(`/app/api/questions/${questionId}/reports`),
  });
}

/** After a report is filed or resolved: its list, the question and the pool's list indicator. */
function useRefreshReports(questionId: string, poolId: string) {
  const qc = useQueryClient();
  return async () => {
    await qc.invalidateQueries({ queryKey: questionKey(questionId) });
    await qc.invalidateQueries({ queryKey: poolKey(poolId) });
  };
}

/** "Report a problem": a message to the writers of the pool. A secondary action, from the editor's menu. */
export function ReportDialog({
  questionId,
  poolId,
  onClose,
}: {
  questionId: string;
  poolId: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const toastError = useErrorToast();
  const refresh = useRefreshReports(questionId, poolId);
  const [message, setMessage] = useState("");

  const send = useMutation({
    mutationFn: (body: ReportCreate) =>
      api(`/app/api/questions/${questionId}/reports`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => {
      toast(t("question.report.sent"), "success");
      await refresh();
      onClose();
    },
    onError: toastError("question.report.failed"),
  });

  return (
    <FormDialog
      title={t("question.report.title")}
      onClose={onClose}
      onSubmit={() => send.mutate({ message: message.trim() })}
      submitLabel={t("question.report.submit")}
      submitting={send.isPending}
      canSubmit={message.trim() !== ""}
    >
      <Textarea
        label={t("question.report.message")}
        help={t("question.report.help")}
        autoFocus
        maxLength={REPORT_MESSAGE_MAX}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
    </FormDialog>
  );
}

/** A writer closes a report, with an optional reply the reporter is told of. */
function ResolveDialog({
  questionId,
  poolId,
  report,
  onClose,
}: {
  questionId: string;
  poolId: string;
  report: QuestionReportRow;
  onClose: () => void;
}) {
  const t = useT();
  const toastError = useErrorToast();
  const refresh = useRefreshReports(questionId, poolId);
  const [reply, setReply] = useState("");

  const resolve = useMutation({
    mutationFn: (body: { reply: string }) =>
      api(`/app/api/questions/${questionId}/reports/${report.id}/resolve`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: toastError("question.reports.resolveFailed"),
  });

  return (
    <FormDialog
      title={t("question.reports.resolveTitle")}
      onClose={onClose}
      onSubmit={() => resolve.mutate({ reply: reply.trim() })}
      submitLabel={t("question.reports.resolve")}
      submitting={resolve.isPending}
    >
      <p className="whitespace-pre-wrap text-sm text-fg-muted">{report.message}</p>
      <Textarea
        label={t("question.reports.reply")}
        help={t("question.reports.replyHelp")}
        autoFocus
        maxLength={REPORT_REPLY_MAX}
        value={reply}
        onChange={(e) => setReply(e.target.value)}
      />
    </FormDialog>
  );
}

/**
 * The question's reports (the "Reports" tab): open ones first, each with its
 * message, who sent it, and for a writer the one action that closes it. A
 * reporter who is not a writer sees only their own, and no action.
 */
export function QuestionReportsTab({ questionId, poolId }: { questionId: string; poolId: string }) {
  const t = useT();
  const reports = useQuestionReports(questionId);
  const [resolving, setResolving] = useState<QuestionReportRow | null>(null);

  if (reports.isLoading) return <Skeleton className="h-24 w-full" />;
  if (reports.isError) return <QueryError title={t("question.reports.failed")} query={reports} />;
  const { items, canResolve } = reports.data!;
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState icon={Flag} title={t("question.reports.empty")} className="py-10" />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((r) => (
        <Card key={r.id} className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <span className="font-semibold text-fg">
              {r.mine ? t("question.reports.you") : (r.reporterName ?? t("question.reports.unknown"))}
            </span>
            <RelativeTime iso={r.createdAt} />
            {r.resolvedAt ? (
              <Badge tone="green" icon={Check}>
                {r.resolvedByName
                  ? t("question.reports.resolvedBy", { name: r.resolvedByName })
                  : t("question.reports.closedWithQuestion")}
              </Badge>
            ) : (
              <Badge tone="amber" icon={Flag}>
                {t("question.reports.status.open")}
              </Badge>
            )}
          </div>
          <p className="whitespace-pre-wrap text-sm">{r.message}</p>
          {r.resolution ? (
            <p className="whitespace-pre-wrap border-l-2 border-line pl-3 text-sm text-fg-muted">{r.resolution}</p>
          ) : null}
          {canResolve && !r.resolvedAt ? (
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => setResolving(r)}>
                {t("question.reports.resolve")}
              </Button>
            </div>
          ) : null}
        </Card>
      ))}
      {resolving ? (
        <ResolveDialog
          questionId={questionId}
          poolId={poolId}
          report={resolving}
          onClose={() => setResolving(null)}
        />
      ) : null}
    </div>
  );
}
