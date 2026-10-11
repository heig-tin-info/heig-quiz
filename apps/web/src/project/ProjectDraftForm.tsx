import type { UseMutationResult } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, FolderGit2 } from "lucide-react";
import { useState } from "react";

import type { ProjectDetail, ProjectPatch, ProjectSummary } from "@quiz/contracts";

import { useT } from "../i18n";
import { useToast } from "../notify";
import type { Navigate } from "../router";
import { Alert, Badge, Card, Disclosure, FieldError, fieldErrorProps, Segmented, SectionHeading, SettingRow, TextInput } from "../ui";
import { advancedCount } from "./draftPatch";
import { FIELD_ID } from "./newProject";
import { Facts } from "./ProjectOverview";
import { ProjectDraftPublication, publicationKey } from "./ProjectDraftPublication";
import { ProjectGroupSet } from "./ProjectGroupSet";
import { ProjectRail } from "./ProjectRail";
import { DeadlineStrategyRow, ProtectedFilesRow, useProtectedSuggestions } from "./ProjectSettings";
import { WorkModeSetting } from "./ProjectWorkspace";
import { refusalMessage } from "./projectPage";
import { RepoLink } from "./parts";
import { useNumberDraft } from "./useNumberDraft";

const GRACE_MAX = 1440;

/** The grace, in minutes: written when the teacher leaves the field or presses Enter; 0 is a grace of none. */
function GraceRow({
  project,
  disabled,
  onWrite,
}: {
  project: ProjectDetail;
  disabled: boolean;
  onWrite: (graceMinutes: number) => void;
}) {
  const t = useT();
  const [invalid, setInvalid] = useState(false);
  const input = useNumberDraft(project.graceMinutes, (n) => {
    const ok = n !== null && Number.isInteger(n) && n >= 0 && n <= GRACE_MAX;
    setInvalid(!ok);
    if (ok) onWrite(n);
  });
  const message = invalid ? t("project.missing.grace") : undefined;
  return (
    <div>
      <SettingRow title={t("project.grace")} desc={t("project.grace.desc")}>
        <TextInput
          id={FIELD_ID.grace}
          type="number"
          aria-label={t("project.grace")}
          min={0}
          max={GRACE_MAX}
          size="sm"
          className="w-20 text-right tabular-nums"
          disabled={disabled}
          {...input}
          {...fieldErrorProps(FIELD_ID.grace, message)}
        />
        <span className="text-[13px] text-fg-muted">{t("project.grace.unit")}</span>
      </SettingRow>
      {message ? (
        <div className="pb-3">
          <FieldError id={FIELD_ID.grace}>{message}</FieldError>
        </div>
      ) : null}
    </div>
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
 * `PATCH`; the server's `editable` names what may change, and everything is
 * held while a write is under way or the project is archived.
 */
export function ProjectDraftForm({
  project,
  patch,
  navigate,
}: {
  project: ProjectDetail;
  patch: UseMutationResult<ProjectSummary, Error, ProjectPatch>;
  navigate: Navigate;
}) {
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const disabled = patch.isPending || project.archivedAt !== null;
  const suggested = useProtectedSuggestions(project, open);
  const changed = advancedCount(project);
  /** A write outside the publication block: its refusal, if any, is a toast. */
  const write = (body: ProjectPatch) => patch.mutate(body, { onError: (error) => toast(refusalMessage(error, t), "error") });
  const can = (field: "gradingMode" | "gradingScale" | "graceMinutes") => project.editable.includes(field);

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
                  <RepoLink key="d" fullName={project.distribution.fullName} />
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
        <ProjectDraftPublication key={publicationKey(project)} project={project} patch={patch} />
      </section>

      <ProjectGroupSet project={project} patch={patch} navigate={navigate} />

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
          project={project}
          disabled={disabled || !can("graceMinutes")}
          onWrite={(graceMinutes) => write({ graceMinutes })}
        />
        <DeadlineStrategyRow project={project} disabled={disabled} onChange={(deadlineStrategy) => write({ deadlineStrategy })} />
        <SettingRow title={t("project.gradingMode")}>
          <Segmented
            name="gradingMode"
            label={t("project.gradingMode")}
            value={project.gradingMode}
            disabled={disabled || !can("gradingMode")}
            onChange={(gradingMode) => write({ gradingMode })}
            options={[
              { value: "auto", label: t("project.gradingMode.auto") },
              { value: "none", label: t("project.gradingMode.none") },
            ]}
          />
        </SettingRow>
        {project.gradingMode === "auto" ? (
          <SettingRow title={t("project.scale")} desc={t("project.scale.desc")}>
            <Segmented
              name="scale"
              label={t("project.scale")}
              value={project.gradingScale.kind}
              disabled={disabled || !can("gradingScale")}
              onChange={(kind) => write({ gradingScale: { ...project.gradingScale, kind } })}
              options={[
                { value: "linear", label: t("project.scale.linear") },
                { value: "score_is_grade", label: t("project.scale.score_is_grade") },
              ]}
            />
          </SettingRow>
        ) : null}
        <ProtectedFilesRow
          project={project}
          disabled={disabled}
          suggested={suggested}
          onChange={(protectedFiles) => write({ protectedFiles })}
        />
        <WorkModeSetting projectId={project.id} archived={project.archivedAt !== null} />
      </Disclosure>

      {project.gradingMode === "auto" ? <ProjectRail project={project} /> : null}
    </div>
  );
}
