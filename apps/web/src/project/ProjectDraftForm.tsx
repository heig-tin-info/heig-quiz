import type { UseMutationResult } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, FolderGit2, UsersRound } from "lucide-react";
import { useState } from "react";

import {
  ProjectPatch,
  type ProjectDetail,
  type ProjectSummary,
} from "@quiz/contracts";

import { PROJECT_GRADING_MODES, projectGraded } from "@quiz/domain";

import { useT } from "../i18n";
import type { Navigate } from "../router";
import { Alert, Badge, Card, Disclosure, SectionHeading, SettingRow, Switch, useNumberDraft } from "../ui";
import { Facts } from "./ProjectOverview";
import { ProjectDraftPublication, publicationKey } from "./ProjectDraftPublication";
import { GroupSetBody } from "./ProjectGroupSet";
import { CriteriaErrors, CriteriaRows, useGradingModeWrite } from "./ProjectCriteria";
import { ProjectRail } from "./ProjectRail";
import { DeadlineStrategyRow, GraceMinutesRow, GradingModeRow, ScaleRow } from "./ProjectSettingRows";
import { ProtectedFilesRow, useHandoutTree } from "./ProjectSettings";
import { WorkModeSetting, useWorkspace } from "./ProjectWorkspace";
import { advancedCount, type WriteProject } from "./projectPage";
import { RepoLink } from "./parts";
import { DistributionRepo } from "./DistributionRepo";

/** The grace, in minutes: written when the teacher leaves the field; 0 is a grace of none. */
function GraceRow({ value, disabled, onWrite }: { value: number; disabled: boolean; onWrite: (minutes: number) => void }) {
  const t = useT();
  const input = useNumberDraft(value, (n) => {
    if (ProjectPatch.shape.graceMinutes.safeParse(n).success && n !== null) onWrite(n);
  });
  // Said while what is typed is not a grace, gone as soon as it is one (or empty).
  const typed = input.value.trim();
  const invalid = typed !== "" && !ProjectPatch.shape.graceMinutes.safeParse(Number(typed)).success;
  return <GraceMinutesRow disabled={disabled} message={invalid ? t("project.missing.grace") : undefined} {...input} />;
}

/**
 * A draft's group mode (F-PROJ-06): written at once, off clears the set. Held,
 * with the reason, while the project works in the online workspace — the
 * server would refuse `work_mode_group`; a platform without the portal
 * answers the workspace read with a 404, and the switch is then free.
 */
function GroupModeSwitch({ project, disabled, write }: { project: ProjectDetail; disabled: boolean; write: WriteProject }) {
  const t = useT();
  const workspace = useWorkspace(project.id);
  const online = workspace.data !== undefined && workspace.data.mode !== "free";
  return (
    <SettingRow title={t("project.groups")} desc={online ? t("project.draft.groups.online") : t("project.groups.desc")}>
      <Switch
        checked={project.groupMode}
        label={t("project.groups")}
        disabled={disabled || online || !project.editable.includes("groupMode")}
        onChange={(groupMode) => write({ groupMode })}
      />
    </SettingRow>
  );
}

/**
 * A DRAFT's page (F-PROJ-01, F-PROJ-03, docs/spec/08 §8.2): before publication
 * one configures, after it one watches. A form in the order a teacher
 * decides: the work handed out (facts, fixed at creation), the publication
 * and the deadline (the three things a novice reads), the groups, then
 * everything else folded under "Advanced options"; the lifecycle rail stays
 * under them, so the checkpoints are set before Publish (F-PROJ-01). No
 * tiles, no table of repositories and no live workspace: nobody can accept a
 * draft, not even a staff seat (ADR-077 §1).
 *
 * Every field is written as soon as it is set, through the page's one
 * `PATCH` (`write`); the server's `editable` names what may change, and
 * everything is held while a write is under way or the project is archived.
 */
