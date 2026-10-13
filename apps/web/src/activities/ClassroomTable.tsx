import type { ReactNode } from "react";

import type { EvaluationSummary, ProjectActivitySummary } from "@quiz/contracts";
import { templatePullable } from "@quiz/domain";

import { evaluationHome, evaluationStateLabel, evaluationTimerAt, stateStyle } from "../evaluation/common";
import type { useEvaluationRowActions } from "../evaluation/EvaluationList";
import { TemplateBehindBadge } from "../evaluation/templatePull";
import { useT, type Dict, type TFunction } from "../i18n";
import type { useProjectRename } from "../project/classroomProjects";
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
  TimeLeft,
  useSortableTable,
  type Column,
} from "../ui";
import { ActivityMenu } from "./actions";
import { typeName, type ActivityType } from "./model";
import { openProps, StateBadge } from "./views";

/*
 * The tables of a classroom's Activities tab (`ClassroomActivities`): one
 * table, configured by its columns, for each kind of the Grouped layout and
 * for the All layout's single merged table. A row keeps its own kind's
 * badge, destination and actions whichever table holds it.
 */

/** A row of the tab: one of the classroom's evaluations, or one of its projects. */
export type ClassroomRow = EvaluationSummary | ProjectActivitySummary;

/** The classroom's evaluations carry no `kind`; only a project does. */
export const isProject = (row: ClassroomRow): row is ProjectActivitySummary => "kind" in row;

/** What a row is: an evaluation's mode, or "project". */
export const typeOfRow = (row: ClassroomRow): ActivityType => (isProject(row) ? "project" : row.mode);

/**
 * When a row started, or is to open (#795): an evaluation opened by hand has
 * no `opensAt`, only the `startedAt` of its first run. Null when neither.
 */
export const startOf = (row: ClassroomRow): string | null =>
  isProject(row) ? row.startAt : (row.startedAt ?? row.opensAt);

/** When it closes: an evaluation's end, a project's deadline (#787). */
const endOf = (row: ClassroomRow): string | null => (isProject(row) ? row.deadlineAt : row.closesAt);

/** Null where a kind has none — a project's questions, a poll's points — drawn as a dash and sorted last. */
const questionsOf = (row: ClassroomRow): number | null => (isProject(row) ? null : row.itemCount);
const pointsOf = (row: ClassroomRow): number | null =>
  isProject(row) || row.mode === "poll" ? null : row.totalPoints;

type DataKey = "mode" | "start" | "end" | "questions" | "points" | "participants";
type SortKey = "title" | DataKey;

const dateCell = (iso: string | null) => (iso === null ? <Dash /> : isoDateTime(iso));
const countCell = (n: number | null) => (n === null ? <Dash /> : n);

/**
 * Each column as data: its words, its priority as the card narrows (the
 * participants go first, then the points, then the dates and the number of
 * questions — the title with its badge and the actions stay), what it sorts
 * on and what it draws.
 */
const COLUMNS: Record<
  DataKey,
  {
    label: keyof Dict;
    className?: string;
    right?: boolean;
    rank: (row: ClassroomRow, t: TFunction) => string | number | null;
    cell: (row: ClassroomRow, t: TFunction) => ReactNode;
  }
> = {
  mode: {
    label: "eval.mode",
    rank: (row, t) => typeName(typeOfRow(row), t),
    // A poll is the one evaluation that changes where the whole row leads, so
    // it is a badge and the others stay words. Zinc, never the accent: "New"
    // owns the red on this screen.
    cell: (row, t) =>
      typeOfRow(row) === "poll" ? <Badge tone="zinc">{t("eval.mode.poll")}</Badge> : typeName(typeOfRow(row), t),
  },
  start: { label: "eval.col.start", className: T.colHigh, rank: startOf, cell: (row) => dateCell(startOf(row)) },
  end: { label: "eval.col.end", className: T.colHigh, rank: endOf, cell: (row) => dateCell(endOf(row)) },
  questions: {
    label: "eval.step.questions",
    className: T.colHigh,
    right: true,
    rank: questionsOf,
    cell: (row) => countCell(questionsOf(row)),
  },
  points: { label: "eval.col.points", className: T.colMid, right: true, rank: pointsOf, cell: (row) => countCell(pointsOf(row)) },
  participants: {
    label: "eval.col.participants",
    className: T.colLow,
    right: true,
    rank: (row) => row.participantCount,
    cell: (row) => (row.participantCount === 0 ? <Dash /> : row.participantCount),
  },
};

