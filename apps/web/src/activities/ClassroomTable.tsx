import type { ReactNode } from "react";

import type { EvaluationSummary, ProjectActivitySummary } from "@quiz/contracts";
import { templatePullable } from "@quiz/domain";

import { evaluationHome, evaluationStateLabel, evaluationTimerAt, stateStyle } from "../evaluation/common";
import type { EvaluationRowActions } from "../evaluation/rowActions";
import { TemplateBehindBadge } from "../evaluation/templatePull";
import { useT, type Dict, type TFunction } from "../i18n";
import type { ProjectRowActions } from "../project/classroomProjects";
import type { Route } from "../router";
import {
  Badge,
  Card,
  cx,
  Dash,
  isoDateTime,
  Menu,
  pressable,
  T,
  TableHead,
  useSortableTable,
  type Column,
} from "../ui";
import { ActivityMenu } from "./actions";
import { typeName, type ActivityType } from "./model";
import { openerOf, StateBadge, StateText } from "./views";

/*
 * The tables of a classroom's Activities tab (`ClassroomActivities`): one
 * table, configured by its columns, for each kind of the Grouped layout and
 * for the All layout's single merged table. A row keeps its own kind's
 * badge, destination and actions whichever table holds it.
 */

/** A row of the tab: one of the classroom's evaluations, or one of its projects. */
export type ClassroomRow = EvaluationSummary | ProjectActivitySummary;

/** What a row's cells and actions reach: the page's navigation and each kind's row actions. */
export interface RowContext {
  navigate: (r: Route) => void;
  evaluation: EvaluationRowActions;
  project: ProjectRowActions;
  /** The rows are the archived projects (#864): no timer, nothing runs out. */
  archived?: boolean;
}

/**
 * What one kind of row answers, whatever the table asks — the classroom's
 * counterpart of `KIND` (`model.ts`), over the classroom's own payloads. No
 * cell branches on the kind: it reads {@link specOf}.
 */
interface RowSpec<R extends ClassroomRow> {
  type(row: R): ActivityType;
  /**
   * When it started, or is to open (#795). An evaluation's is `startedAt ??
   * opensAt`: an evaluation opened by hand has no `opensAt`, and one opened
   * early started before it. `KIND.anchor` places an /activities row in time
   * (`opensAt` first, then the close of an undated one) and is not this.
   */
  start(row: R): string | null;
  /** When it closes: an evaluation's end, a project's deadline (#787). */
  end(row: R): string | null;
  /** Null where the kind has none — a project's questions, a poll's points — drawn as a dash and sorted last. */
  questions(row: R): number | null;
  points(row: R): number | null;
  /** The row's badges: its state, the time left inside it (ADR-104), an evaluation's template pull (F-EVAL-26). */
  Badges(props: { row: R; ctx: RowContext }): ReactNode;
  /** Where a click on the row leads. */
  open(row: R, navigate: (r: Route) => void): () => void;
  /** The last cell: an evaluation's overflow menu, a project's repository links and Rename. */
  Actions(props: { row: R; ctx: RowContext }): ReactNode;
}

const EVALUATION: RowSpec<EvaluationSummary> = {
  type: (row) => row.mode,
  start: (row) => row.startedAt ?? row.opensAt,
  end: (row) => row.closesAt,
  questions: (row) => row.itemCount,
  points: (row) => (row.mode === "poll" ? null : row.totalPoints),
  Badges: function EvaluationBadges({ row, ctx }) {
    const t = useT();
    return (
      <>
        <Badge {...stateStyle(row.state)}>
          <StateText label={evaluationStateLabel(row.state, t)} at={evaluationTimerAt(row)} />
        </Badge>
        {/* Shown only where the pull would be accepted, as the pull's own door. */}
        {templatePullable(row) ? (
          <TemplateBehindBadge
            from={row.originRevision!}
            to={row.templateRevision!}
            title={row.title}
            onOpen={() => ctx.evaluation.pull(row.id)}
          />
        ) : null}
      </>
    );
  },
  open: (row, navigate) => () => navigate(evaluationHome(row)),
  Actions: function EvaluationActions({ row, ctx }) {
    const t = useT();
    return <Menu label={t("live.row.actions", { name: row.title })} items={ctx.evaluation.menuItems(row)} />;
  },
};

const PROJECT: RowSpec<ProjectActivitySummary> = {
  type: () => "project",
  start: (row) => row.startAt,
  end: (row) => row.deadlineAt,
  questions: () => null,
  points: () => null,
  Badges: ({ row, ctx }) => <StateBadge row={row} timer={!ctx.archived} />,
  open: openerOf,
  Actions: ({ row, ctx }) => <ActivityMenu row={row} navigate={ctx.navigate} onRename={ctx.project.rename} />,
};

/** The spec of a row's kind; the classroom's evaluations carry no `kind`, only a project does. */
const specOf = (row: ClassroomRow): RowSpec<ClassroomRow> =>
  ("kind" in row ? PROJECT : EVALUATION) as RowSpec<ClassroomRow>;

/** What a row is: an evaluation's mode, or "project". */
export const typeOfRow = (row: ClassroomRow): ActivityType => specOf(row).type(row);
/** When a row starts: what the tables show, and what the All table orders on. */
export const startOf = (row: ClassroomRow): string | null => specOf(row).start(row);

/** A cell's value, or a dash where there is none. */
const orDash = (value: ReactNode): ReactNode => (value === null || value === undefined ? <Dash /> : value);
const dateOrDash = (iso: string | null) => orDash(iso && isoDateTime(iso));

type DataKey = "mode" | "start" | "end" | "questions" | "points" | "participants";
type SortKey = "title" | DataKey;

