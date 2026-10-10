import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Flag } from "lucide-react";
import { useState } from "react";

import {
  REPORT_MESSAGE_MAX,
  REPORT_REPLY_MAX,
  type QuestionReportRow,
  type QuestionReports,
  type ReportCreate,
  type ReportResolve,
} from "@quiz/contracts";

import { api } from "../api";
import { useT, type Dict } from "../i18n";
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

/**
 * The one dialog of the feature: a text sent to the server, then the question
 * and the pool's list refresh. "Report a problem" (a required message, any
 * reader) and "Resolve" (an optional reply, a writer) differ only by their
 * words, their limit and their route.
 */
function ReportTextDialog<Body extends ReportCreate | ReportResolve>({
  questionId,
  poolId,
  url,
  field,
  body,
  max,
  required,
  title,
  label,
  help,
  submit,
  failed,
  sent,
  onClose,
  preview,
}: {
  questionId: string;
  poolId: string;
  url: string;
  /** The body's text field: `message` of a report, `reply` of a resolution. */
  field: keyof ReportCreate | keyof ReportResolve;
  body: (text: string) => Body;
  max: number;
  required: boolean;
  title: keyof Dict;
  label: keyof Dict;
  help: keyof Dict;
  submit: keyof Dict;
  failed: keyof Dict;
  /** A toast on success, none when absent. */
  sent?: keyof Dict;
  onClose: () => void;
  /** What the dialog answers: the report's own text, shown above the field. */
  preview?: string;
}) {
  const t = useT();
  const toast = useToast();
  const toastError = useErrorToast();
  const qc = useQueryClient();
  const [text, setText] = useState("");

  const send = useMutation({
    mutationFn: (payload: Body) => api(url, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: async () => {
      if (sent) toast(t(sent), "success");
      await qc.invalidateQueries({ queryKey: questionKey(questionId) });
      await qc.invalidateQueries({ queryKey: poolKey(poolId) });
      onClose();
    },
    onError: toastError(failed),
  });

  return (
    <FormDialog
      title={t(title)}
      onClose={onClose}
      onSubmit={() => send.mutate(body(text.trim()))}
      submitLabel={t(submit)}
      submitting={send.isPending}
      canSubmit={!required || text.trim() !== ""}
    >
      {preview ? <p className="whitespace-pre-wrap text-sm text-fg-muted">{preview}</p> : null}
      <Textarea
        name={field}
        label={t(label)}
        help={t(help)}
        autoFocus
        maxLength={max}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </FormDialog>
  );
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
  return (
    <ReportTextDialog
      questionId={questionId}
      poolId={poolId}
      url={`/app/api/questions/${questionId}/reports`}
      field="message"
      body={(message): ReportCreate => ({ message })}
      max={REPORT_MESSAGE_MAX}
      required
      title="question.report.title"
      label="question.report.message"
      help="question.report.help"
      submit="question.report.submit"
      failed="question.report.failed"
      sent="question.report.sent"
      onClose={onClose}
    />
  );
}

/**
 * The question's reports (the "Reports" tab): open ones first, each with its
 * message, who sent it, and for a writer the one action that closes it. A
 * reporter who is not a writer sees only their own, and no action.
 */
export function QuestionReportsTab({
  questionId,
  poolId,
  canResolve,
}: {
  questionId: string;
  poolId: string;
  /** The caller writes in the pool (the editor's `!readOnly`). */
  canResolve: boolean;
}) {
  const t = useT();
  const reports = useQuestionReports(questionId);
  const [resolving, setResolving] = useState<QuestionReportRow | null>(null);

  if (reports.isLoading) return <Skeleton className="h-24 w-full" />;
  if (reports.isError) return <QueryError title={t("question.reports.failed")} query={reports} />;
  const items = reports.data!;
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
        <ReportTextDialog
          questionId={questionId}
          poolId={poolId}
          url={`/app/api/questions/${questionId}/reports/${resolving.id}/resolve`}
          field="reply"
          body={(reply): ReportResolve => ({ reply })}
          max={REPORT_REPLY_MAX}
          required={false}
          title="question.reports.resolveTitle"
          label="question.reports.reply"
          help="question.reports.replyHelp"
          submit="question.reports.resolve"
          failed="question.reports.resolveFailed"
          preview={resolving.message}
          onClose={() => setResolving(null)}
        />
      ) : null}
    </div>
  );
}