/** A table's layout: one kind of the Grouped layout, or the All layout's merged table. */
export type TableLayout = ActivityType | "all";

/** The columns of each table between the title and the actions. */
const LAYOUT_COLUMNS: Record<TableLayout, readonly DataKey[]> = {
  exam: ["start", "end", "questions", "points", "participants"],
  exercise: ["start", "end", "questions", "points", "participants"],
  project: ["start", "end", "participants"],
  poll: ["start", "end", "questions", "participants"],
  all: ["mode", "start", "end", "questions", "points", "participants"],
};

/** The row's own badges: its state, the time left inside it (ADR-104), and an evaluation's template pull (F-EVAL-26). */
function Badges({ row, onPull }: { row: ClassroomRow; onPull: (id: string) => void }) {
  const t = useT();
  if (isProject(row)) return <StateBadge row={row} timer />;
  return (
    <>
      <Badge {...stateStyle(row.state)}>
        {evaluationStateLabel(row.state, t)}
        <TimeLeft iso={evaluationTimerAt(row)} />
      </Badge>
      {/* Shown only where the pull would be accepted, as the pull's own door. */}
      {templatePullable(row) ? (
        <TemplateBehindBadge
          from={row.originRevision!}
          to={row.templateRevision!}
          title={row.title}
          onOpen={() => onPull(row.id)}
        />
      ) : null}
    </>
  );
}

export function ClassroomTable({
  layout,
  rows,
  navigate,
  evaluation,
  project,
}: {
  layout: TableLayout;
  /** In the order to draw until a column label is clicked. */
  rows: readonly ClassroomRow[];
  navigate: (r: Route) => void;
  evaluation: ReturnType<typeof useEvaluationRowActions>;
  project: ReturnType<typeof useProjectRename>;
}) {
  const t = useT();
  const keys = LAYOUT_COLUMNS[layout];
  const { sorted, sort, toggle } = useSortableTable<ClassroomRow, SortKey>(
    rows,
    (row, key) => (key === "title" ? row.title : COLUMNS[key].rank(row, t)),
    null,
  );
  const columns: Column<SortKey>[] = [
    { key: "title", label: t("eval.titleLabel") },
    ...keys.map((key) => ({
      key,
      // A project's end is its deadline, and its own table says so.
      label: t(layout === "project" && key === "end" ? "project.deadline" : COLUMNS[key].label),
      right: COLUMNS[key].right,
      className: COLUMNS[key].className,
    })),
    { key: "actions", label: t("common.actions"), sortable: false, srOnly: true, className: "w-10" },
  ];
  return (
    <Card className={`${T.container} overflow-hidden`}>
      <table className={T.table}>
        <TableHead columns={columns} sort={sort} onToggle={toggle} />
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.id}
              className={`${T.row} ${T.rowHover} cursor-pointer`}
              {...(isProject(row)
                ? openProps(row, navigate, "row")
                : pressable(() => navigate(evaluationHome(row)), "row"))}
            >
              <td className={T.td}>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{row.title}</span>
                  <Badges row={row} onPull={evaluation.pull} />
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
                {isProject(row) ? (
                  <ActivityMenu row={row} navigate={navigate} onRename={project.rename} />
                ) : (
                  <Menu label={t("live.row.actions", { name: row.title })} items={evaluation.menuItems(row)} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
