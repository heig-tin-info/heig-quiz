/**
 * The board of a `categorize` question: a tray of cards over a grid of
 * columns, shared by the editor (which writes the KEY) and the player (which
 * writes the ANSWER). It owns no placement: it draws the one it is given and
 * reports every move through `onMove`, so both surfaces stay controlled.
 *
 * Two ways to move a card, and neither is the "real" one:
 *
 *  - DRAG, with dnd-kit: the pointer after 4 px of slop (a click stays a
 *    click), or the keyboard — Space picks the card up, the arrows carry it,
 *    Space drops it. Several containers: the tray and every column are drop
 *    zones, and a column is sortable inside.
 *  - CLICK THEN CLICK (or Enter then Enter): select a card, then a column or
 *    the tray. A drag on a phone is a fight with the page's scroll, and a
 *    drag with the keyboard is an arrow maze across a grid; this is the
 *    move a student with a screen reader or a small screen actually makes.
 *    While a card is selected, every zone grows a "drop here" button — a
 *    real button with a real name, never a zone that pretends to be one
 *    around the cards it holds.
 */
import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { fmt } from "@quiz/core/client";
import { cx } from "@quiz/ui";

import type { Placement } from "./placement.js";
import { cardClass, cardTone } from "./ui.js";

/** The dnd id of the tray; a column is `col:<id>`, a card `card:<id>`. */
const TRAY = "tray";
const colKey = (id: string) => `col:${id}`;
const cardKey = (id: string) => `card:${id}`;
/** The card id behind a dnd id, or `null` when it names a zone. */
const cardOf = (dndId: string): string | null => (dndId.startsWith("card:") ? dndId.slice("card:".length) : null);
/** The column id behind a zone's dnd id, or `null` for the tray or a card. */
const columnOf = (dndId: string): string | null => (dndId.startsWith("col:") ? dndId.slice("col:".length) : null);

/** The tray's frame: a recessed panel above the columns (board and review alike). */
export const trayFrame = "flex flex-col gap-2 rounded-card border border-line bg-surface-2 p-3";
/** The grid of the columns: as many as fit at 200 px, stacked on a phone. */
export const columnGrid = "grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3";

/**
 * One column's frame, purely visual: its header row over its body. The
 * board puts a drop zone in the body, the review a list of verdicts.
 */
export function ColumnFrame({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-card border border-line bg-surface">
      <div className="flex min-h-11 items-center gap-1.5 border-b border-line px-3 py-2">{head}</div>
      {children}
    </div>
  );
}

/** What a surface needs to draw one card. */
export interface CardSlot {
  id: string;
  /** The rank pastille's number, in a column when the order counts. */
  rank: number | null;
  selected: boolean;
  /** Toggles the click-then-click selection. */
  toggle: () => void;
  /** Spread on the element the drag starts from: pointer and keyboard. */
  handle: HTMLAttributes<HTMLElement> & { ref: (node: HTMLElement | null) => void };
  /** The placeholder of a card being dragged (its twin follows the pointer). */
  dragging: boolean;
}

export interface BoardProps {
  /** Display order; the label names a zone for the "drop here" buttons. */
  columns: readonly { id: string; label: string }[];
  placement: Placement;
  /** The cards in no column, in display order. */
  tray: readonly string[];
  ordered: boolean;
  locked: boolean;
  onMove: (card: string, target: string | null, index?: number) => void;
  renderCard: (slot: CardSlot) => ReactNode;
  /** The card as it follows the pointer. */
  renderOverlay: (id: string) => ReactNode;
  /** The inside of a column's header (its name, its count, its bin). */
  columnHead: (column: { id: string; label: string }, count: number) => ReactNode;
  trayHead: ReactNode;
  trayFoot?: ReactNode;
  /** The faint word of an empty zone. */
  emptyColumn: string;
  emptyTray: string;
  dropHere: string;
  /** `{column}` template. */
  dropInto: string;
  dropIntoTray: string;
}

