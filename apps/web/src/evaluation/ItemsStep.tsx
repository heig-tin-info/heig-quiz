import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Flag, GripVertical, ListOrdered, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { EvaluationDetail, ItemRow } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT, type TFunction } from "../i18n";
import { useToast } from "../notify";
import { typeLabel } from "../questionTypes";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  FormError,
  IconButton,
  inputClass,
  inputSize,
  SectionHeading,
  Tip,
} from "../ui";
import { AddQuestionsSheet } from "./AddQuestionsSheet";
import { evaluationKey } from "../queryKeys";

/**
 * Step 1 of the novice flow (docs/spec/08 §8.2): WHICH questions, in WHICH
 * order, for HOW many points.
 *
 * The order is a DRAG, on a grip at the left of the row (@dnd-kit). The grip
 * is a real `<button>`, which is what makes the keyboard sensor reachable at
 * all — focus it, Space, arrows, Space — so the ↑ / ↓ pair it replaced is
 * gone rather than kept "for accessibility": two affordances for one gesture
 * is one of them lying. A drop writes the whole order in ONE `PUT
 * …/items/order`, and the list holds the new order optimistically until the
 * server confirms it; a failure puts the rows back and says so in a toast.
 *
 * A MILESTONE is drawn as a SEPARATOR and not as a per-row switch (F-EVAL-07).
 * The flag stays exactly what it was in the data — a boolean on the item,
 * "this item closes a section" — but a teacher reading a list does not think
 * "question 4 is a milestone", they think "the student does not come back
 * past here". So the row above it carries a band across the whole width, and
 * the way to make one is the "+" that appears in the GAP it would fill. The
 * separator belongs to the item above it: dragging that item takes its
 * separator along, which is the only reading that survives a reorder.
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

/**
 * The band that closes a section. It is recessed (`surface-2`) and not red:
 * the one accent on this screen is "Add questions", and a red rule running
 * across the list would win the squint test against it.
 */
function MilestoneBand({
  name,
  disabled,
  onRemove,
  t,
}: {
  name: string;
  disabled: boolean;
  onRemove: () => void;
  t: TFunction;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-dashed border-line-strong bg-surface-2 px-4 py-1.5">
      <Flag className="size-3.5 shrink-0 text-fg-muted" />
      <Tip label={t("eval.questions.milestoneOn")}>
        <span className="text-[11px] font-medium tracking-wide text-fg-muted uppercase">
          {t("eval.questions.milestone")}
        </span>
      </Tip>
      <span className="flex-1" />
      <IconButton
        size="sm"
        label={t("eval.questions.milestone.remove", { name })}
        disabled={disabled}
        onClick={onRemove}
      >
        <X />
      </IconButton>
    </div>
  );
}

/**
 * The "+" that names a GAP. It sits on the bottom hairline of its row and is
 * revealed by a hover on that row or by its own focus, so a list of thirty
 * questions is not thirty permanent buttons — while the keyboard still
 * reaches every one of them in order. A COARSE pointer has no hover to give,
 * so there it is simply always on: a control a finger cannot reveal is a
 * control a finger does not have.
 */
function MilestoneGap({ name, onAdd, t }: { name: string; onAdd: () => void; t: TFunction }) {
  return (
    <div className="relative z-10 h-0">
      <button
        type="button"
        onClick={onAdd}
        aria-label={t("eval.questions.milestone.addAfter", { name })}
        className="absolute top-0 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border border-line-strong bg-surface px-2 py-0.5 text-[11px] font-medium text-fg-muted opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 hover:border-accent hover:text-accent focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <Plus className="size-3" />
        {t("eval.questions.milestone.add")}
      </button>
    </div>
  );
}

