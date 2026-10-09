import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation } from "@tanstack/react-query";
import {
  Candy,
  Eye,
  Flag,
  Unlink,
  GripVertical,
  ListOrdered,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";

import type { ConceptRef, EvaluationDetail, ItemPatch, ItemRow } from "@quiz/contracts";
import type { z } from "zod";
import { bonusTotal, type ItemListLock } from "@quiz/domain";

import { api } from "../api";
import type { Route } from "../router";
import { useT, type TFunction } from "../i18n";
import { useToast } from "../notify";
import { typeLabel } from "../questionTypes";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  Dash,
  EmptyState,
  FormError,
  IconButton,
  inputClass,
  inputSize,
  PANE_GAP,
  SectionHeading,
  Tip,
} from "../ui";
import { BonusLabel } from "../BonusLabel";
import { ConceptNames } from "../concepts/refs";
import { DifficultyDots } from "../pool/QuestionTable";
import { AddQuestionsSheet } from "./AddQuestionsSheet";
import type { EditTarget } from "./editTarget";
import { useTargetRefresh } from "./editTarget";
import { IntroBand, IntroEditor } from "./ItemIntro";
import { ItemPreview, type ItemPane } from "./ItemPreview";
import { useConfirm } from "../confirm";

/** The rows drag up and down only. */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

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
 * A TEXT before an item (ADR-084) reads the other way round: a recessed band
 * at the top of the row it precedes, and the same gap offers "+ Text" for
 * the row below it (the first row's stands on the card's top edge). The text
 * belongs to the item below, so a drag takes it along with that item.
 *
 * The points field commits on blur, not on every keystroke: typing "12" over
 * a "1" must not first save a "1". Beside it, a toggle makes the item a BONUS
 * (ADR-052): its points leave the total and can only lift a student. It is
 * locked with the points, and the row says "bonus" beside the name.
 *
 * It edits an evaluation's items or a template's (F-EVAL-25) through the
 * same code: the `target` names the routes and the caches, the `lock` is the
 * caller's to compute (a template has none), and a row flagged
 * `poolUnlinked` — only a template's rows carry the flag — says so.
 *
 * A click on a row (anywhere but a control) or its eye shows the item as a
 * student sees it (`ItemPreview`): docked beside the list when the window has
 * room, so another click swaps it, as in the pool. The row shown is tinted.
 * Beside the name, the question's concepts and difficulty — read, never set
 * here — are the first columns to go when the list narrows (concepts, then
 * difficulty), measured on the list's own width, as `T`'s priorities are.
 */

/** What `PATCH …/items/:itemId` accepts, as the client writes it. */
type ItemPatchBody = z.input<typeof ItemPatch>;

/** A row of either list: a template's rows also say when their pool left the course. */
type Row = ItemRow & { poolUnlinked?: boolean };

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

/** One "+" of a gap: what it adds, and the accessible name that says where. */
interface GapAction {
  label: string;
  ariaLabel: string;
  onClick: () => void;
}

/**
 * The "+"s that name a GAP: "+ Milestone" (after the row above) and "+ Text"
 * (before the row below, ADR-084). They sit on a hairline and are revealed
 * by a hover on their row (`reveal`) or by their own focus, so a list of
 * thirty questions is not sixty permanent buttons — while the keyboard still
 * reaches every one of them in order. A COARSE pointer has no hover to give,
 * so there they are simply always on: a control a finger cannot reveal is a
 * control a finger does not have.
 */
