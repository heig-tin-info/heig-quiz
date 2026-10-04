/**
 * The board of a group set (ADR-070 §3, M3-16a): the students in no group,
 * a column that stays in sight, beside the set's groups in a wrapping grid
 * (a class of a hundred makes some thirty groups). It owns no placement: it
 * draws the set it is given and reports every move through `onMove`.
 *
 * Three ways to move a student, after the categorize board
 * (`packages/qt-categorize/src/Board.tsx`, whose pattern this copies, never
 * imports):
 *
 *  - DRAG, with dnd-kit: the pointer after 4 px of slop (a click stays a
 *    click), or the keyboard — Space picks the student up, the arrows walk
 *    the zones in their reading order, Space or Enter drops;
 *  - CLICK THEN CLICK (or Enter then Enter): select a student, then a
 *    group. While one is selected every other zone grows a real "Move here"
 *    button with a real name;
 *  - the "Move to…" menu of each student: every group, and No group.
 *
 * Read-only (an archived classroom): nothing moves, nothing is renamed.
 */
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type Announcements,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { CircleDashed, GripVertical, MoveRight, PenLine, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";

import type { GroupSetDetail, GroupStudent } from "@quiz/contracts";

import { useT } from "../i18n";
import { cx, IconButton, inputClass, inputSize, Menu, Tip, type MenuItem } from "../ui";
import { overMax, placeOf, stepZone, studentName, studentOf } from "./groupRules";

/** The dnd id of the "No group" zone; a group's zone is `g:<id>`, a student `s:<enrollment id>`. */
const NONE = "none";
const zoneKey = (groupId: string | null) => (groupId === null ? NONE : `g:${groupId}`);
const groupOfZone = (key: string): string | null => (key === NONE ? null : key.slice(2));
const dragKey = (enrollmentId: string) => `s:${enrollmentId}`;
const studentOfDrag = (id: string): string | null => (id.startsWith("s:") ? id.slice(2) : null);

/** The frame of a zone: the hairline card the categorize columns wear. */
const zoneFrame = "flex min-w-0 flex-col rounded-card border border-line bg-surface";

interface GroupBoardProps {
  detail: GroupSetDetail;
  readOnly: boolean;
  /** A student into a group, or out of every group (`null`). Called only for a real move. */
  onMove: (enrollmentId: string, groupId: string | null) => void;
  /** Renames a group; resolves to the refusal to show under the field, or null once saved. */
  onRename: (groupId: string, name: string) => Promise<string | null>;
  onDelete: (group: GroupSetDetail["groups"][number]) => void;
}

export function GroupBoard({ detail, readOnly, onMove, onRename, onDelete }: GroupBoardProps) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [overZone, setOverZone] = useState<string | null>(null);
  /** The group whose name is being edited in place. */
  const [renaming, setRenaming] = useState<string | null>(null);

  // A student who left the set, or a set turned read-only, holds no selection.
  const current = readOnly || selected === null || placeOf(detail, selected) === undefined ? null : selected;

  const zones = [
    { key: NONE, groupId: null, label: t("groups.unplaced"), members: detail.unplaced },
    ...detail.groups.map((g) => ({ key: zoneKey(g.id), groupId: g.id, label: g.name, members: g.members })),
  ];
  const order = zones.map((z) => z.key);

  /**
   * The handles, by student, so a student moved by the keyboard keeps the
   * focus: the "Move here" button they were dropped with vanishes with the
   * selection, and the focus would otherwise fall to the page.
   */
  const handles = useRef(new Map<string, HTMLElement>());
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  useEffect(() => {
    if (focusAfter === null) return;
    handles.current.get(focusAfter)?.focus();
    setFocusAfter(null);
  }, [focusAfter]);

  /** Where a keyboard drag started: the arrows walk from there until it is over a zone. */
  const startZone = useRef(NONE);
  const coordinateGetter: KeyboardCoordinateGetter = (event, { context: { over, droppableRects } }) => {
    const from = order.indexOf(over ? String(over.id) : startZone.current);
    const next = stepZone(order.length, from, event.code);
    if (next === null) return undefined;
    event.preventDefault();
    const rect = droppableRects.get(order[next]!);
    return rect ? { x: rect.left, y: rect.top } : undefined;
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter,
      // Enter is the click-then-click move's key; Space alone picks a student up.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const move = (enrollmentId: string, groupId: string | null) => {
    setSelected(null);
    if (placeOf(detail, enrollmentId) !== groupId) onMove(enrollmentId, groupId);
  };

  function onDragStart(event: DragStartEvent) {
    setSelected(null);
    const id = studentOfDrag(String(event.active.id));
    setActive(id);
    startZone.current = id === null ? NONE : zoneKey(placeOf(detail, id) ?? null);
  }
  function onDragOver(event: DragOverEvent) {
    setOverZone(event.over ? String(event.over.id) : null);
  }
  function onDragEnd(event: DragEndEvent) {
    setActive(null);
    setOverZone(null);
    const id = studentOfDrag(String(event.active.id));
    if (id === null || !event.over) return;
    move(id, groupOfZone(String(event.over.id)));
  }

  /** "Move to…": every place but the student's own. */
  const moveItems = (student: GroupStudent): MenuItem[] => {
    const place = placeOf(detail, student.enrollmentId);
    return zones.map((z) => ({
      label: z.label,
      disabled: z.groupId === place,
      separator: z.groupId === null ? undefined : z === zones[1],
      onSelect: () => move(student.enrollmentId, z.groupId),
    }));
  };

  const chips = (members: GroupStudent[]) =>
    members.map((student) => (
      <StudentChip
        key={student.enrollmentId}
        student={student}
        readOnly={readOnly}
        selected={current === student.enrollmentId}
        onToggle={() => setSelected(current === student.enrollmentId ? null : student.enrollmentId)}
        moveItems={() => moveItems(student)}
        handleRef={(node) => {
          if (node) handles.current.set(student.enrollmentId, node);
          else handles.current.delete(student.enrollmentId);
        }}
      />
    ));

  const zone = (z: (typeof zones)[number], empty: string) => (
    <Zone
      dndId={z.key}
      count={z.members.length}
      over={overZone === z.key}
      readOnly={readOnly}
      armed={current !== null && placeOf(detail, current) !== z.groupId}
      empty={empty}
      dropLabel={z.groupId === null ? t("groups.dropOut") : t("groups.dropInto", { group: z.label })}
      onDrop={() => {
        if (current === null) return;
        move(current, z.groupId);
        setFocusAfter(current);
      }}
    >
      {chips(z.members)}
    </Zone>
  );

  const dragged = active === null ? undefined : studentOf(detail, active);

  /** What a screen reader hears of a drag, in the reader's language (dnd-kit's own words are English). */
  const nameOf = (id: string | number) => {
    const student = studentOf(detail, studentOfDrag(String(id)) ?? "");
    return student ? studentName(student) : "";
  };
  const zoneLabel = (id: string | number) => zones.find((z) => z.key === String(id))?.label ?? "";
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => t("groups.drag.start", { name: nameOf(a.id) }),
    onDragOver: ({ active: a, over }) => (over ? t("groups.drag.over", { name: nameOf(a.id), group: zoneLabel(over.id) }) : undefined),
    onDragEnd: ({ active: a, over }) =>
      over
        ? t("groups.drag.end", { name: nameOf(a.id), group: zoneLabel(over.id) })
        : t("groups.drag.cancel", { name: nameOf(a.id) }),
    onDragCancel: ({ active: a }) => t("groups.drag.cancel", { name: nameOf(a.id) }),
  };
  const overLabel = t("groups.over", { max: detail.set.maxSize ?? "" });

  return (
    <DndContext
      accessibility={{ announcements, screenReaderInstructions: { draggable: t("groups.drag.help") } }}
      sensors={sensors}
      collisionDetection={closestCorners}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActive(null);
        setOverZone(null);
      }}
    >
      <div
        className="grid items-start gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]"
        onKeyDown={(e) => {
          if (e.key === "Escape" && current !== null) setSelected(null);
        }}
      >
        {/* No group: in sight while the groups scroll by, its own list scrolling past the screen. */}
        <section
          aria-label={t("groups.unplaced")}
          className={cx(zoneFrame, "lg:sticky lg:top-[calc(var(--banner-h)+1rem)] lg:max-h-[calc(100dvh-var(--banner-h)-2rem)]")}
        >
          <ZoneHead>
            <span className="min-w-0 flex-1 truncate font-semibold">{t("groups.unplaced")}</span>
            <span className="tabular-nums text-fg-faint">{detail.unplaced.length}</span>
          </ZoneHead>
          <div className="min-h-0 overflow-y-auto">{zone(zones[0]!, t("groups.unplaced.empty"))}</div>
        </section>

        {detail.groups.length === 0 ? (
          <p className="rounded-card border border-dashed border-line-strong px-4 py-10 text-center text-sm text-fg-muted">
            {t("groups.noGroup")}
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] items-start gap-3">
            {detail.groups.map((g, i) => {
              const over = overMax(g.members.length, detail.set.maxSize);
              return (
                <li key={g.id} className={zoneFrame} aria-label={g.name}>
                  <ZoneHead>
                    {renaming === g.id ? (
                      <GroupNameField
                        name={g.name}
                        onCancel={() => setRenaming(null)}
                        onSave={async (name) => {
                          const refused = await onRename(g.id, name);
                          if (refused === null) setRenaming(null);
                          return refused;
                        }}
                      />
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate font-semibold">{g.name}</span>
                        <span className={cx("tabular-nums", over ? "font-medium text-warning" : "text-fg-faint")}>
                          {g.members.length}
                          {detail.set.maxSize !== null ? `/${detail.set.maxSize}` : null}
                        </span>
                        {over ? (
                          <Tip label={overLabel}>
                            <TriangleAlert
                              className="size-4 text-warning"
                              aria-label={overLabel}
                              role="img"
                            />
                          </Tip>
                        ) : null}
                        {readOnly ? null : (
                          <Menu
                            label={t("groups.group.menu", { name: g.name })}
                            items={[
                              { label: t("groups.group.rename"), icon: PenLine, onSelect: () => setRenaming(g.id) },
                              {
                                label: t("groups.group.delete"),
                                icon: Trash2,
                                danger: true,
                                separator: true,
                                onSelect: () => onDelete(g),
                              },
                            ]}
                          />
                        )}
                      </>
                    )}
                  </ZoneHead>
                  {zone(zones[i + 1]!, t("groups.group.empty"))}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <DragOverlay dropAnimation={null}>
        {dragged ? (
          <div className={cx(chipClass, "cursor-grabbing border-line-strong shadow-popover")}>
            <GripVertical className="size-3.5 text-fg-faint" />
            <span className="truncate">{studentName(dragged)}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function ZoneHead({ children }: { children: ReactNode }) {
  return <div className="flex min-h-11 items-center gap-1.5 border-b border-line px-3 py-1.5 text-sm">{children}</div>;
}

/** A student as the board draws them: the categorize card's chrome. */
const chipClass = "flex min-w-0 items-center gap-2 rounded-field border bg-surface px-2 py-1.5 text-[13px] text-fg";

/**
 * One drop zone: the body of "No group" or of a group, a droppable of its
 * own so an EMPTY group still takes a student, lit in `info-soft` while a
 * student hovers over it.
 */
function Zone({
  dndId,
  count,
  over,
  readOnly,
  armed,
  empty,
  dropLabel,
  onDrop,
  children,
}: {
  dndId: string;
  count: number;
  over: boolean;
  readOnly: boolean;
  /** A student is selected elsewhere: this zone offers its "Move here". */
  armed: boolean;
  empty: string;
  dropLabel: string;
  onDrop: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const { setNodeRef } = useDroppable({ id: dndId, disabled: readOnly });
  return (
    <div
      ref={setNodeRef}
      className={cx(
        "flex min-h-16 flex-1 flex-col gap-1.5 rounded-b-card p-2 transition-colors duration-120 motion-reduce:transition-none",
        over && "bg-info-soft",
      )}
      // The pointer may drop anywhere on the zone; the keyboard has the button below.
      onClick={(e) => {
        if (armed && !(e.target as HTMLElement).closest("[data-student]")) onDrop();
      }}
    >
      {count > 0 ? (
        <ul className="flex flex-col gap-1">{children}</ul>
      ) : armed ? null : (
        <p className="m-auto px-2 py-2 text-center text-xs text-fg-faint">{empty}</p>
      )}
      {armed ? (
        <button
          type="button"
          aria-label={dropLabel}
          className={cx(
            "rounded-field border border-dashed border-info px-2 py-1.5 text-xs font-medium text-info",
            "transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onDrop();
          }}
        >
          {t("groups.dropHere")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A student: the handle (drag, or select for click-then-click) and the
 * "Move to…" menu. One who has not signed in yet is placed like any other
 * (ADR-070 §2) and marked with a dashed circle.
 */
function StudentChip({
  student,
  readOnly,
  selected,
  onToggle,
  moveItems,
  handleRef,
}: {
  student: GroupStudent;
  readOnly: boolean;
  selected: boolean;
  onToggle: () => void;
  moveItems: () => MenuItem[];
  handleRef: (node: HTMLElement | null) => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: dragKey(student.enrollmentId),
    disabled: readOnly,
    attributes: { roleDescription: t("groups.drag.role") },
  });
  const name = studentName(student);
  const unclaimed = student.claimed ? null : (
    <>
      <Tip label={t("groups.unclaimed")}>
        <CircleDashed className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
      </Tip>
      <span className="sr-only">{t("groups.unclaimed")}</span>
    </>
  );
  return (
    <li ref={setNodeRef} data-student={student.enrollmentId} className={cx("flex items-center gap-0.5", isDragging && "opacity-40")}>
      {readOnly ? (
        <span className={cx(chipClass, "flex-1 border-line")}>
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {unclaimed}
        </span>
      ) : (
        <>
          <button
            type="button"
            ref={(node) => {
              setActivatorNodeRef(node);
              handleRef(node);
            }}
            {...attributes}
            // dnd-kit's `onPointerDown` / `onKeyDown`: DOM handlers by construction.
            {...(listeners as HTMLAttributes<HTMLElement> | undefined)}
            aria-pressed={selected}
            onClick={onToggle}
            className={cx(
              chipClass,
              "flex-1 cursor-grab text-left transition-colors active:cursor-grabbing",
              selected ? "border-info ring-2 ring-info-soft" : "border-line hover:border-fg-faint",
            )}
          >
            <GripVertical className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {unclaimed}
          </button>
          <Menu
            label={t("groups.moveTo", { name })}
            trigger={
              <IconButton label={t("groups.moveTo", { name })} size="sm">
                <MoveRight />
              </IconButton>
            }
            items={moveItems()}
          />
        </>
      )}
    </li>
  );
}

/** A group's name, edited in place: Enter or blur saves, Escape cancels; a refusal stays under it. */
function GroupNameField({
  name,
  onSave,
  onCancel,
}: {
  name: string;
  onSave: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(name);
  const [refused, setRefused] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const save = async () => {
    const next = draft.trim();
    if (saving) return;
    if (next === "" || next === name) {
      onCancel();
      return;
    }
    setSaving(true);
    const answer = await onSave(next);
    setSaving(false);
    setRefused(answer);
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
      <input
        id={id}
        autoFocus
        aria-label={t("groups.group.name")}
        aria-invalid={refused ? true : undefined}
        aria-describedby={refused ? `${id}-error` : undefined}
        maxLength={100}
        value={draft}
        disabled={saving}
        onChange={(e) => {
          setDraft(e.target.value);
          setRefused(null);
        }}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!refused) void save();
        }}
        className={cx(inputClass, inputSize.sm, "w-full font-semibold")}
      />
      {refused ? (
        <p id={`${id}-error`} className="text-xs text-danger">
          {refused}
        </p>
      ) : null}
    </div>
  );
}
