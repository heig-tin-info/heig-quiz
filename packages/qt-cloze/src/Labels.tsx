/**
 * The labels presentation of a cloze's dropdown blanks (ADR-138): a tray of
 * labels pinned over the text, and a GAP where each dropdown was. A
 * presentation only: a placed label stores exactly what picking it in the
 * dropdown stores — its option's `id` in that blank, the displayed position
 * the view gave it (ADR-097) — looked up by the label's text in the gap's own
 * options. Nothing here reaches the server that the dropdown does not send.
 *
 * Two ways to place a label, as on the categorize board:
 *
 *  - CLICK THEN CLICK (Enter then Enter): select a label (`aria-pressed`),
 *    then a gap of its group. Escape lets go; a filled gap activated with
 *    nothing selected empties.
 *  - DRAG, with dnd-kit: the pointer after 4 px of slop (a click stays a
 *    click), or the keyboard — Space picks up, the arrows go from gap to gap
 *    of the group, Space or Enter drops. A placed label moves to another gap
 *    of its group, or out of every gap, which empties its own.
 *
 * Never a native HTML5 drag: nothing here is `draggable` and the labels are
 * `user-select: none`, so the integrity journal (its `dragstart` / `drop`
 * listeners) sees nothing of it.
 *
 * Labels are reusable: a placed label stays in the tray. A group is the set
 * of dropdowns offering the same labels (`clozeLabelGroups`); with several,
 * each has a hue AND a shape, so colour is never the only cue, and a gap
 * refuses a label of another group.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { fmt } from "@quiz/core/client";
import { clozeLabelGroups } from "@quiz/domain/cloze";
import { cx } from "@quiz/ui";

import type { ClozeStudent } from "./schema.js";
import type { clozePlayerStrings } from "./strings.js";
import { splitBlocks } from "./text.js";

type Strings = { [K in keyof typeof clozePlayerStrings]: string };
type SelectBlank = Extract<ClozeStudent["blanks"][number], { kind: "select" }>;

/**
 * The hue of each group, in order of first appearance (DESIGN.md, "The cloze
 * labels"): the categorical `--chart-*` slots, never the verdict's green and
 * red (`chart-6`, `chart-8`), the most distinct first.
 */
const GROUP_HUES = ["--chart-1", "--chart-2", "--chart-7", "--chart-5", "--chart-4", "--chart-3"] as const;

/** The shape of each group, beside its hue: colour is never the only cue. */
const GROUP_SHAPES: readonly ReactNode[] = [
  <circle key="circle" cx="5" cy="5" r="4.5" />,
  <rect key="square" x="0.75" y="0.75" width="8.5" height="8.5" rx="1" />,
  <path key="triangle" d="M5 0.5 9.75 9.25H.25z" />,
  <path key="diamond" d="M5 0 10 5 5 10 0 5z" />,
  <circle key="ring" cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="2" />,
  <path key="star" d="m5 .2 1.45 3.1 3.35.35-2.5 2.3.7 3.35L5 7.6 2 9.3l.7-3.35-2.5-2.3 3.35-.35z" />,
];

/** A group's look: neutral when it is the only one, its hue and shape otherwise. */
interface Tone {
  /** Sets `--g`, the group's hue, for the classes below. */
  style: CSSProperties | undefined;
  shape: ReactNode;
}

function toneOf(group: number, count: number): Tone {
  if (count < 2) return { style: undefined, shape: null };
  return {
    style: { "--g": `var(${GROUP_HUES[group % GROUP_HUES.length]})` } as CSSProperties,
    shape: (
      // The shape's ink is the hue pulled toward the text colour: a yellow
      // alone would not hold 3:1 on the light surface.
      <svg aria-hidden viewBox="0 0 10 10" className="size-2.5 shrink-0 fill-current text-[color-mix(in_srgb,var(--g)_70%,var(--fg))]">
        {GROUP_SHAPES[group % GROUP_SHAPES.length]}
      </svg>
    ),
  };
}

/**
 * A label at rest, in the tray or placed in a gap: the group's tint, or a
 * neutral chip. Border and fill apart, since `cx` merges no class and a state
 * replaces one of them.
 */
const HUE_BORDER = "border-[color-mix(in_srgb,var(--g)_45%,var(--line-strong))]";
const HUE_FILL = "bg-[color-mix(in_srgb,var(--g)_9%,var(--surface))]";
const tinted = (grouped: boolean): string => (grouped ? cx(HUE_BORDER, HUE_FILL) : "border-line-strong bg-surface");

/** What a drag carries: the label, its group, and the gap it left (`null` from the tray). */
interface Carried {
  group: number;
  label: string;
  from: number | null;
}

