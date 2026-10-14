/**
 * The staff's Grades tab of a classroom (F-GBOOK-01, -02, -05, -06, ADR-074,
 * M5-04): the gradebook as a matrix — a row per claimed student, a column per
 * exam, exercise or graded project, the weighted mean last, and under the
 * students the class's means (#545): each column's, and the overall one under
 * the mean, on a `surface-2` footer row as the student's mean row is. The server owns
 * every figure (`GET /classrooms/:id/gradebook`, and every write answers the
 * table); this tab computes nothing, it draws and it sends writes.
 *
 * The four decisions:
 *   - Type: the student is the bold identity; a column's title is a 13 px
 *     semibold line slanted at 60°, its weight under it; a grade is the one
 *     number of its cell, in `Grade`'s band colour.
 *   - Color: no accent but the soft tint of a column whose head is pointed
 *     at — the page's one primary, Export CSV, lives in the header
 *     (`ClassroomView`). The absence `a1.0` wears `info`
 *     (`AbsentSigil`), a real 1.0 `danger`, so the two never read alike.
 *   - Space: the matrix is the card; 16 above it for the switch and the
 *     legend. Under 640 px the matrix scrolls INSIDE its card, under a sticky
 *     student column; the page itself never scrolls sideways.
 *   - Finish: hairlines, no shadow; a column not released is a recessed
 *     `surface-2` strip with an eye-off over its weight, and stays out of the
 *     mean. Pointing at a head lights its whole column.
 *
 * The secondary actions are menus: one per cell (absent, a score, clear) and
 * one per column (weight, counts in the mean). A mark over a real grade
 * answers `409 grade_exists`; the tab then asks, and sends it again with
 * `override: true`.
 */
import {
  ChevronDown,
  CircleMinus,
  CirclePlus,
  Eraser,
  EyeOff,
  Pencil,
  Scale,
  Table2,
  TriangleAlert,
  UserX,
} from "lucide-react";
import { useState } from "react";

import type { GradebookColumn, GradebookMarkPut, GradebookStaff, GradebookStaffCell, GradebookStaffRow } from "@quiz/contracts";

import { refusedWith } from "../api";
import { useConfirm } from "../confirm";
import { useT, type TFunction } from "../i18n";
import { useToast } from "../notify";
import {
  Card,
  cx,
  Dash,
  EmptyState,
  Menu,
  type MenuItem,
  QueryError,
  SettingRow,
  Skeleton,
  Switch,
  T,
  Tip,
} from "../ui";
import { gradebookRefusalMessage, useGradebookWrites, useStaffGradebook } from "./api";
import { ScoreDialog, WeightDialog } from "./dialogs";
import { AbsentSigil, fullName, GradeOrDash, MODE_LABEL } from "./cells";

/**
 * The mean stays in view while the grades scroll under it, once the card has
 * room for it (`@2xl`, 42 rem); on a phone it scrolls with the rest, so the
 * columns keep the width.
 */
const MEAN_STICK = "@2xl:sticky @2xl:right-0 @2xl:z-10";
const MEAN_PIN = `${MEAN_STICK} @2xl:border-l @2xl:border-line`;

/**
 * The slanted heads. A grade column is as narrow as its grade (56 px) and its
 * title runs up a band leaning at 60° — the band, not the rectangle of the
 * `th`, is the column's head, so the `th` lets the pointer through and the
 * band takes it: pointing at the top of a band names its own column, not the
 * neighbour whose rectangle lies under it. The weight sits below, upright
 * (its foot), so the weights line up. The band is 190 px tall: a title of about
 * 200 px fits before it is cut, and leans 110 px to the right — the room the
 * mean column (`w-30`) leaves for the last one. Both widths are set: the
 * student column alone takes what the card has left.
 */
const HEAD_HEIGHT = "h-[246px]";
const BAND = "absolute inset-x-0 top-0 bottom-14 origin-bottom-left -skew-x-30";
/** Centred on the band's axis: 18 px up the band (10 + half the line) is 10.4 px to the right at 60°. */
const SLANT_LABEL =
  "absolute bottom-[66px] left-[calc(50%+10.4px)] max-w-[200px] origin-left -rotate-60 truncate whitespace-nowrap text-[13px] leading-4";

/** A grade cell: `T.td` with the side padding cut to 4 px, so a column is no wider than its grade; a hairline on its left. */
const GRADE_TD = cx(T.td, "!px-1 border-l border-line text-center");

/** Where a column's unreleased state tints its cells. */
const UNRELEASED_FILL = "bg-surface-2/50";

/**
 * A grade column's fill: lit while its head is pointed at or focused, else
 * recessed when not released — except on the class means' row (`recess`
 * false), which keeps its own fill.
 */
