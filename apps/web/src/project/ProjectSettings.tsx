import { useQuery } from "@tanstack/react-query";
import type { ProjectDetail } from "@quiz/contracts";

import { forcedProtected, PROJECT_GRADING_MODES } from "@quiz/domain";

import { useT } from "../i18n";
import { Card, repoShortName, SettingRow, Skeleton } from "../ui";
import { sourceDetailQuery } from "./newProject";
import type { WriteProject } from "./projectPage";
import { CriteriaRows, CriteriaSwitchRow } from "./ProjectCriteria";
import { DeadlineStrategyRow, GradingModeRow } from "./ProjectSettingRows";
import { ProtectedFiles } from "./ProtectedFiles";
import { WorkModeSetting } from "./ProjectWorkspace";

/**
 * The tree the project's students receive (ADR-119 §9): its source read at
 * its first branch, under its strategy, while the protected files may
 * change and the settings are open (`enabled`). A tree that cannot be read
 * leaves the list alone to edit.
 */
export function useHandoutTree(project: ProjectDetail, enabled: boolean) {
  return useQuery({
    ...sourceDetailQuery(project.classroomId, repoShortName(project.source.fullName), {
      branch: project.branches[0],
      strategy: project.sourceStrategy,
    }),
    enabled: project.editable.includes("protectedFiles") && enabled,
  });
}

/**
 * The protected files: picked from the handed-out tree while `editable`
 * names them, the list otherwise. In `criteria` mode the workflows and the
 * criteria are forced (ADR-119 §9): the server keeps them whatever is sent.
 */
export function ProtectedFilesRow({
  project,
  disabled,
  source,
  onChange,
}: {
  project: ProjectDetail;
  disabled: boolean;
  source: ReturnType<typeof useHandoutTree>;
  onChange: (protectedFiles: string[]) => void;
}) {
  const t = useT();
  const forced = forcedProtected(project.gradingMode);
  return (
    <SettingRow stacked title={t("project.protected")} desc={`${t("project.protected.desc")} ${t("project.protected.hint")}`}>
      {project.editable.includes("protectedFiles") ? (
        source.isPending && source.fetchStatus !== "idle" ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <fieldset disabled={disabled} className="min-w-0">
            <ProtectedFiles
              tree={source.data?.tree ?? []}
              truncated={source.data?.truncated}
              value={project.protectedFiles.filter((p) => !forced.includes(p))}
              forced={forced}
              onChange={onChange}
            />
          </fieldset>
        )
      ) : project.protectedFiles.length > 0 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[13px] text-fg-muted">
          {project.protectedFiles.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-fg-muted">{t("project.protected.none")}</p>
      )}
    </SettingRow>
  );
}

/**
 * The settings of a PUBLISHED project (F-PROJ-03) that it rarely changes:
 * what happens at the deadline, the protected files and where the students
 * work — the page's Settings tab (F-PROJ-13 as amended 2026-10-13). They stay
 * editable, each written as soon as the teacher sets it, through the page's
 * one `PATCH`; what `editable` does not name is drawn disabled: the server
 * decides, the screen follows (`projectFieldRefusal`). The deadline itself is
 * edited in its tile (`ProjectOverview`), the name in the header. A draft has
 * its own form (`ProjectDraftForm`). Grading by criteria (ADR-106): its
 * settings and the snapshot of `criteria.yml` in that mode; before it, on a
 * locked project not yet released, the one switch to it.
 */
export function ProjectSettings({
  project,
  pending,
  write,
}: {
  project: ProjectDetail;
  /** A write is under way. */
  pending: boolean;
  write: WriteProject;
}) {
  const busy = pending || project.archivedAt !== null;
  const source = useHandoutTree(project, true);

  return (
    <Card className="divide-y divide-line px-5" data-testid="project-settings">
      <DeadlineStrategyRow
        value={project.deadlineStrategy}
        disabled={busy || !project.editable.includes("deadlineStrategy")}
        onChange={(deadlineStrategy) => write({ deadlineStrategy })}
      />
      <ProtectedFilesRow
        project={project}
        disabled={busy}
        source={source}
        onChange={(protectedFiles) => write({ protectedFiles })}
      />
      <WorkModeSetting projectId={project.id} archived={project.archivedAt !== null} />
      {project.gradingMode === "criteria" ? (
        <>
          {/* Out of `criteria` while the project is locked and unreleased (ADR-106 §1). */}
          {project.editable.includes("gradingMode") ? (
            <GradingModeRow modes={PROJECT_GRADING_MODES} value={project.gradingMode} disabled={busy} onChange={(gradingMode) => write({ gradingMode })} />
          ) : null}
          <CriteriaRows project={project} disabled={busy} write={write} />
        </>
      ) : project.editable.includes("gradingMode") ? (
        <CriteriaSwitchRow disabled={busy} write={write} />
      ) : null}
    </Card>
  );
}