export function Board(props: BoardProps) {
  const { columns, placement, tray, ordered, locked, onMove } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [overZone, setOverZone] = useState<string | null>(null);

  // A card that left the board, or a board that locked, holds no selection.
  const known = selected !== null && (tray.includes(selected) || Object.values(placement).some((ids) => ids.includes(selected)));
  const current = locked || !known ? null : selected;

  /**
   * The handles, by card id, so a card moved by the keyboard keeps the
   * focus: its "drop here" button vanishes with the selection, and the focus
   * would otherwise fall to the page.
   */
  const handles = useRef(new Map<string, HTMLElement>());
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  useEffect(() => {
    if (focusAfter === null) return;
    handles.current.get(focusAfter)?.focus();
    setFocusAfter(null);
  }, [focusAfter]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Enter is the click-then-click move's key; Space alone picks a card up.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  /** The zone a dnd id belongs to: the tray, a column's zone, or the zone of the card it names. */
  const zoneOf = (dndId: string): string => {
    const card = cardOf(dndId);
    if (card === null) return dndId;
    for (const [column, ids] of Object.entries(placement)) if (ids.includes(card)) return colKey(column);
    return TRAY;
  };

  const drop = (card: string, target: string | null, index?: number) => {
    onMove(card, target, index);
    setSelected(null);
  };

  function onDragStart(event: DragStartEvent) {
    setSelected(null);
    setActive(cardOf(String(event.active.id)));
  }

  function onDragOver(event: DragOverEvent) {
    setOverZone(event.over ? zoneOf(String(event.over.id)) : null);
  }

  function onDragEnd(event: DragEndEvent) {
    setActive(null);
    setOverZone(null);
    const { active: dragged, over } = event;
    if (!over) return;
    const card = cardOf(String(dragged.id));
    if (card === null) return;
    const overId = String(over.id);
    const target = columnOf(zoneOf(overId));
    if (target === null) {
      drop(card, null);
      return;
    }
    // Over a card: its place in its column; over the zone itself: the end.
    const overCard = cardOf(overId);
    const index = overCard === null ? -1 : (placement[target] ?? []).indexOf(overCard);
    drop(card, target, index === -1 ? undefined : index);
  }

  const zone = (key: string, ids: readonly string[], target: string | null, name: string, empty: string) => (
    <Zone
      key={key}
      dndId={key}
      ids={ids}
      row={target === null}
      over={overZone === key}
      locked={locked}
      selected={current}
      empty={empty}
      dropLabel={target === null ? props.dropIntoTray : fmt(props.dropInto, { column: name })}
      dropHere={props.dropHere}
      onDrop={() => {
        if (current === null) return;
        drop(current, target);
        setFocusAfter(current);
      }}
    >
      {ids.map((id, index) => (
        <SortableCard
          key={id}
          id={id}
          disabled={locked}
          row={target === null}
          render={(handle, dragging) =>
            props.renderCard({
              id,
              rank: ordered && target !== null ? index + 1 : null,
              selected: current === id,
              toggle: () => setSelected(current === id ? null : id),
              handle: {
                ...handle,
                ref: (node) => {
                  handle.ref(node);
                  if (node) handles.current.set(id, node);
                  else handles.current.delete(id);
                },
              },
              dragging,
            })
          }
        />
      ))}
    </Zone>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActive(null);
        setOverZone(null);
      }}
    >
      <div
        className="flex flex-col gap-4"
        onKeyDown={(e) => {
          if (e.key === "Escape" && current !== null) setSelected(null);
        }}
      >
        <div className={trayFrame}>
          {props.trayHead}
          {zone(TRAY, tray, null, "", props.emptyTray)}
          {props.trayFoot}
        </div>

        <div className={columnGrid}>
          {columns.map((column) => {
            const ids = placement[column.id] ?? [];
            return (
              <ColumnFrame key={column.id} head={props.columnHead(column, ids.length)}>
                {zone(colKey(column.id), ids, column.id, column.label, props.emptyColumn)}
              </ColumnFrame>
            );
          })}
        </div>
      </div>

      <DragOverlay dropAnimation={null}>{active === null ? null : props.renderOverlay(active)}</DragOverlay>
    </DndContext>
  );
}

/**
 * One drop zone: the tray (a wrapping row) or the body of a column (a
 * stack). It is a droppable of its own, so an EMPTY column still takes a
 * card, and it lights in `info-soft` while a card hovers over it.
 */
function Zone({
  dndId,
  ids,
  row,
  over,
  locked,
  selected,
  empty,
  dropLabel,
  dropHere,
  onDrop,
  children,
}: {
  dndId: string;
  ids: readonly string[];
  row: boolean;
  over: boolean;
  locked: boolean;
  selected: string | null;
  empty: string;
  dropLabel: string;
  dropHere: string;
  onDrop: () => void;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: dndId, disabled: locked });
  const armed = selected !== null && !ids.includes(selected);
  return (
    <div
      ref={setNodeRef}
      className={cx(
        "flex transition-colors duration-120 motion-reduce:transition-none",
        row ? "min-h-10 flex-col gap-2 rounded-field" : "min-h-30 flex-1 flex-col gap-1.5 rounded-b-card p-2",
        over && "bg-info-soft",
      )}
      // The pointer may drop anywhere on the zone; the keyboard has the button below.
      onClick={(e) => {
        if (armed && !(e.target as HTMLElement).closest("[data-card]")) onDrop();
      }}
    >
      <SortableContext
        items={ids.map(cardKey)}
        strategy={row ? rectSortingStrategy : verticalListSortingStrategy}
      >
        {ids.length > 0 ? (
          <ul className={cx("flex gap-1.5", row ? "flex-row flex-wrap" : "flex-col")}>{children}</ul>
        ) : armed ? null : (
          <p className={cx("m-auto px-2 text-center text-xs text-fg-faint", row && "py-2")}>{empty}</p>
        )}
      </SortableContext>
      {armed ? (
        <button
          type="button"
          aria-label={dropLabel}
          className={cx(
            "rounded-field border border-dashed border-info px-2 py-1.5 text-xs font-medium text-info",
            "transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            ids.length === 0 && !row && "m-auto w-full",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onDrop();
          }}
        >
          {dropHere}
        </button>
      ) : null}
    </div>
  );
}

function SortableCard({
  id,
  disabled,
  row,
  render,
}: {
  id: string;
  disabled: boolean;
  row: boolean;
  render: (handle: CardSlot["handle"], dragging: boolean) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: cardKey(id),
    disabled,
  });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), ...(transition ? { transition } : {}) };
  return (
    <li ref={setNodeRef} style={style} data-card={id} className={cx("min-w-0", row ? "max-w-full" : "w-full", isDragging && "opacity-40")}>
      {render(
        // The listeners are dnd-kit's `onPointerDown` / `onKeyDown`: DOM event
        // handlers by construction, whatever its looser map type says.
        { ...attributes, ...(listeners as HTMLAttributes<HTMLElement> | undefined), ref: setActivatorNodeRef },
        isDragging,
      )}
    </li>
  );
}

/** The card following the pointer: the one shadow of the board (a floating layer). */
export function OverlayCard({ children }: { children: ReactNode }) {
  return <div className={cx(cardClass, cardTone.neutral, "cursor-grabbing shadow-popover")}>{children}</div>;
}
