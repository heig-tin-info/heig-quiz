import { ClipboardList, FolderGit2, Plus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { ClassroomTable, startOf, typeOfRow, type ClassroomRow } from "./activities/ClassroomTable";
import { isScheduled, type ActivityType } from "./activities/model";
import { TYPE_ICON } from "./activities/views";
import { useEvaluations } from "./evaluation/api";
import { useEvaluationRowActions } from "./evaluation/EvaluationList";
import { githubAbsent } from "./github/api";
import { useT, type Dict } from "./i18n";
import { useClassroomProjects, useProjectRename } from "./project/classroomProjects";
import type { Route } from "./router";
import {
  Button,
  Card,
  EmptyState,
  QueryError,
  SectionHeading,
  Segmented,
  Skeleton,
  ToggleChip,
  usePersistentChoice,
  type ButtonVariant,
  type IconType,
} from "./ui";

/** The doors of the empty tab: "New evaluation" and, where a project has one, "Project". */
export interface ActivityDoors {
  /** Opens the page's "New evaluation" dialog. */
  onNew: () => void;
  /** The header menu's "Project" (`newProjectAction`); absent where a project has no door. */
  newProject?: { description?: string; onSelect: () => void } | null;
  /**
   * `secondary` on the training classroom while the progress card's button
   * is the screen's one accent (ADR-105 §4, the same demotion as the
   * header's "New ▾").
   */
  newVariant?: ButtonVariant;
}

/**
 * Grouped (one table per kind) or All (one table). Remembered per browser
 * under the key the former "Group by" used: a stored none, status or mode
 * reads as the default.
 */
type Layout = "grouped" | "all";
const LAYOUTS: readonly Layout[] = ["grouped", "all"];
const LAYOUT_KEY = "quiz-evaluations-group";

/** The Grouped tables, in this order, each with its heading's words. */
const GROUP_ORDER: readonly ActivityType[] = ["exam", "exercise", "project", "poll"];
const GROUP_TITLE: Record<ActivityType, keyof Dict> = {
  exam: "activities.group.exam",
  exercise: "activities.group.exercise",
  project: "project.group",
  poll: "activities.group.poll",
};

/** All's order until a label is clicked: what has no start yet (drafts) first, then the latest start. */
function byStart(rows: readonly ClassroomRow[]): ClassroomRow[] {
  const at = (row: ClassroomRow) => {
    const start = startOf(row);
    return start === null ? Infinity : Date.parse(start);
  };
  // Two undated rows give NaN: a tie, kept in the order handed.
  return [...rows].sort((a, b) => at(b) - at(a) || 0);
}

function Section({
  id,
  icon,
  title,
  count,
  children,
}: {
  id: string;
  icon: IconType;
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <SectionHeading icon={icon} title={<span id={id}>{title}</span>} count={count} />
      {children}
    </section>
  );
}

/**
 * A classroom's Activities tab: its evaluations and its projects (M3-10),
 * as one table per kind — exams, exercises, projects, polls, a kind with no
 * row drawing none — or as one table of everything (Grouped / All). Above
 * them, the "Scheduled" filter (#787): what is already in the pipe, both
 * kinds at once, for the teacher who plans ahead. Pressed, each table keeps
 * its scheduled rows, and a table with none leaves the page as an empty
 * kind does.
 *
 * The chip shows only where it can find something (the two lists' own
 * reads, cached: no request of its own), and the filter holds only while it
 * does — a scheduled exam that opens leaves the filter, it never empties
 * the tab, and the chip comes back unpressed. Not remembered: a filter a
 * teacher forgot would hide what runs.
 *
 * No button with rows: "New ▾" is in the page header, the tab's one primary
 * (#295). The empty state, drawn only when the classroom has neither an
 * evaluation nor a project, folds it open. The projects' list draws nothing
 * while it loads or on a platform without the App (404): most classrooms
 * never use GitHub, and a skeleton that collapses to nothing would be a
 * jump on every visit.
 */
export function ClassroomActivities({
  classroomId,
  navigate,
  doors,
}: {
  classroomId: string;
  navigate: (r: Route) => void;
  doors: ActivityDoors;
}) {
  const t = useT();
  const [pressed, setPressed] = useState(false);
  const [layout, setLayout] = usePersistentChoice(LAYOUT_KEY, LAYOUTS, "grouped");
  const evaluationList = useEvaluations(classroomId);
  const projectList = useClassroomProjects(classroomId);
  const evaluation = useEvaluationRowActions(classroomId, navigate);
  const project = useProjectRename(classroomId);
  const evaluationRows = evaluationList.data ?? [];
  const projectRows = projectList.data ?? [];
  const any = evaluationRows.some(isScheduled) || projectRows.some(isScheduled);
  const scheduledOnly = pressed && any;
  // Once the filter has dropped, it stays off for the visit: a row scheduled
  // later must not bring back a filter the teacher no longer sees as on.
  useEffect(() => {
    if (!any) setPressed(false);
  }, [any]);

  const all: ClassroomRow[] = [...evaluationRows, ...projectRows];
  const rows = scheduledOnly ? all.filter(isScheduled) : all;
  const projectsFailed = projectList.isError && !githubAbsent(projectList.error);
  const empty = evaluationList.isSuccess && all.length === 0 && !projectList.isLoading;
  const table = (layoutOf: ActivityType | "all", shown: readonly ClassroomRow[]) => (
    <ClassroomTable layout={layoutOf} rows={shown} navigate={navigate} evaluation={evaluation} project={project} />
  );

  return (
    <div className="space-y-3">
      {all.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          {any ? (
            <ToggleChip
              label={t("activities.filter.scheduled")}
              pressed={scheduledOnly}
              onToggle={() => setPressed(!scheduledOnly)}
            />
          ) : null}
          {/* One row has nothing to group. */}
          {all.length < 2 ? null : (
            <Segmented
              name="activities-layout"
              label={t("activities.layout")}
              value={layout}
              onChange={setLayout}
              options={LAYOUTS.map((l) => ({ value: l, label: t(`activities.layout.${l}`) }))}
            />
          )}
        </div>
      ) : null}
      <div className="space-y-8">
        {/* A failed read still says so, filter or not. */}
        {evaluationList.isError ? (
          <Section id="classroom-evaluations" icon={ClipboardList} title={t("eval.title")}>
            <QueryError title={t("eval.notFound")} query={evaluationList} />
          </Section>
        ) : null}
        {evaluationList.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : empty ? (
          <Card>
            <EmptyState
              icon={ClipboardList}
              title={t("eval.empty.title")}
              action={
                /* The header's "New ▾" folded open: an empty tab has room to
                   show both doors, the evaluation still the primary. */
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant={doors.newVariant ?? "primary"} onClick={doors.onNew}>
                    <Plus /> {t("eval.new")}
                  </Button>
                  {doors.newProject ? (
                    <Button variant="secondary" title={doors.newProject.description} onClick={doors.newProject.onSelect}>
                      <FolderGit2 /> {t("project.new")}
                    </Button>
                  ) : null}
                </div>
              }
            >
              {t("eval.empty.body")}
            </EmptyState>
          </Card>
        ) : layout === "all" ? (
          rows.length === 0 ? null : (
            <Section id="classroom-activities" icon={ClipboardList} title={t("activities.title")} count={rows.length}>
              {table("all", byStart(rows))}
            </Section>
          )
        ) : (
          GROUP_ORDER.map((kind) => {
            const shown = rows.filter((row) => typeOfRow(row) === kind);
            return shown.length === 0 ? null : (
              <Section key={kind} id={`classroom-${kind}`} icon={TYPE_ICON[kind]} title={t(GROUP_TITLE[kind])} count={shown.length}>
                {table(kind, shown)}
              </Section>
            );
          })
        )}
        {projectsFailed ? <QueryError title={t("project.loadFailed")} query={projectList} /> : null}
      </div>
      {evaluation.layers}
      {project.layers}
    </div>
  );
}