const trayId = (group: number, position: number) => `label:${group}:${position}`;
const moveId = (index: number) => `move:${index}`;
const gapId = (index: number) => `gap:${index}`;
const gapIndexOf = (id: UniqueIdentifier | undefined): number | null =>
  typeof id === "string" && id.startsWith("gap:") ? Number(id.slice("gap:".length)) : null;

/**
 * The pointer drops only INTO a gap — anywhere else is out, which empties a
 * moved label's gap; the keyboard, which has no pointer, lands on the gap its
 * arrows reached.
 */
const collision: CollisionDetection = (args) => (args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args));

/**
 * The keyboard's arrows go from gap to gap of the label's group, in the order
 * of the text: Right and Down to the next, Left and Up to the previous. The
 * gaps of other groups are disabled droppables during a drag, so they are not
 * in the list.
 */
const gapToGap: KeyboardCoordinateGetter = (event, { context: { active, droppableContainers, droppableRects, over } }) => {
  const step = event.code === "ArrowRight" || event.code === "ArrowDown" ? 1 : event.code === "ArrowLeft" || event.code === "ArrowUp" ? -1 : 0;
  if (step === 0) return undefined;
  event.preventDefault();
  const gaps = droppableContainers
    .getEnabled()
    .flatMap((container) => {
      const index = gapIndexOf(container.id);
      const rect = droppableRects.get(container.id);
      return index === null || rect === undefined ? [] : [{ id: container.id, index, rect }];
    })
    .sort((a, b) => a.index - b.index);
  if (gaps.length === 0) return undefined;
  // From the gap the arrows reached, or else the one the label left.
  const from = over?.id ?? gapId((active?.data.current as Carried | undefined)?.from ?? -1);
  const at = gaps.findIndex((gap) => gap.id === from);
  const next = at === -1 ? (step === 1 ? gaps[0] : gaps.at(-1)) : gaps[at + step];
  return next === undefined ? undefined : { x: next.rect.left, y: next.rect.top };
};

/** The blanks inside a fenced code block, whose labels are set in the mono face. */
function blanksInCode(template: string): Set<number> {
  const out = new Set<number>();
  for (const block of splitBlocks(template)) {
    if (block.kind !== "code") continue;
    for (const match of block.content.matchAll(/⸢(\d+)⸣/g)) out.add(Number(match[1]));
  }
  return out;
}

/**
 * The tray stays in sight while the text scrolls: under the host's sticky
 * bars, whose height the host gives in `--cloze-tray-top` (0 when unset). It
 * takes at most a third of the window and scrolls on its own, and on a low
 * window it is not pinned at all, so bars, tray and a phone's keyboard can
 * never fill the screen (N-A11Y-04).
 */
const PINNED =
  "[@media(min-height:40rem)]:sticky [@media(min-height:40rem)]:top-[var(--cloze-tray-top,0px)] [@media(min-height:40rem)]:z-10 [@media(min-height:40rem)]:max-h-[33dvh] [@media(min-height:40rem)]:overflow-y-auto";

export interface LabelsPlayerProps {
  student: ClozeStudent;
  given: readonly (string | null)[];
  locked: boolean;
  /** The expected answer of each blank, with the key (a teacher's preview, #554). */
  expected: ReadonlyMap<number, string>;
  s: Strings;
  /** Writes blanks at once: a moved label leaves one gap and fills another in ONE answer. */
  write: (changes: readonly (readonly [index: number, value: string])[]) => void;
  /** The text with its blanks; the dropdowns are the gaps given here. */
  renderText: (renderGap: (blank: SelectBlank) => ReactNode) => ReactNode;
}