function ItemCard({
  item,
  index,
  stale,
  locked,
  last,
  t,
  onPoints,
  onMilestone,
  onUpdate,
  onRemove,
}: {
  item: ItemRow;
  index: number;
  stale: boolean;
  locked: boolean;
  last: boolean;
  t: TFunction;
  onPoints: (points: number) => void;
  onMilestone: (milestone: boolean) => void;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: locked,
  });
  const style = { transform: CSS.Translate.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cx(
        "group/row relative bg-surface",
        isDragging && "z-20 shadow-overlay ring-1 ring-line-strong",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3 py-3 pr-3 pl-1.5">
        {/*
         * A BUTTON and nothing else: that is what the keyboard sensor listens
         * to, and what gives the gesture an accessible name.
         */}
        <Tip label={t("eval.questions.reorder", { name: item.internalName })}>
          <button
            type="button"
            aria-label={t("eval.questions.reorder", { name: item.internalName })}
            disabled={locked}
            className="flex size-7 shrink-0 cursor-grab items-center justify-center rounded-full text-fg-faint transition-colors duration-150 hover:bg-surface-2 hover:text-fg-muted disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4"
            {...attributes}
            {...listeners}
          >
            <GripVertical />
          </button>
        </Tip>
        <span className="w-5 shrink-0 text-sm tabular-nums text-fg-faint">{index + 1}</span>
        <span className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold">{item.internalName}</span>
            {stale ? (
              <Badge tone="amber">
                {t("eval.questions.stale", { n: item.latestVersionNumber ?? "" })}
              </Badge>
            ) : null}
            {item.deprecated ? <Badge tone="red">{t("eval.questions.deprecated")}</Badge> : null}
          </span>
          <span className="text-xs text-fg-faint">
            {typeLabel(t, item.type)} · {t("eval.questions.version", { n: item.versionNumber })}
          </span>
        </span>
        <PointsField item={item} disabled={locked} onCommit={onPoints} />
        {/* A fixed, right-aligned slot: the refresh button appears on some
            rows only, and without it the points fields of the rows would not
            line up — a column of numbers that wanders is unreadable. */}
        <span className="flex w-17 shrink-0 items-center justify-end gap-0.5">
          {/* Only a stale item has anything to refresh, so only a stale item
              shows the button: a permanently disabled icon teaches nothing. */}
          {stale && !locked ? (
            <IconButton
              label={t("eval.questions.updateItem", { name: item.internalName })}
              onClick={onUpdate}
            >
              <RefreshCw />
            </IconButton>
          ) : null}
          <IconButton
            danger
            label={t("eval.questions.removeItem", { name: item.internalName })}
            disabled={locked}
            onClick={onRemove}
          >
            <Trash2 />
          </IconButton>
        </span>
      </div>

      {item.milestone ? (
        <MilestoneBand
          name={item.internalName}
          disabled={locked}
          onRemove={() => onMilestone(false)}
          t={t}
        />
      ) : !last && !locked ? (
        <MilestoneGap name={item.internalName} onAdd={() => onMilestone(true)} t={t} />
      ) : null}
    </li>
  );
}

export function ItemsStep({ detail }: { detail: EvaluationDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const id = detail.evaluation.id;
  const locked = !detail.editable;
  const stale = new Set(detail.staleItems);

  /**
   * The order the reader is looking at while a reorder is in flight. It holds
   * ids only, so a `points` patch landing meanwhile is still shown; it is
   * dropped the moment the server hands back the same order, and on a failure.
   */
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const items = useMemo(() => {
    if (!pendingOrder) return detail.items;
    const byId = new Map(detail.items.map((i) => [i.id, i] as const));
    if (pendingOrder.length !== detail.items.length || pendingOrder.some((x) => !byId.has(x))) {
      return detail.items;
    }
    return pendingOrder.map((x) => byId.get(x)!);
  }, [detail.items, pendingOrder]);
  useEffect(() => {
    if (pendingOrder && detail.items.map((i) => i.id).join() === pendingOrder.join()) {
      setPendingOrder(null);
    }
  }, [detail.items, pendingOrder]);

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
    onError: () => {
      // The rows go back where they were, and the reader is told why they
      // moved: a silent revert reads as a bug in the drag.
      setPendingOrder(null);
      toast(t("eval.questions.reorderFailed"), "error");
    },
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

  const sensors = useSensors(
    // A few pixels of slop, so a click on the points field of a row is a
    // click and not the start of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = items.map((i) => i.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    setPendingOrder(next);
    reorder.mutate(next);
  }

  const removeItem = async (item: ItemRow) => {
    // Removing an item takes nothing away from the pool — the question stays
    // where it was written. It is worth a dialog only once somebody has an
    // attempt on this evaluation, where it is no longer an edit but a change
    // to what a class has already seen.
    if (detail.attemptCount > 0) {
      const confirmed = await confirm({
        title: t("eval.questions.remove"),
        message: item.internalName,
        confirmLabel: t("common.delete"),
        cancelLabel: t("common.cancel"),
        danger: true,
      });
      if (!confirmed) return;
    }
    remove.mutate(item.id);
  };

  const addButton = (
    <Button onClick={() => setAdding(true)} disabled={locked}>
      <Plus /> {t("eval.questions.add")}
    </Button>
  );

  const failed = patch.error ?? remove.error ?? updateVersions.error;

  return (
    <div className="space-y-4">
      <SectionHeading
        icon={ListOrdered}
        title={t("eval.step.questions")}
        description={t("eval.questions.desc")}
        actions={items.length > 0 ? addButton : undefined}
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

      <FormError error={failed} title={t("eval.saveFailed")} />

      {items.length === 0 ? (
        <Card>
          <EmptyState icon={ListOrdered} title={t("eval.questions.empty.title")} action={addButton}>
            {t("eval.questions.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={items.map((i) => i.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="divide-y divide-line">
                  {items.map((item, index) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      index={index}
                      stale={stale.has(item.id)}
                      locked={locked}
                      last={index === items.length - 1}
                      t={t}
                      onPoints={(points) => patch.mutate({ itemId: item.id, body: { points } })}
                      onMilestone={(milestone) =>
                        patch.mutate({ itemId: item.id, body: { milestone } })
                      }
                      onUpdate={() => updateVersions.mutate([item.id])}
                      onRemove={() => void removeItem(item)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          </Card>
          <p className="text-[13px] text-fg-muted">
            {t("eval.questions.total", {
              n: items.length,
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
