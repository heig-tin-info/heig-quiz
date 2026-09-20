import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ListOrdered, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { EvaluationDetail, ItemRow } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  IconButton,
  inputClass,
  inputSize,
  Menu,
  SectionHeading,
  Switch,
  Tip,
} from "../ui";
import { AddQuestionsSheet } from "./AddQuestionsSheet";
import { evaluationKey, typeLabel } from "./common";

/**
 * Step 1 of the novice flow (docs/spec/08 §8.2): WHICH questions, in WHICH
 * order, for HOW many points.
 *
 * Reordering is two arrows per row rather than a drag handle. Dragging thirty
 * rows with a mouse is pleasant and with a keyboard is impossible, and the
 * order is exactly the thing a teacher tweaks one step at a time. The arrows
 * are the accessible version of the same gesture and cost one round trip.
 *
 * The points field commits on blur, not on every keystroke: typing "12" over
 * a "1" must not first save a "1".
 */

function PointsField({
  item,
  disabled,
  onCommit,
}: {
  item: ItemRow;
  disabled: boolean;
  onCommit: (points: number) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(String(item.points));
  // The server is the source of truth: an update-versions or a reload must
  // move the field, a keystroke in flight must not be overwritten.
  useEffect(() => setValue(String(item.points)), [item.points]);
  const commit = () => {
    const next = Number(value);
    if (!Number.isFinite(next) || next < 0) {
      setValue(String(item.points));
      return;
    }
    if (next !== item.points) onCommit(next);
  };
  // A bare input and not a `Field`: the row is a list item, and ten stacked
  // "Points" labels is ten times the same word. The accessible name is on the
  // control, the unit is beside it.
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="number"
        min={0}
        step={0.5}
        aria-label={t("eval.questions.points")}
        disabled={disabled}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={cx(inputClass, inputSize.sm, "w-16 text-right tabular-nums")}
      />
      <span className="text-xs text-fg-faint">{t("eval.questions.pointsShort")}</span>
    </span>
  );
}

export function ItemsStep({ detail }: { detail: EvaluationDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const id = detail.evaluation.id;
  const locked = !detail.editable;
  const stale = new Set(detail.staleItems);

  const invalidate = () => qc.invalidateQueries({ queryKey: evaluationKey(id) });
  const patch = useMutation({
    mutationFn: (v: { itemId: string; body: Record<string, unknown> }) =>
      api(`/app/api/evaluations/${id}/items/${v.itemId}`, {
        method: "PATCH",
        body: JSON.stringify(v.body),
      }),
    onSuccess: invalidate,
  });
  const reorder = useMutation({
    mutationFn: (itemIds: string[]) =>
      api(`/app/api/evaluations/${id}/items/order`, {
        method: "PUT",
        body: JSON.stringify({ itemIds }),
      }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (itemId: string) =>
      api(`/app/api/evaluations/${id}/items/${itemId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const updateVersions = useMutation({
    mutationFn: (itemIds?: string[]) =>
      api(`/app/api/evaluations/${id}/items/update-versions`, {
        method: "POST",
        body: JSON.stringify(itemIds ? { itemIds } : {}),
      }),
    onSuccess: invalidate,
  });

  const move = (index: number, delta: number) => {
    const ids = detail.items.map((i) => i.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate(ids);
  };

  const addButton = (
    <Button onClick={() => setAdding(true)} disabled={locked}>
      <Plus /> {t("eval.questions.add")}
    </Button>
  );

  const failed = patch.error ?? reorder.error ?? remove.error ?? updateVersions.error;

  return (
    <div className="space-y-4">
      <SectionHeading
        icon={ListOrdered}
        title={t("eval.step.questions")}
        description={t("eval.questions.desc")}
        actions={detail.items.length > 0 ? addButton : undefined}
      />

      {locked ? <Alert tone="warning" title={t("eval.locked")} /> : null}

      {stale.size > 0 && !locked ? (
        <Alert
          tone="warning"
          icon={RefreshCw}
          title={
            stale.size === 1
              ? t("eval.questions.staleCountOne")
              : t("eval.questions.staleCount", { n: stale.size })
          }
          action={
            <Button
              size="sm"
              variant="secondary"
              loading={updateVersions.isPending}
              onClick={() => updateVersions.mutate(undefined)}
            >
              {stale.size === 1
                ? t("eval.questions.updateAllOne")
                : t("eval.questions.updateAll", { n: stale.size })}
            </Button>
          }
        />
      ) : null}

      {failed ? (
        <Alert tone="danger" title={t("eval.saveFailed")}>
          {apiErrorMessage(failed, t("error.server"))}
        </Alert>
      ) : null}

      {detail.items.length === 0 ? (
        <Card>
          <EmptyState icon={ListOrdered} title={t("eval.questions.empty.title")} action={addButton}>
            {t("eval.questions.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card className="divide-y divide-line">
            {detail.items.map((item, index) => (
              <div key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
                <span className="w-6 shrink-0 text-sm tabular-nums text-fg-faint">
                  {index + 1}
                </span>
                <span className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{item.internalName}</span>
                    {stale.has(item.id) ? (
                      <Badge tone="amber">
                        {t("eval.questions.stale", { n: item.latestVersionNumber ?? "" })}
                      </Badge>
                    ) : null}
                    {item.deprecated ? (
                      <Badge tone="red">{t("eval.questions.deprecated")}</Badge>
                    ) : null}
                  </span>
                  <span className="text-xs text-fg-faint">
                    {typeLabel(item.type, t)} ·{" "}
                    {t("eval.questions.version", { n: item.versionNumber })}
                  </span>
                </span>
                <PointsField
                  item={item}
                  disabled={locked}
                  onCommit={(points) => patch.mutate({ itemId: item.id, body: { points } })}
                />
                <Tip label={t("eval.questions.milestoneOn")}>
                  <span className="flex items-center gap-2 text-[13px] text-fg-muted">
                    <Switch
                      checked={item.milestone}
                      disabled={locked}
                      label={t("eval.questions.milestone")}
                      onChange={(milestone) =>
                        patch.mutate({ itemId: item.id, body: { milestone } })
                      }
                    />
                    {t("eval.questions.milestone")}
                  </span>
                </Tip>
                <span className="flex items-center gap-0.5">
                  <IconButton
                    label={t("eval.questions.moveUp")}
                    disabled={locked || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    label={t("eval.questions.moveDown")}
                    disabled={locked || index === detail.items.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </IconButton>
                  <Menu
                    label={t("live.row.actions", { name: item.internalName })}
                    items={[
                      {
                        label: t("eval.questions.update"),
                        icon: RefreshCw,
                        disabled: locked || !stale.has(item.id),
                        onSelect: () => updateVersions.mutate([item.id]),
                      },
                      {
                        label: t("eval.questions.remove"),
                        icon: Trash2,
                        danger: true,
                        separator: true,
                        disabled: locked,
                        onSelect: async () => {
                          if (
                            await confirm({
                              title: t("eval.questions.remove"),
                              message: item.internalName,
                              confirmLabel: t("common.delete"),
                              cancelLabel: t("common.cancel"),
                              danger: true,
                            })
                          ) {
                            remove.mutate(item.id);
                          }
                        },
                      },
                    ]}
                  />
                </span>
              </div>
            ))}
          </Card>
          <p className="text-[13px] text-fg-muted">
            {t("eval.questions.total", {
              n: detail.items.length,
              points: detail.totalPoints,
            })}
          </p>
        </>
      )}

      {adding ? (
        <AddQuestionsSheet
          evaluationId={id}
          existing={new Set(detail.items.map((i) => i.questionId))}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}
