import { useQuery, type UseMutationResult } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";

import type {
  ProjectDetail,
  ProjectPatch,
  ProjectPatchField,
  ProjectSourceDetail,
  ProjectSummary,
} from "@quiz/contracts";

import { api, refusedWith } from "../api";
import { useConfirm } from "../confirm";
import { DateField } from "../evaluation/TimingStep";
import { useT } from "../i18n";
import { projectSourceKey } from "../queryKeys";
import { Card, Fact, FieldError, fieldErrorProps, SectionHeading, Segmented, SettingRow } from "../ui";
import { foreignZone } from "./newProject";
import { RepoLink } from "./parts";
import { deadlineDesc, isReopen, reopenedRepos, repoShortName } from "./projectPage";
import { ProtectedFiles } from "./ProtectedFiles";

const DEADLINE_ID = "project-deadline";

/**
 * The settings of a project (F-PROJ-03): what may still change once it is
 * published — the deadline, what happens at it and the protected files; the
 * name is renamed in the header — each written as soon as the teacher sets
 * it, through the page's one `PATCH`. What `editable` does not name is drawn
 * disabled: the server decides, the screen follows (`projectFieldRefusal`).
 * A draft's other settings are edited through the same patch in a later
 * task; until then the facts below say what was set.
 *
 * Moving the deadline later once it has passed REOPENS the project
 * (F-PROJ-09): the locks lifted, the freeze undone, the runs requalified.
 * That is asked first, with the number of repositories it reaches.
 */
export function ProjectSettings({
  project,
  patch,
}: {
  project: ProjectDetail;
  patch: UseMutationResult<ProjectSummary, Error, ProjectPatch>;
}) {
  const t = useT();
  const confirm = useConfirm();
  const can = (field: ProjectPatchField) => project.editable.includes(field);
  const busy = patch.isPending || project.archivedAt !== null;

  // The source's suggestions are the protected files on offer (F-PROJ-01); a
  // file protected today that the source no longer suggests stays on the list.
  const sourceRepo = repoShortName(project.source.fullName);
  const source = useQuery<ProjectSourceDetail>({
    queryKey: projectSourceKey(project.classroomId, sourceRepo),
    enabled: can("protectedFiles"),
    queryFn: () =>
      api(`/app/api/classrooms/${project.classroomId}/projects/sources/${encodeURIComponent(sourceRepo)}`),
  });
  const suggested = [...new Set([...(source.data?.suggestedProtected ?? []), ...project.protectedFiles])];

  const deadlineRefused =
    patch.variables?.deadlineAt !== undefined && refusedWith(patch.error, "deadline_past")
      ? t("project.refusal.deadlinePast")
      : undefined;

  const commitDeadline = async (deadlineAt: string | null, reset: () => void) => {
    if (deadlineAt === null) {
      reset();
      return;
    }
    const now = Date.now();
    if (isReopen(project, deadlineAt, now)) {
      const ok = await confirm({
        title: t("project.reopen.title"),
        message: t("project.reopen.body", { n: reopenedRepos(project, deadlineAt, now) }),
        confirmLabel: t("project.reopen.confirm"),
      });
      if (!ok) {
        reset();
        return;
      }
    }
    // A manual deadline counted as a duration becomes a date once set by hand.
    patch.mutate(
      { deadlineAt, ...(project.durationMinutes !== null ? { durationMinutes: null } : {}) },
      { onError: reset },
    );
  };

  return (
    <section aria-labelledby="project-settings" className="space-y-3">
      <SectionHeading icon={Settings2} title={<span id="project-settings">{t("project.settings")}</span>} />
      <Card className="divide-y divide-line px-4">
        {/* The field's own label names the row: no title beside it. */}
        <div className="flex flex-col gap-1 py-3">
          <DateField
            key={project.deadlineAt}
            id={DEADLINE_ID}
            label={t("project.deadline")}
            description={deadlineDesc(project, foreignZone(), t)}
            disabled={busy || !can("deadlineAt")}
            value={project.deadlineAt}
            onCommit={(value, reset) => void commitDeadline(value, reset)}
            {...fieldErrorProps(DEADLINE_ID, deadlineRefused)}
          />
          <FieldError id={DEADLINE_ID}>{deadlineRefused}</FieldError>
        </div>

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

        <div className="space-y-2.5 py-3">
          <div>
            <p className="text-sm font-medium text-fg">{t("project.protected")}</p>
            <p className="mt-0.5 text-[13px] text-fg-muted">{t("project.protected.desc")}</p>
          </div>
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
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 py-4 sm:grid-cols-4">
          <Fact label={t("project.source")}>
            <RepoLink fullName={project.source.fullName} />
          </Fact>
          <Fact label={t("project.distribution")}>
            {project.distribution ? (
              <RepoLink fullName={project.distribution.fullName} />
            ) : (
              <span className="text-fg-muted">{t("project.distribution.building")}</span>
            )}
          </Fact>
          <Fact label={t("project.branches")}>
            <span className="font-mono text-[13px]">{project.branches.join(", ")}</span>
          </Fact>
          <Fact label={t("project.sourceStrategy")}>{t(`project.sourceStrategy.${project.sourceStrategy}`)}</Fact>
          <Fact label={t("project.publishMode")}>{t(`project.publishMode.${project.publishMode}`)}</Fact>
          <Fact label={t("project.grace")}>
            {project.graceMinutes} {t("project.grace.unit")}
          </Fact>
          <Fact label={t("project.gradingMode")}>{t(`project.gradingMode.${project.gradingMode}`)}</Fact>
          <Fact label={t("project.scale")}>
            {project.gradingMode === "auto" ? t(`project.scale.${project.gradingScale.kind}`) : "—"}
          </Fact>
        </dl>
      </Card>
    </section>
  );
}
