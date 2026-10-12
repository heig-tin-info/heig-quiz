import type { ProjectSourceDetail } from "@quiz/contracts";

import { GroupSetPicker } from "../group/GroupSetPicker";
import { useT } from "../i18n";
import { SettingRow, Switch, ToggleChip } from "../ui";
import { chosenBranches, chosenProtected, FIELD_ID, type ProjectDraft, type ProjectField } from "./newProject";
import { ProtectedFiles } from "./ProtectedFiles";
import {
  DeadlineKindRow,
  DeadlineStrategyRow,
  GradingModeRow,
  GraceMinutesRow,
  PublishModeRow,
  ScaleRow,
  SourceStrategyRow,
} from "./ProjectSettingRows";

/** `criteria` is chosen on the draft, which reads its `criteria.yml` (ADR-106 §1). */
const CREATION_MODES = ["auto", "none"] as const;

/**
 * "Advanced options" of the new project (F-PROJ-01, docs/spec/08 §8.2):
 * every setting a novice never needs to read, each at its default. A line
 * of description only where the choice is not self-explanatory. The
 * branches and the protected files appear once a source is read.
 *
 * The publication: by hand (the deadline a date, or a number of days counted
 * from the publication) or at a start. The form never holds a start and a
 * duration at once: the duration is offered for a manual publication only,
 * the start for a scheduled one only, as `ProjectCreate` requires.
 */
export function ProjectAdvanced({
  classroomId,
  draft,
  detail,
  update,
  message,
}: {
  classroomId: string;
  draft: ProjectDraft;
  detail: ProjectSourceDetail | undefined;
  update: (patch: Partial<ProjectDraft>) => void;
  message: (field: ProjectField) => string | undefined;
}) {
  const t = useT();
  const branches = detail ? chosenBranches(draft, detail) : [];

  const toggleBranch = (branch: string) => {
    if (!branches.includes(branch)) update({ branches: [...branches, branch] });
    // The last one stays: a project hands out at least one branch.
    else if (branches.length > 1) update({ branches: branches.filter((b) => b !== branch) });
  };

  // Rows only: the page's `Disclosure` is the card they sit in.
  return (
    <>
      {detail ? (
        <SettingRow stacked title={t("project.branches")} desc={t("project.branches.desc", { branch: branches[0]! })}>
          <div className="flex flex-wrap gap-2">
            {detail.branches.map((b) => (
              <ToggleChip
                key={b}
                label={<span className="font-mono">{b}</span>}
                tone="neutral"
                pressed={branches.includes(b)}
                onToggle={() => toggleBranch(b)}
              />
            ))}
          </div>
        </SettingRow>
      ) : null}

      <SourceStrategyRow value={draft.sourceStrategy} onChange={(sourceStrategy) => update({ sourceStrategy })} />

      <PublishModeRow value={draft.publishMode} onChange={(publishMode) => update({ publishMode })} />

      {draft.publishMode === "manual" ? (
        <DeadlineKindRow value={draft.deadlineKind} onChange={(deadlineKind) => update({ deadlineKind })} />
      ) : null}

      <DeadlineStrategyRow value={draft.deadlineStrategy} onChange={(deadlineStrategy) => update({ deadlineStrategy })} />

      <GraceMinutesRow
        value={draft.graceMinutes}
        message={message("grace")}
        onChange={(e) => update({ graceMinutes: e.target.value })}
      />

      <GradingModeRow modes={CREATION_MODES} value={draft.gradingMode} onChange={(gradingMode) => update({ gradingMode })} />

      {draft.gradingMode === "auto" ? (
        <ScaleRow value={draft.scaleKind} onChange={(scaleKind) => update({ scaleKind })} />
      ) : null}

      {detail && detail.suggestedProtected.length > 0 ? (
        <SettingRow stacked title={t("project.protected")}>
          <ProtectedFiles
            suggested={detail.suggestedProtected}
            value={chosenProtected(draft, detail)}
            onChange={(protectedFiles) => update({ protectedFiles })}
          />
        </SettingRow>
      ) : null}

      {/* Group work (ADR-070 §7): the classroom's group sets, or a new one.
          The set's maximum size replaced the project's (ADR-070 §2). Offered
          in every build since Accept provisions group repositories
          (M3-15b-1); a membership change reaching one is confirmed, then
          applied by the `group.sync` job (M3-15b-2a), and a set's write
          that would delete such a group answers `409 has_repo`. */}
      <SettingRow title={t("project.groups")} desc={t("project.groups.desc")}>
        <Switch checked={draft.groupMode} label={t("project.groups")} onChange={(groupMode) => update({ groupMode })} />
      </SettingRow>
      {draft.groupMode ? (
        <SettingRow stacked title={t("project.groupSet")} desc={t("project.groupSet.desc")}>
          <GroupSetPicker
            id={FIELD_ID.groupSet}
            classroomId={classroomId}
            value={draft.groupSetId}
            onChange={(groupSetId) => update({ groupSetId })}
            message={message("groupSet")}
          />
        </SettingRow>
      ) : null}
    </>
  );
}
