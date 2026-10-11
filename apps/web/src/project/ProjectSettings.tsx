import { useQuery, type UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";

import type { DeadlineStrategy, ProjectDetail, ProjectPatch, ProjectSourceDetail, ProjectSummary } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { projectSourceKey } from "../queryKeys";
import { Badge, Disclosure, Segmented, SettingRow } from "../ui";
import { repoShortName } from "./projectPage";
import { ProtectedFiles } from "./ProtectedFiles";
import { WorkModeSetting } from "./ProjectWorkspace";

/**
 * The protected files on offer (F-PROJ-01): the source's suggestions, and a
 * file protected today that the source no longer suggests stays on the list.
 */
export function useProtectedSuggestions(project: ProjectDetail, enabled: boolean): string[] {
  const sourceRepo = repoShortName(project.source.fullName);
  const source = useQuery<ProjectSourceDetail>({
    queryKey: projectSourceKey(project.classroomId, sourceRepo),
    enabled: project.editable.includes("protectedFiles") && enabled,
    queryFn: () =>
      api(`/app/api/classrooms/${project.classroomId}/projects/sources/${encodeURIComponent(sourceRepo)}`),
  });
  return [...new Set([...(source.data?.suggestedProtected ?? []), ...project.protectedFiles])];
}

/** What happens at the deadline: a row of a draft's Advanced options and of a published project's Settings. */
export function DeadlineStrategyRow({
  project,
  disabled,
  onChange,
}: {
  project: ProjectDetail;
  disabled: boolean;
  onChange: (deadlineStrategy: DeadlineStrategy) => void;
}) {
  const t = useT();
  return (
    <SettingRow
      title={t("project.deadlineStrategy")}
      desc={t(`project.deadlineStrategy.desc.${project.deadlineStrategy}`)}
    >
      <Segmented
        name="deadlineStrategy"
        label={t("project.deadlineStrategy")}
        value={project.deadlineStrategy}
        disabled={disabled || !project.editable.includes("deadlineStrategy")}
        onChange={onChange}
        options={[
          { value: "lock", label: t("project.deadlineStrategy.lock") },
          { value: "commit", label: t("project.deadlineStrategy.commit") },
        ]}
      />
    </SettingRow>
  );
}

/** The protected files: an editor while `editable` names them, the list otherwise. */
export function ProtectedFilesRow({
  project,
  disabled,
  suggested,
  onChange,
}: {
  project: ProjectDetail;
  disabled: boolean;
  suggested: string[];
  onChange: (protectedFiles: string[]) => void;
}) {
  const t = useT();
  return (
    <SettingRow stacked title={t("project.protected")} desc={t("project.protected.desc")}>
      {project.editable.includes("protectedFiles") ? (
        <fieldset disabled={disabled} className="min-w-0">
          <ProtectedFiles suggested={suggested} value={project.protectedFiles} onChange={onChange} />
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
 * work — in a folded card at the bottom of the page, with a count of the
 * protected files beside its title. They stay editable, each written as soon
 * as the teacher sets it, through the page's one `PATCH`; what `editable`
 * does not name is drawn disabled: the server decides, the screen follows
 * (`projectFieldRefusal`). The deadline itself is edited in its tile
 * (`ProjectOverview`), the name in the header. A draft has its own form
 * (`ProjectDraftForm`).
 */
export function ProjectSettings({
  project,
  patch,
}: {
  project: ProjectDetail;
  patch: UseMutationResult<ProjectSummary, Error, ProjectPatch>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const busy = patch.isPending || project.archivedAt !== null;
  const suggested = useProtectedSuggestions(project, open);
  const protectedCount = project.protectedFiles.length;

  return (
    <Disclosure
      title={t("project.settings")}
      desc={t("project.settings.desc")}
      open={open}
      onOpenChange={setOpen}
      aside={
        protectedCount > 0 ? (
          <Badge tone="zinc">
            <span aria-hidden>{protectedCount}</span>
            <span className="sr-only">{protectedCount === 1 ? t("project.settings.count.one") : t("project.settings.count", { n: protectedCount })}</span>
          </Badge>
        ) : null
      }
    >
      <DeadlineStrategyRow project={project} disabled={busy} onChange={(deadlineStrategy) => patch.mutate({ deadlineStrategy })} />
      <ProtectedFilesRow
        project={project}
        disabled={busy}
        suggested={suggested}
        onChange={(protectedFiles) => patch.mutate({ protectedFiles })}
      />
      <WorkModeSetting projectId={project.id} archived={project.archivedAt !== null} />
    </Disclosure>
  );
}
