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
 *     semibold head on two lines at most, its weight under it; a grade is the one
 *     number of its cell, in `Grade`'s band colour.
 *   - Color: no accent here at all — the page's one primary, Export CSV,
 *     lives in the header (`ClassroomView`). The absence `a1.0` wears `info`
 *     (`AbsentSigil`), a real 1.0 `danger`, so the two never read alike.
 *   - Space: the matrix is the card; 16 above it for the switch and the
 *     legend. Under 640 px the matrix scrolls INSIDE its card, under a sticky
 *     student column; the page itself never scrolls sideways.
 *   - Finish: hairlines, no shadow; a column not released is a recessed
 *     `surface-2` strip with its badge, and stays out of the mean.
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
  Badge,
  Card,
  cx,
  EmptyState,
  Menu,
  QueryError,
  Skeleton,
  SettingRow,
  Switch,
  Tip,
  T,
  type MenuItem,
} from "../ui";
import { gradebookRefusalMessage, useGradebookWrites, useStaffGradebook } from "./api";
import { ScoreDialog, WeightDialog } from "./dialogs";
import { AbsentSigil, Dash, fullName, GradeOrDash, MODE_LABEL } from "./cells";

/**
 * The mean stays in view while the grades scroll under it, once the card has
 * room for it (`@2xl`, 42 rem); on a phone it scrolls with the rest, so the
 * columns keep the width.
 */
const MEAN_PIN = "@2xl:sticky @2xl:right-0 @2xl:z-10 @2xl:border-l @2xl:border-line";

/** One width for every grade column's head; the title wraps inside it. */
const HEAD_WIDTH = "w-36";

/** Where a column's unreleased state tints its cells. */
const UNRELEASED_FILL = "bg-surface-2/50";

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
              <th scope="col" className={cx(T.th, "sticky left-0 z-10 min-w-36 bg-surface align-bottom")}>
                {t("gbook.col.student")}
              </th>
              {columns.map((column) => (
                <th
                  key={column.activityId}
                  scope="col"
                  className={cx(T.th, "align-bottom", !column.released && UNRELEASED_FILL)}
                >
                  <ColumnHead column={column} items={readOnly ? null : columnItems(column)} />
                </th>
              ))}
              <th scope="col" className={cx(T.th, "text-right align-bottom", MEAN_PIN, "@2xl:bg-surface")}>
                <Tip label={t("gbook.mean.help")}>
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
                    <td key={column.activityId} className={cx(T.td, "text-center", !column.released && UNRELEASED_FILL)}>
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
                <td key={column.activityId} className={cx(T.td, "text-center font-semibold tabular-nums")}>
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
 * A column's head: its title, its weight, and the menu of its settings.
 *
 * Every grade column has the same width (`HEAD_WIDTH`) and its title wraps
 * on two lines at most, clamped: a long exam title never spills over the
 * next column. The full title and the column's kind are in the tooltip (and
 * in the accessible name); the head keeps the weight alone, the one figure a
 * teacher compares across columns. The "not released" badge sits ABOVE the
 * title: the heads stand on the bottom of the row, so the weights line up.
 */
function ColumnHead({ column, items }: { column: GradebookColumn; items: MenuItem[] | null }) {
  const t = useT();
  const kind = t(MODE_LABEL[column.mode]);
  // The tooltip is inside the menu's trigger: `Tip` stays shut while the
  // panel of a trigger around it is open.
  const head = (
    <Tip label={`${column.title} · ${kind}`} className="flex min-w-0 flex-col items-start gap-0.5">
      <span className="flex min-w-0 items-start gap-1 text-[13px] font-semibold text-fg">
        <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
          {column.title}{" "}
          <span className="sr-only">({kind})</span>
        </span>
        {items ? <ChevronDown aria-hidden className="mt-1 size-3 shrink-0 text-fg-faint" /> : null}
      </span>
      <span className="text-[11px] font-normal text-fg-muted">
        {t(column.counts ? "gbook.weightShort" : "gbook.notCounted", { weight: String(column.weight) })}
      </span>
    </Tip>
  );
  return (
    <div className={cx(HEAD_WIDTH, "flex flex-col items-start gap-1")}>
      {column.released ? null : (
        <Tip label={t("gbook.unreleased.help")}>
          <Badge tone="zinc" icon={EyeOff}>
            {t("gbook.unreleased")}
          </Badge>
        </Tip>
      )}
      {items ? (
        <Menu
          align="start"
          label={t("gbook.column.menu", { column: column.title })}
          items={items}
          trigger={
            <button
              type="button"
              className="-mx-1.5 flex min-w-0 max-w-full rounded-field px-1.5 py-0.5 text-left transition-colors hover:bg-surface-3"
            >
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