function ItemGap({
  actions,
  reveal = "group-hover/row:opacity-100",
}: {
  actions: GapAction[];
  /** The hover that reveals them; a literal class, so Tailwind sees it. */
  reveal?: string;
}) {
  if (actions.length === 0) return null;
  return (
    <div className="relative z-10 h-0">
      <div className="absolute top-0 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5">
        {actions.map((action) => (
          <button
            key={action.ariaLabel}
            type="button"
            onClick={action.onClick}
            aria-label={action.ariaLabel}
            className={cx(
              "flex items-center gap-1 rounded-full border border-line-strong bg-surface px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-fg-muted opacity-0 transition-opacity duration-150 hover:border-accent hover:text-accent focus-visible:opacity-100 hover-reveal",
              reveal,
            )}
          >
            <Plus className="size-3" />
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The version the item is frozen on, in a column of its own (#85) so a list
 * reads at a glance — `v3` in the monospace of the pool's version column.
 * A newer published version shows beside it in amber, `→ v5`: the same fact
 * the refresh button at the end of the row acts on.
 */
function VersionCell({ item, stale, t }: { item: ItemRow; stale: boolean; t: TFunction }) {
  const frozen = t("eval.questions.version", { n: item.versionNumber });
  return (
    <span className="flex w-20 shrink-0 items-center gap-1 text-sm">
      <Tip label={t("eval.questions.versionFrozen", { n: item.versionNumber })}>
        <span className="font-mono tabular-nums text-fg-muted">{frozen}</span>
      </Tip>
      {stale && item.latestVersionNumber !== null ? (
        <Tip label={t("eval.questions.stale", { n: item.latestVersionNumber })}>
          <span className="flex items-center gap-1 font-mono tabular-nums">
            <span aria-hidden className="text-fg-faint">
              →
            </span>
            <span aria-hidden className="text-warning">
              {t("eval.questions.version", { n: item.latestVersionNumber })}
            </span>
            <span className="sr-only">
              {t("eval.questions.stale", { n: item.latestVersionNumber })}
            </span>
          </span>
        </Tip>
      ) : null}
    </span>
  );
}

/**
 * Edit, or why not (issue #127). A reader of the question's pool gets the
 * button greyed out with the reason as its name and tooltip: `aria-disabled`
 * and not `disabled`, so the keyboard still reaches it and hears why — a
 * missing button would leave the teacher hunting for it.
 */
function EditButton({
  item,
  canEdit,
  onEdit,
  t,
}: {
  item: ItemRow;
  canEdit: boolean;
  onEdit: () => void;
  t: TFunction;
}) {
  if (canEdit) {
    return (
      <IconButton label={t("eval.questions.editItem", { name: item.internalName })} onClick={onEdit}>
        <Pencil />
      </IconButton>
    );
  }
  return (
    <IconButton
      label={t("eval.questions.editItem.denied", { name: item.internalName })}
      aria-disabled
      className="cursor-not-allowed opacity-40 hover:bg-transparent hover:text-fg-faint"
    >
      <Pencil />
    </IconButton>
  );
}

function ItemCard({
  item,
  index,
  concepts,
  shown,
  stale,
  locked,
  last,
  canEdit,
  t,
  onPoints,
  onBonus,
  onMilestone,
  onUpdate,
  onRemove,
  onPreview,
  onEdit,
  onEditIntro,
  onRemoveIntro,
  addTextBelow,
}: {
  item: Row;
  index: number;
  concepts: readonly ConceptRef[];
  /** This row is the one the preview shows. */
  shown: boolean;
  stale: boolean;
  locked: boolean;
  last: boolean;
  canEdit: boolean;
  t: TFunction;
  onPoints: (points: number) => void;
  onBonus: (bonus: boolean) => void;
  onMilestone: (milestone: boolean) => void;
  onUpdate: () => void;
  onRemove: () => void;
  onPreview: () => void;
  onEdit: () => void;
  /** ADR-084: opens the editor of this item's intro. */
  onEditIntro: () => void;
  onRemoveIntro: () => void;
  /** "+ Text" for the NEXT item, drawn in the gap under this row; null when it has one. */
  addTextBelow: GapAction | null;
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
      aria-current={shown || undefined}
      className={cx(
        "group/row relative bg-surface aria-[current=true]:bg-accent-soft",
        isDragging && "z-20 shadow-overlay ring-1 ring-line-strong",
      )}
    >
      {item.intro !== null ? (
        <IntroBand
          intro={item.intro}
          name={item.internalName}
          locked={locked}
          onEdit={onEditIntro}
          onRemove={onRemoveIntro}
          t={t}
        />
      ) : null}
      {/* The item's own line is the look; its bands (text, milestone) are not. */}
      <div
        onClick={(e: MouseEvent) => {
          // A control of the row keeps its own click; the row's is a look.
          if ((e.target as Element).closest("button, input, label, a, textarea")) return;
          onPreview();
        }}
        className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-3 py-3 pr-3 pl-1.5"
      >
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
            {item.bonus ? (
              <BonusLabel label="eval.questions.bonus.badge" hint="eval.questions.bonus.hint" />
            ) : null}
            {item.deprecated ? <Badge tone="red">{t("eval.questions.deprecated")}</Badge> : null}
            {item.poolUnlinked ? (
              <Tip label={t("templates.poolUnlinked.hint")}>
                <Badge tone="amber" icon={Unlink}>
                  {t("templates.poolUnlinked")}
                </Badge>
              </Tip>
            ) : null}
          </span>
          <span className="text-xs text-fg-faint">{typeLabel(t, item.type)}</span>
        </span>
        {/* The literal `@` classes of the list's container (`@container` on the ul). */}
        <span className="hidden w-48 shrink-0 @4xl:block">
          {concepts.length === 0 ? (
            <Dash className="text-sm" />
          ) : (
            <ConceptNames concepts={concepts} />
          )}
        </span>
        <span className="hidden w-14 shrink-0 @2xl:block">
          <DifficultyDots value={item.difficulty} />
        </span>
        <VersionCell item={item} stale={stale} t={t} />
        <span className="flex shrink-0 items-center gap-1">
          <PointsField item={item} disabled={locked} onCommit={onPoints} />
          {/* A pressed chip, secondary to the points it qualifies (ADR-052). */}
          <IconButton
            size="sm"
            label={t("eval.questions.bonus")}
            active={item.bonus}
            aria-pressed={item.bonus}
            disabled={locked}
            onClick={() => onBonus(!item.bonus)}
          >
            <Candy />
          </IconButton>
        </span>
        {/* Looking at the question and opening it (#127). Neither changes the
            evaluation — an edit becomes a new version that only "Update"
            brings in — so both stay once the list is frozen. On a phone the
            wrapped line starts with them, at the row's left edge. */}
        <span className="flex shrink-0 items-center gap-0.5 max-sm:ml-auto">
          <IconButton
            label={t("eval.questions.previewItem", { name: item.internalName })}
            onClick={onPreview}
          >
            <Eye />
          </IconButton>
          <EditButton item={item} canEdit={canEdit} onEdit={onEdit} t={t} />
        </span>
        {/* A fixed, right-aligned slot: the refresh button appears on some
            rows only, and without it the points fields of the rows would not
            line up — a column of numbers that wanders is unreadable. */}
        <span className="touch-group flex w-17 shrink-0 items-center justify-end gap-0.5">
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
      ) : null}
      {!last && !locked ? (
        <ItemGap
          actions={[
            ...(item.milestone
              ? []
              : [
                  {
                    label: t("eval.questions.milestone.add"),
                    ariaLabel: t("eval.questions.milestone.addAfter", { name: item.internalName }),
                    onClick: () => onMilestone(true),
                  },
                ]),
            ...(addTextBelow ? [addTextBelow] : []),
          ]}
        />
      ) : null}
    </li>
  );
}

/** What the list reads off an evaluation's detail or a template's: both have these. */
type ItemList = Pick<
  EvaluationDetail,
  "staleItems" | "editableQuestionIds" | "totalPoints" | "concepts"
> & {
  items: Row[];
};

export function ItemsStep({
  target,
  detail,
  lock,
  navigate,
  addVariant = "primary",
  notices,
  pane,
}: {
  target: EditTarget;
  detail: ItemList;
  /** The preview's state, held by the page it widens (`useItemPane`). */
  pane: ItemPane;
  /** Why the list is frozen (issue #79), or null while it may change. */
  lock: ItemListLock | null;
  navigate: (r: Route) => void;
  /**
   * "Add questions" is the step's primary on an evaluation; on a page whose
   * primary is elsewhere (a template's "Use in a classroom") it steps down.
   */
  addVariant?: "primary" | "secondary";
  /** Warnings of the caller's own, under the heading beside the list's. */
  notices?: ReactNode;
}) {
  const t = useT();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  /** The row whose intro editor is open (ADR-084). */
  const [writingIntro, setWritingIntro] = useState<string | null>(null);
  const confirm = useConfirm();
  const editable = new Set(detail.editableQuestionIds);
  // The server's rule (issue #79), computed by the caller: every control
  // below is disabled instead of failing with a 409.
  const locked = lock !== null;
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

  const invalidate = useTargetRefresh(target);
  /** THE item write, its body typed by the route's own schema (invariant 7). */
  const writeItem = (v: { itemId: string; body: ItemPatchBody }) =>
    api(`${target.base}/items/${v.itemId}`, {
      method: "PATCH",
      body: JSON.stringify(v.body),
    });
  const patch = useMutation({ mutationFn: writeItem, onSuccess: invalidate });
  // The intro editor's own write (ADR-084): its pending state and its error
  // belong to the dialog, which closes once the text is saved.
  const saveIntro = useMutation({
    mutationFn: writeItem,
    onSuccess: async () => {
      setWritingIntro(null);
      await invalidate();
    },
  });
  const removeIntro = async (item: ItemRow) => {
    const ok = await confirm({
      title: t("eval.questions.intro.removeConfirm"),
      confirmLabel: t("eval.questions.intro.removeAction"),
      danger: true,
    });
    if (ok) patch.mutate({ itemId: item.id, body: { intro: null } });
  };
  const reorder = useMutation({
    mutationFn: (itemIds: string[]) =>
      api(`${target.base}/items/order`, {
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
      api(`${target.base}/items/${itemId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const updateVersions = useMutation({
    mutationFn: (itemIds?: string[]) =>
      api(`${target.base}/items/update-versions`, {
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

  // Removing an item takes nothing away from the pool — the question stays
  // where it was written — and it is only possible while nobody can have
  // seen the list, so it is an edit and not worth a dialog.
  const removeItem = (item: ItemRow) => remove.mutate(item.id);

  const addButton = (
    <Button variant={addVariant} onClick={() => setAdding(true)} disabled={locked}>
      <Plus /> {t("eval.questions.add")}
    </Button>
  );

  const failed = patch.error ?? remove.error ?? updateVersions.error;
  // The points the bonus items may add on top of the total (ADR-052).
  const bonusPoints = bonusTotal(items);
  // Read off the live list: a row removed meanwhile closes its preview.
  const previewedAt = items.findIndex((i) => i.id === pane.shown);
  const previewed = items[previewedAt] ?? null;
  const show = (at: number) => {
    const to = items[at];
    return to ? () => pane.setShown(to.id) : undefined;
  };
  // A row removed while shown closes its preview, and the page narrows back.
  useEffect(() => {
    if (pane.shown !== null && previewedAt < 0) pane.setShown(null);
  }, [pane.shown, pane.setShown, previewedAt]);
  const introItem = items.find((i) => i.id === writingIntro) ?? null;
  /** The "+ Text" that opens the editor of `item`'s intro (ADR-084). */
  const addTextBefore = (item: Row): GapAction => ({
    label: t("eval.questions.intro.add"),
    ariaLabel: t("eval.questions.intro.addBefore", { name: item.internalName }),
    onClick: () => setWritingIntro(item.id),
  });

  const preview = previewed ? (
    <ItemPreview
      target={target}
      item={previewed}
      pane={pane.pane}
      onMove={{ prev: show(previewedAt - 1), next: show(previewedAt + 1) }}
      onClose={() => pane.setShown(null)}
    />
  ) : null;

  return (
    // Escape closes the docked preview from anywhere in the list or in it.
    <div className="flex items-start" style={{ gap: PANE_GAP }} onKeyDown={pane.closeOnEscape}>
    <div className="min-w-0 flex-1 space-y-4">
      <SectionHeading
        icon={ListOrdered}
        title={t("eval.step.questions")}
        description={t("eval.questions.desc")}
        actions={items.length > 0 ? addButton : undefined}
      />

      {notices}
      {lock === "attempts" ? <Alert tone="warning" title={t("eval.locked")} /> : null}
      {lock === "opened" ? (
        <Alert tone="warning" title={t("eval.questions.frozen")}>
          {t("eval.questions.frozen.body")}
        </Alert>
      ) : null}

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
          {/* The first gap — before question 1 — has no row above it: it
              stands on the card's top edge, outside the clipped card, and a
              hover anywhere on the list reveals it. */}
          <div className="group/list relative">
            {!locked && items[0] && items[0].intro === null ? (
              <ItemGap reveal="group-hover/list:opacity-100" actions={[addTextBefore(items[0])]} />
            ) : null}
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
                  <ul className="divide-y divide-line @container">
                    {items.map((item, index) => (
                      <ItemCard
                        key={item.id}
                        item={item}
                        index={index}
                        concepts={detail.concepts[item.questionId] ?? []}
                        shown={item.id === pane.shown}
                        stale={stale.has(item.id)}
                        locked={locked}
                        last={index === items.length - 1}
                        t={t}
                        onPoints={(points) => patch.mutate({ itemId: item.id, body: { points } })}
                        onBonus={(bonus) => patch.mutate({ itemId: item.id, body: { bonus } })}
                        onMilestone={(milestone) =>
                          patch.mutate({ itemId: item.id, body: { milestone } })
                        }
                        onUpdate={() => updateVersions.mutate([item.id])}
                        onRemove={() => removeItem(item)}
                        canEdit={editable.has(item.questionId)}
                        onPreview={() => pane.setShown(item.id)}
                        onEdit={() =>
                          navigate({ view: "question", id: item.questionId, ...target.questionFrom })
                        }
                        onEditIntro={() => setWritingIntro(item.id)}
                        onRemoveIntro={() => void removeIntro(item)}
                        addTextBelow={
                          items[index + 1] && items[index + 1]!.intro === null
                            ? addTextBefore(items[index + 1]!)
                            : null
                        }
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            </Card>
          </div>
          <p className="text-[13px] text-fg-muted">
            {t("eval.questions.total", {
              n: items.length,
              points: detail.totalPoints,
            })}
            {bonusPoints > 0 ? ` · ${t("eval.questions.total.bonus", { points: bonusPoints })}` : null}
          </p>
        </>
      )}

      {introItem ? (
        <IntroEditor
          name={introItem.internalName}
          initial={introItem.intro ?? ""}
          saving={saveIntro.isPending}
          error={saveIntro.error}
          onSave={(intro) => saveIntro.mutate({ itemId: introItem.id, body: { intro } })}
          onClose={() => {
            saveIntro.reset();
            setWritingIntro(null);
          }}
        />
      ) : null}

      {adding ? (
        <AddQuestionsSheet
          target={target}
          existing={new Set(detail.items.map((i) => i.questionId))}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
    {preview}
    </div>
  );
}
