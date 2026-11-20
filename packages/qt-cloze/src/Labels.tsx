/**
 * The labels presentation of a cloze's dropdown blanks (ADR-138): a tray of
 * labels pinned over the text, and a GAP where each dropdown was. A
 * presentation only: a placed label stores exactly what picking it in the
 * dropdown stores — its option's `id` in that blank, the displayed position
 * the view gave it (ADR-097) — looked up by the label's text in the gap's own
 * options. Nothing here reaches the server that the dropdown does not send.
 *
 * Two ways to place a label:
 *
 *  - CLICK THEN CLICK, as on the categorize board, the one keyboard path:
 *    select a label (`aria-pressed`), then a gap of its group; Enter and
 *    Space are the buttons' own click. Escape lets go; a filled gap activated
 *    with nothing selected empties.
 *  - DRAG, with dnd-kit's pointer sensor after 4 px of slop (a click stays a
 *    click). A placed label moves to another gap of its group, or out of
 *    every gap, which empties its own.
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
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { fmt } from "@quiz/core/client";
import { CLOZE_MAX_LABEL_GROUPS, CLOZE_SENTINEL_PATTERN, clozeLabelGroups } from "@quiz/domain/cloze";
import { cx } from "@quiz/ui";

import type { ClozeStudent } from "./schema.js";
import type { clozePlayerStrings } from "./strings.js";
import { splitBlocks } from "./text.js";

type Strings = { [K in keyof typeof clozePlayerStrings]: string };
type SelectBlank = Extract<ClozeStudent["blanks"][number], { kind: "select" }>;

/** A table of one entry per group: its length is checked against the cap. */
type PerGroup<T> = readonly T[] & { length: typeof CLOZE_MAX_LABEL_GROUPS };

/**
 * The hue of each group, in order of first appearance (DESIGN.md, "The cloze
 * labels"): the categorical `--chart-*` slots, never the verdict's green and
 * red (`chart-6`, `chart-8`), the most distinct first.
 */
const GROUP_HUES = ["--chart-1", "--chart-2", "--chart-7", "--chart-5", "--chart-4", "--chart-3"] as const satisfies PerGroup<string>;

/** The shape of each group, beside its hue: colour is never the only cue. */
const GROUP_SHAPES = [
  <circle key="circle" cx="5" cy="5" r="4.5" />,
  <rect key="square" x="0.75" y="0.75" width="8.5" height="8.5" rx="1" />,
  <path key="triangle" d="M5 0.5 9.75 9.25H.25z" />,
  <path key="diamond" d="M5 0 10 5 5 10 0 5z" />,
  <circle key="ring" cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="2" />,
  <path key="star" d="m5 .2 1.45 3.1 3.35.35-2.5 2.3.7 3.35L5 7.6 2 9.3l.7-3.35-2.5-2.3 3.35-.35z" />,
] as const satisfies PerGroup<ReactNode>;

/**
 * A group's look, classes included: border and fill apart, since `cx` merges
 * no class and a state replaces one of them.
 */
interface Tone {
  /** Sets `--g`, the group's hue, for the classes below. */
  style: CSSProperties | undefined;
  shape: ReactNode;
  border: string;
  fill: string;
  /** The dashed border of an empty gap. */
  emptyBorder: string;
  hover: string;
}

/** The only group, or a draft's group past the cap (publication refuses it): no hue, no shape. */
const NEUTRAL: Tone = {
  style: undefined,
  shape: null,
  border: "border-line-strong",
  fill: "bg-surface",
  emptyBorder: "border-line-strong",
  hover: "hover:border-fg-faint",
};