export function LabelsPlayer({ student, given, locked, expected, s, write, renderText }: LabelsPlayerProps) {
  const groups = clozeLabelGroups(student.blanks);
  const groupOf = new Map(groups.flatMap((group, g) => group.blanks.map((index) => [index, g] as const)));
  const inCode = blanksInCode(student.template);
  const codeGroups = new Set(groups.flatMap((group, g) => (group.blanks.some((index) => inCode.has(index)) ? [g] : [])));
  const tones = groups.map((_, g) => toneOf(g, groups.length));

  const [picked, setPicked] = useState<{ group: number; label: string } | null>(null);
  const [carried, setCarried] = useState<Carried | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const selected = locked ? null : picked;
  /** The group a label is on its way to, by a selection or a drag. */
  const armed = carried?.group ?? selected?.group ?? null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: gapToGap,
      // Enter is the click-then-click move's key; Space alone picks a label up.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const blankAt = (index: number) => student.blanks.find((b): b is SelectBlank => b.index === index && b.kind === "select");
  const labelIn = (index: number): string | null => {
    const value = given[index];
    if (value === null || value === undefined || value === "") return null;
    return blankAt(index)?.options.find((option) => String(option.id) === value)?.label ?? null;
  };
  /** The option of `index` that shows `label`: what the dropdown would have stored. */
  const valueOf = (index: number, label: string): string | null => {
    const option = blankAt(index)?.options.find((o) => o.label === label);
    return option === undefined ? null : String(option.id);
  };

  const place = (index: number, label: string, from: number | null) => {
    const value = valueOf(index, label);
    if (value === null || from === index) return;
    write(from === null ? [[index, value]] : [[from, ""], [index, value]]);
  };

  const onGap = (index: number) => {
    if (locked) return;
    if (selected !== null) {
      if (groupOf.get(index) !== selected.group) return;
      place(index, selected.label, null);
      setPicked(null);
      return;
    }
    if (labelIn(index) !== null) write([[index, ""]]);
  };

  function onDragEnd(event: DragEndEvent) {
    const moving = carried;
    setCarried(null);
    setOver(null);
    if (moving === null) return;
    const target = gapIndexOf(event.over?.id);
    if (target !== null) place(target, moving.label, moving.from);
    else if (moving.from !== null) write([[moving.from, ""]]);
  }

  /** What a screen reader hears of a drag, in the reader's language. */
  const carriedOf = (data: { current?: unknown } | undefined) => (data?.current ?? { label: "", from: null }) as Carried;
  const announcements: Announcements = {
    onDragStart: ({ active }) => fmt(s.dragStart, { label: carriedOf(active.data).label }),
    onDragOver: ({ active, over: target }) => {
      const index = gapIndexOf(target?.id);
      return index === null ? undefined : fmt(s.dragOver, { label: carriedOf(active.data).label, n: index + 1 });
    },
    onDragEnd: ({ active, over: target }) => {
      const { label, from } = carriedOf(active.data);
      const index = gapIndexOf(target?.id);
      if (index !== null) return fmt(s.dragEnd, { label, n: index + 1 });
      return from === null ? fmt(s.dragCancel, { label }) : fmt(s.dragEmptied, { n: from + 1 });
    },
    onDragCancel: ({ active }) => fmt(s.dragCancel, { label: carriedOf(active.data).label }),
  };

  const renderGap = (blank: SelectBlank): ReactNode => {
    const group = groupOf.get(blank.index) ?? 0;
    const label = labelIn(blank.index);
    return (
      <Gap
        index={blank.index}
        group={group}
        sizes={groups[group]?.labels ?? []}
        label={label}
        expected={expected.get(blank.index)}
        tone={tones[group]!}
        grouped={groups.length > 1}
        locked={locked}
        armed={armed === null ? null : armed === group}
        over={over === blank.index}
        source={carried?.from === blank.index}
        s={s}
        onActivate={() => onGap(blank.index)}
      />
    );
  };

  return (
    <DndContext
      accessibility={{ announcements, screenReaderInstructions: { draggable: s.dragHelp } }}
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={({ active }) => {
        setPicked(null);
        setCarried(carriedOf(active.data));
      }}
      onDragOver={({ over: target }) => setOver(gapIndexOf(target?.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setCarried(null);
        setOver(null);
      }}
    >
      <div
        className="flex flex-col gap-3"
        onKeyDown={(e) => {
          if (e.key === "Escape" && selected !== null) setPicked(null);
        }}
      >
        <div className={cx("flex flex-col gap-2 rounded-card border border-line bg-surface-2 p-3", PINNED)}>
          {groups.map((group, g) => (
            <div
              key={g}
              role="group"
              aria-label={groups.length > 1 ? fmt(s.group, { n: g + 1 }) : s.labels}
              className={cx("flex flex-wrap items-center gap-1.5", codeGroups.has(g) && "font-mono")}
              style={tones[g]!.style}
            >
              {group.labels.map((label, position) => (
                <TrayLabel
                  key={label}
                  id={trayId(g, position)}
                  carried={{ group: g, label, from: null }}
                  tone={tones[g]!}
                  grouped={groups.length > 1}
                  locked={locked}
                  selected={selected?.group === g && selected.label === label}
                  dragging={carried?.from === null && carried.group === g && carried.label === label}
                  s={s}
                  onToggle={() => setPicked(selected?.group === g && selected.label === label ? null : { group: g, label })}
                />
              ))}
            </div>
          ))}
        </div>
        {renderText(renderGap)}
      </div>

      <DragOverlay dropAnimation={null}>
        {carried === null ? null : (
          <span
            style={tones[carried.group]?.style}
            className={cx(
              CHIP,
              tinted(groups.length > 1),
              "cursor-grabbing shadow-popover",
              codeGroups.has(carried.group) && "font-mono",
            )}
          >
            {tones[carried.group]?.shape}
            {carried.label}
          </span>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/** A label's frame, in the tray and following the pointer. */
const CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-field border px-2.5 py-1 text-left text-sm leading-snug text-fg select-none [overflow-wrap:anywhere]";

function TrayLabel({
  id,
  carried,
  tone,
  grouped,
  locked,
  selected,
  dragging,
  s,
  onToggle,
}: {
  id: string;
  carried: Carried;
  tone: Tone;
  grouped: boolean;
  locked: boolean;
  selected: boolean;
  dragging: boolean;
  s: Strings;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id,
    data: carried,
    disabled: locked,
    attributes: { roleDescription: s.dragRole },
  });
  return (
    <button
      type="button"
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-pressed={selected}
      disabled={locked}
      onClick={onToggle}
      className={cx(
        CHIP,
        "touch-none transition-colors duration-120 motion-reduce:transition-none",
        selected ? "border-info bg-surface ring-2 ring-info-soft" : tinted(grouped),
        locked ? "cursor-default opacity-80" : "cursor-grab active:cursor-grabbing",
        !locked && !selected && (grouped ? "hover:border-(--g)" : "hover:border-fg-faint"),
        dragging && "opacity-40",
      )}
    >
      {tone.shape}
      {carried.label}
    </button>
  );
}

function Gap({
  index,
  group,
  sizes,
  label,
  expected,
  tone,
  grouped,
  locked,
  armed,
  over,
  source,
  s,
  onActivate,
}: {
  index: number;
  group: number;
  /** Every label of the group, laid in the gap's one grid cell so it is as wide as the widest. */
  sizes: readonly string[];
  label: string | null;
  expected: string | undefined;
  tone: Tone;
  grouped: boolean;
  locked: boolean;
  /** Whether the label on its way belongs here: `null` when none is. */
  armed: boolean | null;
  over: boolean;
  /** The label being dragged left this gap. */
  source: boolean;
  s: Strings;
  onActivate: () => void;
}) {
  const filled = label !== null;
  const drag = useDraggable({
    id: moveId(index),
    data: { group, label: label ?? "", from: index } satisfies Carried,
    disabled: locked || !filled,
    attributes: { roleDescription: s.dragRole },
  });
  const drop = useDroppable({ id: gapId(index), disabled: locked || armed === false });
  const name = filled ? fmt(s.gapFilled, { n: index + 1, label }) : fmt(s.gapEmpty, { n: index + 1 });
  // With the key, the expected answer sits in the gap like the dropdown's
  // empty option, and the gap is sized for it too.
  const cells = expected === undefined ? sizes : [...sizes, expected];
  // One border colour and one fill each, by precedence: the drop target, the
  // key, the group's hue, the neutral hairline.
  const border =
    over || armed === true
      ? "border-info"
      : expected !== undefined
        ? "border-success/60"
        : grouped
          ? filled
            ? HUE_BORDER
            : "border-[color-mix(in_srgb,var(--g)_55%,var(--line-strong))]"
          : "border-line-strong";
  const fill = armed === true ? "bg-info-soft" : filled ? (grouped ? HUE_FILL : "bg-surface") : "bg-surface-2";
  return (
    <button
      type="button"
      ref={(node) => {
        drag.setNodeRef(node);
        drop.setNodeRef(node);
      }}
      {...(filled ? drag.attributes : {})}
      {...(filled ? drag.listeners : {})}
      aria-label={name}
      title={expected === undefined ? undefined : `${s.expected}: ${expected}`}
      disabled={locked}
      onClick={onActivate}
      style={tone.style}
      className={cx(
        "mx-0.5 inline-grid max-w-full rounded-field px-2.5 py-0.5 align-middle text-sm leading-snug text-fg select-none [pre_&]:text-[13px]",
        "transition-[background-color,border-color,opacity] duration-120 motion-reduce:transition-none",
        border,
        fill,
        "border-[1.5px]",
        filled || over ? "border-solid" : "border-dashed",
        over && "ring-2 ring-info-soft",
        armed === false && "opacity-40",
        locked ? "cursor-default" : filled ? "cursor-grab touch-none active:cursor-grabbing" : "cursor-pointer",
      )}
    >
      {cells.map((text, i) => (
        <span key={i} aria-hidden className="invisible inline-flex items-center gap-1.5 [grid-area:1/1]">
          {tone.shape}
          {text}
        </span>
      ))}
      <span
        aria-hidden
        className={cx(
          "inline-flex items-center justify-center gap-1.5 [grid-area:1/1]",
          source && "opacity-30",
          !filled && expected !== undefined && "font-mono text-success",
        )}
      >
        {tone.shape}
        {label ?? expected ?? " "}
      </span>
    </button>
  );
}