const columnFill = (column: GradebookColumn, lit: string | null, recess = true) =>
  lit === column.activityId ? "bg-accent-soft" : column.released || !recess ? "" : UNRELEASED_FILL;

export function StaffGradebook({ classroomId }: { classroomId: string }) {
  const t = useT();
  const table = useStaffGradebook(classroomId);

  if (table.isLoading) {
    return (
      <div className="space-y-3" role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (table.isError || !table.data) {
    return (
      <QueryError title={t("gbook.loadError")} query={table} />
    );
  }
  return <Matrix classroomId={classroomId} data={table.data} />;
}

/** What a cell is being asked: a score over `row` in `column`, or a column's weight. */
type Dialog = { kind: "score"; row: GradebookStaffRow; column: GradebookColumn } | { kind: "weight"; column: GradebookColumn };

function Matrix({ classroomId, data }: { classroomId: string; data: GradebookStaff }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const writes = useGradebookWrites(classroomId);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const readOnly = data.archived;
  /*
   * The exercises left out of the mean are practice, and a classroom has
   * many: folded away by default, a switch away, never persisted. Exercises
   * only, as the owner asked — an exam or a project left out of the mean
   * stays in sight, and an exercise the teacher gave a weight counts and
   * stays. Neither the mean nor the CSV changes: what is hidden never
   * counted.
   */
  const [showExercises, setShowExercises] = useState(false);
  /** The column whose head the pointer is on: its cells light up under it. */
  const [lit, setLit] = useState<string | null>(null);
  const optional = (column: GradebookColumn) => column.mode === "exercise" && !column.counts;
  const hasOptional = data.columns.some(optional);
  const columns = showExercises ? data.columns : data.columns.filter((column) => !optional(column));

  /**
   * Runs one write; a refusal is a toast, in words. True when it went through.
   * `onExists` takes over a `409 grade_exists` instead (the override's question).
   */
  const attempt = async (write: () => Promise<unknown>, onExists?: () => Promise<boolean>): Promise<boolean> => {
    try {
      await write();
      return true;
    } catch (error) {
      if (onExists && refusedWith(error, "grade_exists")) return onExists();
      toast(gradebookRefusalMessage(error, t), "error");
      return false;
    }
  };

  /** A mark; over a real grade the server asks for `override`, and so do we. */
  const putMark = (column: GradebookColumn, row: GradebookStaffRow, mark: GradebookMarkPut): Promise<boolean> =>
    attempt(
      () => writes.setMark(column, row.enrollmentId, mark),
      async () =>
        (await confirm({
          title: t("gbook.override.title"),
          message: t("gbook.override.body", { student: fullName(row), column: column.title }),
          confirmLabel: t("gbook.override.confirm"),
          danger: true,
        })) && attempt(() => writes.setMark(column, row.enrollmentId, { ...mark, override: true })),
    );

  const cellItems = (column: GradebookColumn, row: GradebookStaffRow, cell: GradebookStaffCell): MenuItem[] => [
    { label: t("gbook.cell.absent"), icon: UserX, onSelect: () => void putMark(column, row, { kind: "absent" }) },
    { label: t("gbook.cell.score"), icon: Pencil, onSelect: () => setDialog({ kind: "score", row, column }) },
    ...(cell.mark
      ? [
          {
            label: t("gbook.cell.clear"),
            icon: Eraser,
            separator: true,
            onSelect: () => void attempt(() => writes.clearMark(column, row.enrollmentId)),
          },
        ]
      : []),
  ];

  const columnItems = (column: GradebookColumn): MenuItem[] => [
    {
      label: t(column.counts ? "gbook.column.uncount" : "gbook.column.count"),
      icon: column.counts ? CircleMinus : CirclePlus,
      onSelect: () => void attempt(() => writes.patchColumn(column, { counts: !column.counts })),
    },
    { label: t("gbook.column.weight"), icon: Scale, onSelect: () => setDialog({ kind: "weight", column }) },
  ];

  if (data.columns.length === 0 || data.rows.length === 0) {
    return (
      <Card>
        <EmptyState icon={Table2} title={t(data.columns.length === 0 ? "gbook.empty.noColumns" : "gbook.empty.noRows")}>
          {t(data.columns.length === 0 ? "gbook.empty.noColumnsBody" : "gbook.empty.noRowsBody")}
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <SettingRow
        title={t("gbook.mean.publish")}
        desc={t(data.meanPublished ? "gbook.mean.publishedDesc" : "gbook.mean.unpublishedDesc")}
        className="py-0"
      >
        <Switch
          checked={data.meanPublished}
          label={t("gbook.mean.publish")}
          disabled={readOnly || writes.pending}
          onChange={(next) => void attempt(() => writes.publishMean(next))}
        />
      </SettingRow>
      {hasOptional ? (
        <SettingRow
          title={t("gbook.exercises.show")}
          desc={t(showExercises ? "gbook.exercises.shownDesc" : "gbook.exercises.hiddenDesc")}
          className="py-0"
        >
          <Switch checked={showExercises} label={t("gbook.exercises.show")} onChange={setShowExercises} />
        </SettingRow>
      ) : null}

      {/* `relative`: the sr-only spans of the cells are absolute, and would otherwise lay out past the scroller, on the page. */}
      <Card className={cx(T.container, "relative overflow-x-auto")}>
        <table className={cx(T.table, "min-w-max")}>
          <thead className={T.head}>
            <tr>
              <th scope="col" className={cx(T.th, HEAD_HEIGHT, "sticky left-0 z-10 min-w-36 bg-surface align-bottom")}>
                {/* Its slanted edge covers the heads that scroll under it, tops included. */}
                <span aria-hidden className={cx(BAND, "bg-surface")} />
                {t("gbook.col.student")}
              </th>
              {columns.map((column) => {
                const fill = columnFill(column, lit);
                const light = () => setLit(column.activityId);
                const dim = () => setLit(null);
                return (
                  <th
                    key={column.activityId}
                    scope="col"
                    className={cx("pointer-events-none relative w-14 min-w-14 p-0 align-bottom font-medium", HEAD_HEIGHT)}
                    onMouseEnter={light}
                    onMouseLeave={dim}
                    onFocus={light}
                    onBlur={dim}
                  >
                    <span aria-hidden className={cx(BAND, "pointer-events-auto border-l border-line", fill)} />
                    <ColumnHead column={column} items={readOnly ? null : columnItems(column)} fill={fill} />
                  </th>
                );
              })}
              {/*
               * No straight left border nor flat fill above the weights: either
               * would cut the last title where it leans over this column. Its
               * own band and a foot carry the fill once it is pinned; the
               * cell clips the band, which would otherwise widen the scroller.
               */}
              <th
                scope="col"
                className={cx(T.th, HEAD_HEIGHT, "relative w-30 min-w-30 overflow-hidden text-right align-bottom", MEAN_STICK)}
              >
                <span aria-hidden className={cx(BAND, "border-l border-line @2xl:bg-surface")} />
                <span aria-hidden className="absolute inset-x-0 bottom-0 h-14 border-l border-line @2xl:bg-surface" />
                <Tip label={t("gbook.mean.help")} className="relative inline-flex">
                  <span>{t("gbook.col.mean")}</span>
                </Tip>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.enrollmentId} className={cx(T.row, "group hover:bg-surface-2/70")}>
                <th
                  scope="row"
                  className={cx(T.td, "sticky left-0 z-10 bg-surface text-left font-normal group-hover:bg-surface-2")}
                >
                  <span className="block max-w-36 truncate font-semibold @lg:max-w-56">{fullName(row)}</span>
                  {/* On a phone the name alone: the sticky column keeps room for the grades. */}
                  <span className="hidden max-w-56 truncate text-xs text-fg-muted @lg:block">{row.email}</span>
                </th>
                {columns.map((column) => {
                  const cell = row.cells[column.activityId];
                  return (
                    <td key={column.activityId} className={cx(GRADE_TD, columnFill(column, lit))}>
                      {cell ? (
                        <CellButton
                          cell={cell}
                          label={t("gbook.cell.label", { student: fullName(row), column: column.title })}
                          items={readOnly ? null : cellItems(column, row, cell)}
                          t={t}
                        />
                      ) : (
                        <Dash />
                      )}
                    </td>
                  );
                })}
                <td
                  className={cx(T.td, "text-right font-semibold tabular-nums", MEAN_PIN, "@2xl:bg-surface @2xl:group-hover:bg-surface-2")}
                >
                  <GradeOrDash value={row.mean} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className={cx(T.row, "bg-surface-2")}>
              <th scope="row" className={cx(T.td, "sticky left-0 z-10 bg-surface-2 text-left font-semibold")}>
                <Tip label={t("gbook.classMean.help")}>
                  <span>{t("gbook.classMean")}</span>
                </Tip>
              </th>
              {columns.map((column) => (
                <td key={column.activityId} className={cx(GRADE_TD, "font-semibold tabular-nums", columnFill(column, lit, false))}>
                  <GradeOrDash value={column.classMean} />
                </td>
              ))}
              <td className={cx(T.td, "text-right font-semibold tabular-nums", MEAN_PIN, "@2xl:bg-surface-2")}>
                <GradeOrDash value={data.classMean} />
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>
      <p className="text-[13px] text-fg-muted">{t("gbook.legend")}</p>

      {dialog?.kind === "score" ? (
        <ScoreDialog
          row={dialog.row}
          column={dialog.column}
          cell={dialog.row.cells[dialog.column.activityId]}
          submitting={writes.pending}
          onClose={() => setDialog(null)}
          onSubmit={async (mark) => {
            if (await putMark(dialog.column, dialog.row, mark)) setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "weight" ? (
        <WeightDialog
          column={dialog.column}
          submitting={writes.pending}
          onClose={() => setDialog(null)}
          onSubmit={async (weight) => {
            if (await attempt(() => writes.patchColumn(dialog.column, { weight }))) setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * A column's head: its slanted title, the eye-off of a column not released,
 * its weight, and the menu of its settings.
 *
 * The title is cut on one line, up its band (`SLANT_LABEL`); the full title
 * and the column's kind are in the tooltip (and in the accessible name). The
 * upright foot under the band holds the eye-off — its slot is kept on every
 * column, so the weights stand on one line — then the weight, the one figure
 * a teacher compares across columns. The title is inside the menu's trigger:
 * pointing at it or clicking it is the same as on the weight.
 */
function ColumnHead({ column, items, fill }: { column: GradebookColumn; items: MenuItem[] | null; fill: string }) {
  const t = useT();
  const kind = t(MODE_LABEL[column.mode]);
  // The tooltip is inside the menu's trigger: `Tip` stays shut while the
  // panel of a trigger around it is open.
  const head = (
    <Tip label={`${column.title} · ${kind}`} className="flex items-center gap-0.5 text-[11px] font-normal text-fg-muted">
      <span className={cx(SLANT_LABEL, column.released ? "font-semibold text-fg" : "font-medium italic text-fg-muted")}>
        {column.title} <span className="sr-only">({kind})</span>
      </span>
      <span className="text-center leading-tight">
        {t(column.counts ? "gbook.weightShort" : "gbook.notCounted", { weight: String(column.weight) })}
      </span>
      {items ? <ChevronDown aria-hidden className="size-3 shrink-0 text-fg-faint" /> : null}
    </Tip>
  );
  return (
    <div className={cx("pointer-events-auto flex h-14 flex-col items-center justify-end gap-0.5 border-l border-line px-0.5 pb-1.5", fill)}>
      {column.released ? (
        <span aria-hidden className="h-3.5" />
      ) : (
        <Tip label={t("gbook.unreleased.help")} className="inline-flex text-fg-muted">
          <EyeOff aria-hidden className="size-3.5" />
          <span className="sr-only">{t("gbook.unreleased")}</span>
        </Tip>
      )}
      {items ? (
        <Menu
          align="start"
          label={t("gbook.column.menu", { column: column.title })}
          items={items}
          trigger={
            <button type="button" className="flex rounded-field px-1 py-0.5 transition-colors hover:bg-surface-3">
              {head}
            </button>
          }
        />
      ) : (
        head
      )}
    </div>
  );
}

/**
 * One cell: what it holds, and — unless the classroom is archived — the menu
 * of what may be done to it. `items` is null for a read-only classroom.
 */
function CellButton({
  cell,
  label,
  items,
  t,
}: {
  cell: GradebookStaffCell;
  label: string;
  items: MenuItem[] | null;
  t: TFunction;
}) {
  const face = <CellFace cell={cell} t={t} />;
  if (!items) return face;
  return (
    <Menu
      label={label}
      align="start"
      items={items}
      trigger={
        <button
          type="button"
          aria-label={label}
          className="inline-flex min-h-7 min-w-12 items-center justify-center gap-1 rounded-field px-2 py-0.5 tabular-nums transition-colors hover:bg-surface-3"
        >
          {face}
        </button>
      }
    />
  );
}

/** A staff cell's content: the grade, the absence sigil or a dash, and what is worth a second look beside it. */
function CellFace({ cell, t }: { cell: GradebookStaffCell; t: TFunction }) {
  const marked = cell.source === "mark";
  return (
    <>
      {cell.kind === "grade" ? (
        <span className="font-semibold">
          <GradeOrDash value={cell.grade} />
        </span>
      ) : cell.kind === "absent" ? (
        <AbsentSigil why={t(marked ? "gbook.absent.marked" : "gbook.absent.derived")} />
      ) : (
        <Dash />
      )}
      {marked && cell.kind === "grade" ? (
        <Tip label={t("gbook.mark.score", { points: String(cell.points ?? ""), max: String(cell.max ?? "") })}>
          <Pencil aria-hidden className="size-3 text-fg-faint" />
        </Tip>
      ) : null}
      {cell.changedAfterRelease ? (
        <Tip label={t("gbook.changedAfterRelease")}>
          <TriangleAlert className="size-3.5 text-warning" aria-label={t("gbook.changedAfterRelease")} />
        </Tip>
      ) : null}
    </>
  );
}
