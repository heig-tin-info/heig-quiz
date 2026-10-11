import { useQuery, type UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";

import type { ProjectDetail, ProjectPatch, ProjectPatchField, ProjectSourceDetail, ProjectSummary } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { projectSourceKey } from "../queryKeys";
import { Badge, Disclosure, Segmented, SettingRow } from "../ui";
import { repoShortName } from "./projectPage";
import { ProtectedFiles } from "./ProtectedFiles";
import { WorkModeSetting } from "./ProjectWorkspace";

/**
 * The settings of a project (F-PROJ-03) that a published project rarely
 * changes: what happens at the deadline, the protected files and where the
 * students work — in a folded card at the bottom of the page, with a count
 * of the protected files beside its title. They stay editable, each written
 * as soon as the teacher sets it, through the page's one `PATCH`; what
 * `editable` does not name is drawn disabled: the server decides, the screen
 * follows (`projectFieldRefusal`). The deadline itself is edited in its tile
 * (`ProjectOverview`), the name in the header.
 *
 * A draft keeps the card open: its page is still the settings' place until
 * its own redesign.
 */
export function ProjectSettings({
  project,
  patch,
}: {
  project: ProjectDetail;
  patch: UseMutationResult<ProjectSummary, Error, ProjectPatch>;
}) {
  const t = useT();
  const [open, setOpen] = useState(project.state === "draft");
  const can = (field: ProjectPatchField) => project.editable.includes(field);
  const busy = patch.isPending || project.archivedAt !== null;

  // The source's suggestions are the protected files on offer (F-PROJ-01); a
  // file protected today that the source no longer suggests stays on the list.
  const sourceRepo = repoShortName(project.source.fullName);
  const source = useQuery<ProjectSourceDetail>({
    queryKey: projectSourceKey(project.classroomId, sourceRepo),
    enabled: can("protectedFiles") && open,
    queryFn: () =>
      api(`/app/api/classrooms/${project.classroomId}/projects/sources/${encodeURIComponent(sourceRepo)}`),
  });
  const suggested = [...new Set([...(source.data?.suggestedProtected ?? []), ...project.protectedFiles])];
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
            <span className="sr-only">{t("project.settings.count", { n: protectedCount })}</span>
          </Badge>
        ) : null
      }
    >
      <SettingRow
        title={t("project.deadlineStrategy")}
        desc={t(`project.deadlineStrategy.desc.${project.deadlineStrategy}`)}
      >
        <Segmented
          name="deadlineStrategy"
          label={t("project.deadlineStrategy")}
          value={project.deadlineStrategy}
          disabled={busy || !can("deadlineStrategy")}
          onChange={(deadlineStrategy) => patch.mutate({ deadlineStrategy })}
          options={[
            { value: "lock", label: t("project.deadlineStrategy.lock") },
            { value: "commit", label: t("project.deadlineStrategy.commit") },
          ]}
        />
      </SettingRow>

      <SettingRow stacked title={t("project.protected")} desc={t("project.protected.desc")}>
        {can("protectedFiles") ? (
          <fieldset disabled={busy} className="min-w-0">
            <ProtectedFiles
              suggested={suggested}
              value={project.protectedFiles}
              onChange={(protectedFiles) => patch.mutate({ protectedFiles })}
            />
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

      <WorkModeSetting projectId={project.id} archived={project.archivedAt !== null} />
    </Disclosure>
  );
}