export function ProjectDraftForm({
  project,
  patch,
  write,
  navigate,
}: {
  project: ProjectDetail;
  patch: UseMutationResult<ProjectSummary, Error, ProjectPatch>;
  write: WriteProject;
  navigate: Navigate;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const disabled = patch.isPending || project.archivedAt !== null;
  const source = useHandoutTree(project, open);
  const changed = advancedCount(project);
  const grading = useGradingModeWrite(write);
  const can = (field: "gradingMode" | "gradingScale" | "graceMinutes" | "deadlineStrategy") => project.editable.includes(field);

  return (
    <div className="max-w-3xl space-y-8" data-testid="project-draft-form">
      <section aria-labelledby="draft-work" className="space-y-3">
        <SectionHeading icon={FolderGit2} title={<span id="draft-work">{t("project.draft.work")}</span>} description={t("project.draft.work.desc")} />
        <Card className="px-4 py-4">
          <Facts
            rows={[
              [t("project.source"), <RepoLink key="s" fullName={project.source.fullName} />],
              [
                t("project.distribution"),
                project.distribution ? (
                  <DistributionRepo key="d" projectId={project.id} fullName={project.distribution.fullName} />
                ) : (
                  <span className="text-fg-muted">{t("project.distribution.building")}</span>
                ),
              ],
              [t("project.branches"), <span key="b" className="font-mono text-xs">{project.branches.join(", ")}</span>],
              [t("project.sourceStrategy"), t(`project.sourceStrategy.${project.sourceStrategy}`)],
              // There is no Source tile on a draft: whether the source moved on is said here, and Sync sits in the header.
              [
                t("project.sync"),
                project.sync.ahead
                  ? project.sync.ahead.commits === null
                    ? t("project.source.aheadUnknown")
                    : t("project.source.ahead", { n: project.sync.ahead.commits })
                  : t("project.source.inSync"),
              ],
            ]}
          />
        </Card>
        {project.distribution === null ? (
          <Alert tone="warning" icon={AlertTriangle} title={t("project.draft.distributionMissing.title")}>
            {t("project.draft.distributionMissing.body")}
          </Alert>
        ) : null}
      </section>

      <section aria-labelledby="draft-publication" className="space-y-3">
        <SectionHeading icon={CalendarClock} title={<span id="draft-publication">{t("project.draft.publication")}</span>} />
        <ProjectDraftPublication key={publicationKey(project)} project={project} pending={patch.isPending} write={write} />
      </section>

      <section aria-labelledby="draft-groups" className="space-y-3">
        <SectionHeading icon={UsersRound} title={<span id="draft-groups">{t("project.groups")}</span>} />
        <Card className="divide-y divide-line px-4">
          <GroupModeSwitch project={project} disabled={disabled} write={write} />
          {project.groupMode ? (
            <div className="space-y-3 py-4">
              <GroupSetBody project={project} patch={patch} navigate={navigate} />
            </div>
          ) : null}
        </Card>
      </section>

      <Disclosure
        title={t("eval.advanced")}
        desc={t("project.draft.advanced.desc")}
        open={open}
        onOpenChange={setOpen}
        aside={
          changed > 0 ? (
            <Badge tone="zinc">
              <span aria-hidden>{changed}</span>
              <span className="sr-only">{changed === 1 ? t("project.draft.advanced.count.one") : t("project.draft.advanced.count", { n: changed })}</span>
            </Badge>
          ) : null
        }
      >
        <GraceRow
          key={project.graceMinutes}
          value={project.graceMinutes}
          disabled={disabled || !can("graceMinutes")}
          onWrite={(graceMinutes) => write({ graceMinutes })}
        />
        <DeadlineStrategyRow
          value={project.deadlineStrategy}
          disabled={disabled || !can("deadlineStrategy")}
          onChange={(deadlineStrategy) => write({ deadlineStrategy })}
        />
        <GradingModeRow
          modes={PROJECT_GRADING_MODES}
          value={project.gradingMode}
          disabled={disabled || !can("gradingMode")}
          onChange={grading.writeMode}
        />
        <CriteriaErrors errors={grading.errors} />
        {project.gradingMode === "criteria" ? <CriteriaRows project={project} disabled={disabled} write={write} /> : null}
        {projectGraded(project.gradingMode) ? (
          <ScaleRow
            value={project.gradingScale.kind}
            disabled={disabled || !can("gradingScale")}
            onChange={(kind) => write({ gradingScale: { ...project.gradingScale, kind } })}
          />
        ) : null}
        <ProtectedFilesRow
          project={project}
          disabled={disabled}
          source={source}
          onChange={(protectedFiles) => write({ protectedFiles })}
        />
        <WorkModeSetting projectId={project.id} archived={project.archivedAt !== null} />
      </Disclosure>

      {projectGraded(project.gradingMode) ? <ProjectRail project={project} /> : null}
    </div>
  );
}
