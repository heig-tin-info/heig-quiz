import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, RotateCcw, Ban } from "lucide-react";
import { useState } from "react";

import type { PreviewResult, VersionRow } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { useToast } from "../notify";
import { statementOf } from "../pool/QuestionSidePanel";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  isoDateTime,
  Menu,
  Modal,
  QueryError,
  Skeleton,
  T,
} from "../ui";

/**
 * Every published version of the question (F-QST-04): what was published,
 * when, and with which note.
 *
 * A version is read-only by construction — the only ways back into the
 * present are "restore into the draft", which copies it over the draft, and
 * "deprecate", which marks it as one an evaluation should stop using. The
 * preview shown here goes through `POST /preview` with the version number,
 * so it is the version as a student received it.
 */
function VersionPreview({ questionId, number }: { questionId: string; number: number }) {
  const t = useT();
  const preview = useQuery<PreviewResult>({
    queryKey: ["question", questionId, "preview", number],
    queryFn: () =>
      api(`/app/api/questions/${questionId}/preview`, {
        method: "POST",
        body: JSON.stringify({ source: number }),
      }),
  });
  if (preview.isLoading) return <Skeleton className="h-24 w-full" />;
  if (preview.isError) {
    return (
      <QueryError
        title={t("question.versions.failed")}
        error={preview.error}
        onRetry={() => void preview.refetch()}
        retrying={preview.isFetching}
        fallback={t("error.server")}
      />
    );
  }
  return <MarkdownView source={statementOf(preview.data?.student)} size="sm" />;
}

export function VersionHistory({
  questionId,
  versions,
}: {
  questionId: string;
  versions: readonly VersionRow[];
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [viewing, setViewing] = useState<number | null>(null);
  const [deprecating, setDeprecating] = useState<VersionRow | null>(null);
  const [note, setNote] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["question", questionId] });
  const fail = (error: unknown) => toast(apiErrorMessage(error, t("error.save")), "error");

  const restore = useMutation({
    mutationFn: (number: number) =>
      api(`/app/api/questions/${questionId}/versions/${number}/restore`, { method: "POST" }),
    onSuccess: async (_data, number) => {
      toast(t("question.versions.restored", { n: number }), "success");
      await invalidate();
    },
    onError: fail,
  });

  const deprecate = useMutation({
    mutationFn: (args: { number: number; note: string }) =>
      api(`/app/api/questions/${questionId}/versions/${args.number}/deprecate`, {
        method: "POST",
        body: JSON.stringify({ note: args.note }),
      }),
    onSuccess: async () => {
      setDeprecating(null);
      await invalidate();
    },
    onError: fail,
  });

  if (versions.length === 0) {
    return (
      <Card>
        <EmptyState icon={History} title={t("question.versions.empty")} className="py-10" />
      </Card>
    );
  }

  const current = versions.reduce((max, v) => Math.max(max, v.number), 0);

  return (
    <div className="space-y-4">
      <Card className="overflow-x-auto">
        <table className={T.table}>
          <thead className={T.head}>
            <tr>
              <th className={T.th}>{t("pool.col.version")}</th>
              <th className={T.th}>{t("question.versions.publishedAt")}</th>
              <th className={T.th}>{t("question.changeNote")}</th>
              <th className={T.th}>
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.number} className={cx(T.row, T.rowHover)}>
                <td className={T.td}>
                  <span className="flex items-center gap-2">
                    <span className="font-mono font-bold tabular-nums">
                      {t("question.versions.number", { n: v.number })}
                    </span>
                    {v.number === current ? (
                      <Badge tone="green">{t("question.versions.current")}</Badge>
                    ) : null}
                    {v.deprecatedAt ? (
                      <Badge tone="amber">{t("question.versions.deprecated")}</Badge>
                    ) : null}
                  </span>
                </td>
                <td className={cx(T.td, "whitespace-nowrap tabular-nums text-fg-muted")}>
                  {isoDateTime(v.publishedAt)}
                </td>
                <td className={cx(T.td, "text-fg-muted")}>
                  {v.changeNote ?? v.deprecationNote ?? "—"}
                </td>
                <td className={cx(T.td, "text-right")}>
                  <Menu
                    label={t("common.actions")}
                    items={[
                      {
                        label: t("question.versions.view"),
                        icon: History,
                        onSelect: () => setViewing(v.number),
                      },
                      {
                        label: t("question.versions.restore"),
                        icon: RotateCcw,
                        onSelect: async () => {
                          const ok = await confirm({
                            title: t("question.versions.restore"),
                            message: t("question.versions.restoreConfirm", { n: v.number }),
                            confirmLabel: t("question.versions.restore"),
                            cancelLabel: t("common.cancel"),
                          });
                          if (ok) restore.mutate(v.number);
                        },
                      },
                      {
                        label: t("question.versions.deprecate"),
                        icon: Ban,
                        danger: true,
                        separator: true,
                        disabled: v.deprecatedAt !== null,
                        onSelect: () => {
                          setNote("");
                          setDeprecating(v);
                        },
                      },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {viewing !== null ? (
        <Modal
          size="lg"
          title={t("question.versions.number", { n: viewing })}
          subtitle={t("question.versions.readOnly", { n: viewing })}
          onClose={() => setViewing(null)}
          footer={
            <Button variant="secondary" onClick={() => setViewing(null)}>
              {t("question.versions.backToDraft")}
            </Button>
          }
        >
          <VersionPreview questionId={questionId} number={viewing} />
        </Modal>
      ) : null}

      {deprecating ? (
        <Modal
          title={t("question.versions.deprecateTitle", { n: deprecating.number })}
          onClose={() => setDeprecating(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeprecating(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                loading={deprecate.isPending}
                disabled={note.trim() === ""}
                onClick={() => deprecate.mutate({ number: deprecating.number, note: note.trim() })}
              >
                {t("question.versions.deprecate")}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <Alert tone="warning">{t("question.versions.deprecateNote")}</Alert>
            <Field
              label={t("question.versions.deprecateNote")}
              fullWidth
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