function toneOf(group: number, count: number): Tone {
  const hue = GROUP_HUES[group];
  if (count < 2 || hue === undefined) return NEUTRAL;
  return {
    style: { "--g": `var(${hue})` } as CSSProperties,
    shape: (
      // The shape's ink is the hue pulled toward the text colour: a yellow
      // alone would not hold 3:1 on the light surface.
      <svg aria-hidden viewBox="0 0 10 10" className="size-2.5 shrink-0 fill-current text-[color-mix(in_srgb,var(--g)_70%,var(--fg))]">
        {GROUP_SHAPES[group]}
      </svg>
    ),
    border: "border-[color-mix(in_srgb,var(--g)_45%,var(--line-strong))]",
    fill: "bg-[color-mix(in_srgb,var(--g)_9%,var(--surface))]",
    emptyBorder: "border-[color-mix(in_srgb,var(--g)_55%,var(--line-strong))]",
    hover: "hover:border-(--g)",
  };
}

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
 * A pointer drag says nothing: the gap's own name carries the result. Every
 * callback answers, so dnd-kit's English defaults are never heard.
 */
const SILENT: Announcements = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragMove: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

/** The blanks inside a fenced code block, whose labels are set in the mono face. */
function blanksInCode(template: string): Set<number> {
  const out = new Set<number>();
  for (const block of splitBlocks(template)) {
    if (block.kind !== "code") continue;
    for (const match of block.content.matchAll(new RegExp(CLOZE_SENTINEL_PATTERN, "g"))) out.add(Number(match[1]));
  }
  return out;
}

/**
 * The tray stays in sight while the text scrolls: under the host's sticky
 * bars, whose height the host gives in `--sticky-top` (0 when unset). It
 * takes at most a third of the window and scrolls on its own, and on a low
 * window it is not pinned at all, so bars, tray and a phone's keyboard can
 * never fill the screen (N-A11Y-04).
 */
const PINNED =
  "[@media(min-height:40rem)]:sticky [@media(min-height:40rem)]:top-[var(--sticky-top,0px)] [@media(min-height:40rem)]:z-10 [@media(min-height:40rem)]:max-h-[33dvh] [@media(min-height:40rem)]:overflow-y-auto";

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

/** The label `blank` holds, by the option `id` stored for it. */
const labelIn = (blank: SelectBlank, value: string | null | undefined): string | null =>
  value === null || value === undefined || value === ""
    ? null
    : (blank.options.find((option) => String(option.id) === value)?.label ?? null);

/** The option of `blank` that shows `label`: what the dropdown would have stored. */
const valueOf = (blank: SelectBlank, label: string): string | null => {
  const option = blank.options.find((o) => o.label === label);
  return option === undefined ? null : String(option.id);
};

/** The blanks a drop writes at once, each to its new value: one answer, never two. */
export type DropChanges = readonly (readonly [index: number, value: string])[];

/**
 * What dropping `label` writes (exported for its test). `target` is the gap
 * it lands in, `undefined` outside every gap; `from` the gap it left, `null`
 * from the tray. Into a gap: the option of THAT blank showing the label, and
 * the gap it left empties in the same answer. Outside: the gap it left
 * empties. Back into its own gap, or into a gap with no such option: nothing.
 */
