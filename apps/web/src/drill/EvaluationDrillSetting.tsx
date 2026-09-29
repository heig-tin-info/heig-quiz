/**
 * "Allow drill" on an evaluation (ADR-041 §2, §10 item 3), and "Remove these
 * questions from the drill".
 *
 * The note beside the switch is a decision of the product owner, not a
 * helper text (06, question 28 (h); ADR-041 §13, item 4): the students see
 * the key of these questions after each review, and the drill serves the
 * latest published version of each one — so a question reused in a future
 * exam has been practised, key included. It is always shown, on or off.
 *
 * The switch is the API's to lock: editable until the release, then frozen.
 * Turning it off keeps the cards already made; removing them is its own,
 * explicit action, confirmed with the count, and offered only while there
 * are cards to remove.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Trash2 } from "lucide-react";

import type { Evaluation, EvaluationDrill } from "@quiz/contracts";

import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { evaluationDrillKey, evaluationKey } from "../queryKeys";
import { Alert, Button, Card, QueryError, SettingRow, Skeleton, Switch } from "../ui";
import { fetchEvaluationDrill, removeEvaluationCards, setEvaluationDrill } from "./api";

export function EvaluationDrillSetting({ evaluation }: { evaluation: Evaluation }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const key = evaluationDrillKey(evaluation.id);
  const drill = useQuery({ queryKey: key, queryFn: () => fetchEvaluationDrill(evaluation.id) });
  const released = evaluation.state === "released";

  const settle = async (data: EvaluationDrill) => {
    qc.setQueryData(key, data);
    await qc.invalidateQueries({ queryKey: evaluationKey(evaluation.id), exact: true });
  };
  const allow = useMutation({
    mutationFn: (allowDrill: boolean) => setEvaluationDrill(evaluation.id, allowDrill),
    onSuccess: settle,
    onError: toastError("eval.drill.failed"),
  });
  const remove = useMutation({
    mutationFn: () => removeEvaluationCards(evaluation.id),
    onSuccess: async ({ removed }) => {
      await settle({ allowDrill: evaluation.allowDrill, cards: 0 });
      toast(t("eval.drill.removed", { n: removed }), "success");
    },
    onError: toastError("eval.drill.failed"),
  });

  const cards = drill.data?.cards ?? 0;
  const askRemove = async () => {
    const ok = await confirm({
      title: t("eval.drill.remove.title", { n: cards }),
      message: t("eval.drill.remove.body"),
      confirmLabel: t("eval.drill.remove"),
      danger: true,
    });
    if (ok) remove.mutate();
  };

  return (
    <Card className="divide-y divide-line px-4">
      <div className="pb-3">
        <SettingRow
          title={t("eval.drill")}
          desc={released ? t("eval.drill.locked") : t("eval.drill.desc")}
        >
          <Switch
            checked={evaluation.allowDrill}
            disabled={released || allow.isPending}
            label={t("eval.drill")}
            onChange={(next) => allow.mutate(next)}
          />
        </SettingRow>
        <Alert tone="neutral" icon={Info}>
          <ul className="space-y-1">
            <li>{t("eval.drill.note.key")}</li>
            <li>{t("eval.drill.note.version")}</li>
          </ul>
        </Alert>
      </div>
      {drill.isLoading ? (
        <div className="py-3">
          <Skeleton className="h-5 w-64" />
        </div>
      ) : drill.isError ? (
        <div className="py-3">
          <QueryError
            title={t("eval.drill.loadFailed")}
            error={drill.error}
            onRetry={() => void drill.refetch()}
            retrying={drill.isFetching}
          />
        </div>
      ) : cards > 0 ? (
        <SettingRow
          title={cards === 1 ? t("eval.drill.cards.one") : t("eval.drill.cards", { n: cards })}
          desc={t("eval.drill.cards.desc")}
        >
          <Button variant="secondary" size="sm" loading={remove.isPending} onClick={() => void askRemove()}>
            <Trash2 /> {t("eval.drill.remove")}
          </Button>
        </SettingRow>
      ) : null}
    </Card>
  );
}
