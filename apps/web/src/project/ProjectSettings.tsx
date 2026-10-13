import { useQuery } from "@tanstack/react-query";
import { PROTECTED_FILE_SUGGESTIONS, type ProjectDetail, type ProjectSourceDetail } from "@quiz/contracts";

import { PROJECT_GRADING_MODES } from "@quiz/domain";

import { api } from "../api";
import { useT } from "../i18n";
import { projectSourceKey } from "../queryKeys";
import { Card, SettingRow } from "../ui";
import { repoShortName, type WriteProject } from "./projectPage";
import { CriteriaRows, CriteriaSwitchRow } from "./ProjectCriteria";
import { DeadlineStrategyRow, GradingModeRow } from "./ProjectSettingRows";
import { ProtectedFiles, sourceFiles } from "./ProtectedFiles";
import { WorkModeSetting } from "./ProjectWorkspace";

/** The protected files on offer: the suggestions as checkboxes, the source's files as completions. */
export interface ProtectedOffer {
  suggested: readonly string[];
  files: readonly string[];
}

/**
 * The protected files on offer (F-PROJ-01): the source's suggestions, and
 * every file of its tree as a completion of a path added by hand. A file
 * protected today that the source does not suggest is an added path
 * (`ProtectedFiles`). Until the source is read, the suggestions protected
 * today stand for its own, so that none of them is drawn as an added chip
 * meanwhile (the source's unchecked suggestions still appear once it is read).
 */
export function useProtectedSuggestions(project: ProjectDetail, enabled: boolean): ProtectedOffer {
  const sourceRepo = repoShortName(project.source.fullName);
  const source = useQuery<ProjectSourceDetail>({
    queryKey: projectSourceKey(project.classroomId, sourceRepo),
    enabled: project.editable.includes("protectedFiles") && enabled,
    queryFn: () =>
      api(`/app/api/classrooms/${project.classroomId}/projects/sources/${encodeURIComponent(sourceRepo)}`),
  });
  const known: readonly string[] = PROTECTED_FILE_SUGGESTIONS;
  return {
    suggested: source.data?.suggestedProtected ?? project.protectedFiles.filter((p) => known.includes(p)),
    files: sourceFiles(source.data),
  };
}

/** The protected files: an editor while `editable` names them, the list otherwise. */
export function ProtectedFilesRow({
  project,
  disabled,
  offer,
  onChange,
}: {
  project: ProjectDetail;
  disabled: boolean;
  offer: ProtectedOffer;
  onChange: (protectedFiles: string[]) => void;
}) {
  const t = useT();
  return (
    <SettingRow stacked title={t("project.protected")} desc={`${t("project.protected.desc")} ${t("project.protected.hint")}`}>
      {project.editable.includes("protectedFiles") ? (
        <fieldset disabled={disabled} className="min-w-0">
          <ProtectedFiles suggested={offer.suggested} files={offer.files} value={project.protectedFiles} onChange={onChange} />
        </fieldset>
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
  const offer = useProtectedSuggestions(project, true);

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
        offer={offer}
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