export function dropChanges(target: SelectBlank | undefined, label: string, from: number | null): DropChanges {
  if (target === undefined) return from === null ? [] : [[from, ""]];
  const value = valueOf(target, label);
  if (value === null || from === target.index) return [];
  return from === null ? [[target.index, value]] : [[from, ""], [target.index, value]];
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const blankAt = (index: number | null) =>
    student.blanks.find((b): b is SelectBlank => b.index === index && b.kind === "select");
  const drop = (target: SelectBlank | undefined, label: string, from: number | null) => {
    const changes = dropChanges(target, label, from);
    if (changes.length > 0) write(changes);
  };

  const onGap = (blank: SelectBlank) => {
    if (locked) return;
    if (selected !== null) {
      if (groupOf.get(blank.index) !== selected.group) return;
      drop(blank, selected.label, null);
      setPicked(null);
      return;
    }
    if (labelIn(blank, given[blank.index]) !== null) write([[blank.index, ""]]);
  };

  function onDragEnd(event: DragEndEvent) {
    const moving = carried;
    setCarried(null);
    setOver(null);
    if (moving !== null) drop(blankAt(gapIndexOf(event.over?.id)), moving.label, moving.from);
  }

  const renderGap = (blank: SelectBlank): ReactNode => {
    const group = groupOf.get(blank.index) ?? 0;
    return (
      <Gap
        index={blank.index}
        group={group}
        groupCount={groups.length}
        sizes={groups[group]?.labels ?? []}
        label={labelIn(blank, given[blank.index])}
        expected={expected.get(blank.index)}
        tone={tones[group] ?? NEUTRAL}
        locked={locked}
        armed={armed === null ? null : armed === group}
        over={over === blank.index}
        source={carried?.from === blank.index}
        s={s}
        onActivate={() => onGap(blank)}
      />
    );
  };

  return (
    <DndContext
      accessibility={{ announcements: SILENT, screenReaderInstructions: { draggable: s.hintLabels } }}
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={({ active }) => {
        setPicked(null);
        setCarried((active.data.current as Carried | undefined) ?? null);
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
              tones[carried.group]?.border,
              tones[carried.group]?.fill,
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
  locked,
  selected,
  dragging,
  s,
  onToggle,
}: {
  id: string;
  carried: Carried;
  tone: Tone;
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
        selected ? "border-info bg-surface ring-2 ring-info-soft" : cx(tone.border, tone.fill),
        locked ? "cursor-default opacity-80" : "cursor-grab active:cursor-grabbing",
        !locked && !selected && tone.hover,
        dragging && "opacity-40",
      )}
    >
      {tone.shape}
      {carried.label}
    </button>
  );
}

/**
 * A gap's state, by precedence: the target of the label on its way, the
 * key's, or at rest. Its border and fill are looked up by it.
 */
type GapState = "target" | "key" | "rest";
const GAP_BORDER: Record<Exclude<GapState, "rest">, string> = { target: "border-info", key: "border-success/60" };

function Gap({
  index,
  group,
  groupCount,
  sizes,
  label,
  expected,
  tone,
  locked,
  armed,
  over,
  source,
  s,
  onActivate,
}: {
  index: number;
  group: number;
  /** How many groups the text has: with several, the gap's name says its own. */
  groupCount: number;
  /** Every label of the group, laid in the gap's one grid cell so it is as wide as the widest. */
  sizes: readonly string[];
  label: string | null;
  expected: string | undefined;
  tone: Tone;
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
  const vars = { n: index + 1, g: group + 1, label: label ?? "" };
  const name =
    groupCount > 1
      ? fmt(filled ? s.gapFilledGroup : s.gapEmptyGroup, vars)
      : fmt(filled ? s.gapFilled : s.gapEmpty, vars);
  // With the key, the expected answer sits in the gap like the dropdown's
  // empty option, and the gap is sized for it too.
  const cells = expected === undefined ? sizes : [...sizes, expected];
  const state: GapState = over || armed === true ? "target" : expected !== undefined ? "key" : "rest";
  const border = state === "rest" ? (filled ? tone.border : tone.emptyBorder) : GAP_BORDER[state];
  const fill = state === "target" ? "bg-info-soft" : filled ? tone.fill : "bg-surface-2";
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
      // A label of another group is on its way: this gap refuses it, and says so.
      aria-disabled={armed === false || undefined}
      title={expected === undefined ? undefined : `${s.expected}: ${expected}`}
      disabled={locked}
      onClick={onActivate}
      style={tone.style}
      className={cx(
        "mx-0.5 inline-grid max-w-full rounded-field border-[1.5px] px-2.5 py-0.5 align-middle text-sm leading-snug text-fg select-none [pre_&]:text-[13px]",
        "transition-[background-color,border-color,opacity] duration-120 motion-reduce:transition-none",
        border,
        fill,
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
