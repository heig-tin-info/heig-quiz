import { useState } from "react";

import { isScheduled } from "./activities/model";
import { useEvaluations } from "./evaluation/api";
import { EvaluationList } from "./evaluation/EvaluationList";
import { useT } from "./i18n";
import { ProjectGroup, useClassroomProjects } from "./project/ProjectGroup";
import type { Route } from "./router";
import { ToggleChip } from "./ui";

/**
 * A classroom's Activities tab: its evaluations, then its projects
 * (`ProjectGroup`, M3-10), and above both the "Scheduled" filter (#787) —
 * what is already in the pipe, both kinds at once, for the teacher who
 * plans ahead. It is the `/activities` chip of the same name, not a section
 * of its own: pressed, each list keeps its scheduled rows and a list with
 * none leaves the page.
 *
 * The chip shows only where it can find something (the two lists' own
 * reads, cached: no request of its own), and the filter holds only while it
 * does — a scheduled exam that opens leaves the filter, it never empties
 * the tab. Not remembered: a filter a teacher forgot would hide what runs.
 */
export function ClassroomActivities({
  classroomId,
  navigate,
  evaluations,
}: {
  classroomId: string;
  navigate: (r: Route) => void;
  /** `EvaluationList`'s own doors (its empty state's "New evaluation" and "Project"). */
  evaluations: Pick<Parameters<typeof EvaluationList>[0], "onNew" | "newProject" | "newVariant">;
}) {
  const t = useT();
  const [pressed, setPressed] = useState(false);
  const evaluationRows = useEvaluations(classroomId).data ?? [];
  const projectRows = useClassroomProjects(classroomId).data ?? [];
  const any = evaluationRows.some(isScheduled) || projectRows.some(isScheduled);
  const scheduledOnly = pressed && any;
  return (
    <>
      <div className="space-y-3">
        {any ? (
          <ToggleChip
            label={t("activities.filter.scheduled")}
            pressed={scheduledOnly}
            onToggle={() => setPressed(!scheduledOnly)}
          />
        ) : null}
        <EvaluationList classroomId={classroomId} navigate={navigate} scheduledOnly={scheduledOnly} {...evaluations} />
      </div>
      <ProjectGroup classroomId={classroomId} navigate={navigate} scheduledOnly={scheduledOnly} />
    </>
  );
}