/**
 * Each column as data: its words, its width, its priority as the card
 * narrows (the participants go first, then the points, then the dates and
 * the number of questions — the title with its badges and the actions
 * stay), what it sorts on and what it draws.
 */
const COLUMNS: Record<
  DataKey,
  {
    label: keyof Dict;
    /** In rem. */
    width: number;
    className?: string;
    right?: boolean;
    rank: (row: ClassroomRow, t: TFunction) => string | number | null;
    cell: (row: ClassroomRow, t: TFunction) => ReactNode;
  }
> = {
  mode: {
    label: "eval.mode",
    width: 5,
    rank: (row, t) => typeName(typeOfRow(row), t),
    cell: (row, t) => typeName(typeOfRow(row), t),
  },
  start: {
    label: "eval.col.start",
    width: 8,
    className: T.colHigh,
    rank: startOf,
    cell: (row) => dateOrDash(startOf(row)),
  },
  end: {
    label: "eval.col.end",
    width: 8,
    className: T.colHigh,
    rank: (row) => specOf(row).end(row),
    cell: (row) => dateOrDash(specOf(row).end(row)),
  },
  questions: {
    label: "eval.step.questions",
    width: 5.25,
    className: T.colHigh,
    right: true,
    rank: (row) => specOf(row).questions(row),
    cell: (row) => orDash(specOf(row).questions(row)),
  },
  points: {
    label: "eval.col.points",
    width: 4.5,
    className: T.colMid,
    right: true,
    rank: (row) => specOf(row).points(row),
    cell: (row) => orDash(specOf(row).points(row)),
  },
  participants: {
    label: "eval.col.participants",
    width: 6,
    className: T.colLow,
    right: true,
    rank: (row) => row.participantCount,
    // Nobody yet reads as a dash, as the attempts did.
    cell: (row) => orDash(row.participantCount || null),
  },
};

/** The actions column, as wide in every table: a project's three icons fit it. */
const ACTIONS_WIDTH = 7.5;

/** A table's layout: one kind of the Grouped layout, or the All layout's merged table. */
export type TableLayout = ActivityType | "all";

/** The columns of each table between the title and the actions, and the labels it words its own way. */
const LAYOUTS: Record<TableLayout, { columns: readonly DataKey[]; labels?: Partial<Record<DataKey, keyof Dict>> }> = {
  exam: { columns: ["start", "end", "questions", "points", "participants"] },
  exercise: { columns: ["start", "end", "questions", "points", "participants"] },
  project: { columns: ["start", "end", "participants"], labels: { end: "project.deadline" } },
  poll: { columns: ["start", "end", "questions", "participants"] },
  all: { columns: ["mode", "start", "end", "questions", "points", "participants"], labels: { end: "activities.col.end" } },
};

/**
 * The columns that line up from one table to the next, in their order: an
 * exam's, which has every column but the mode. The title takes what the
 * fixed columns leave, so each of these sits at the same distance from the
 * right edge in every table: a column a kind lacks gives its width to the
 * next one it has (right-aligned, its figures stay under the other tables').
 */
const ALIGNED: readonly DataKey[] = LAYOUTS.exam.columns;

function widthsOf(columns: readonly DataKey[]): Partial<Record<DataKey, string>> {
  const widths: Partial<Record<DataKey, string>> = {};
  let carried = 0;
  for (const key of ALIGNED) {
    if (columns.includes(key)) {
      widths[key] = `${COLUMNS[key].width + carried}rem`;
      carried = 0;
    } else carried += COLUMNS[key].width;
  }
  if (columns.includes("mode")) widths.mode = `${COLUMNS.mode.width}rem`;
  return widths;
}

export function ClassroomTable({
  layout,
  rows,
  ctx,
}: {
  layout: TableLayout;
  /** In the order to draw until a column label is clicked. */
  rows: readonly ClassroomRow[];
  ctx: RowContext;
}) {
  const t = useT();
  const { columns: keys, labels = {} } = LAYOUTS[layout];
  const widths = widthsOf(keys);
  const { sorted, sort, toggle } = useSortableTable<ClassroomRow, SortKey>(
    rows,
    (row, key) => (key === "title" ? row.title : COLUMNS[key].rank(row, t)),
    null,
  );
  const columns: Column<SortKey>[] = [
    { key: "title", label: t("eval.titleLabel") },
    ...keys.map((key) => ({
      key,
      label: t(labels[key] ?? COLUMNS[key].label),
      right: COLUMNS[key].right,
      className: COLUMNS[key].className,
      width: widths[key],
    })),
    { key: "actions", label: t("common.actions"), sortable: false, srOnly: true, width: `${ACTIONS_WIDTH}rem` },
  ];
  return (
    <Card className={`${T.container} overflow-hidden`}>
      <table className={`${T.table} table-fixed`}>
        <TableHead columns={columns} sort={sort} onToggle={toggle} />
        <tbody>
          {sorted.map((row) => {
            const spec = specOf(row);
            return (
              <tr
                key={row.id}
                className={`${T.row} ${T.rowHover} cursor-pointer`}
                {...pressable(spec.open(row, ctx.navigate), "row")}
              >
                <td className={T.td}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{row.title}</span>
                    <spec.Badges row={row} ctx={ctx} />
                  </span>
                </td>
                {keys.map((key) => (
                  <td
                    key={key}
                    className={cx(
                      T.td,
                      COLUMNS[key].className,
                      "whitespace-nowrap tabular-nums",
                      COLUMNS[key].right ? "text-right" : "text-fg-muted",
                    )}
                  >
                    {COLUMNS[key].cell(row, t)}
                  </td>
                ))}
                <td className={`${T.td} text-right`} onClick={(e) => e.stopPropagation()}>
                  <spec.Actions row={row} ctx={ctx} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
