import type { ProjectSourceDetail } from "@quiz/contracts";

import { GroupSetPicker } from "../group/GroupSetPicker";
import { useT } from "../i18n";
import {
  cx,
  FieldError,
  fieldErrorProps,
  inputClass,
  inputSize,
  Segmented,
  SettingRow,
  Switch,
  ToggleChip,
} from "../ui";
import { chosenBranches, chosenProtected, FIELD_ID, type ProjectDraft, type ProjectField } from "./newProject";
import { ProtectedFiles } from "./ProtectedFiles";

/**
 * A setting that is a count: the row's title names the input, its unit
 * stands after it, a refusal under the row.
 */
function NumberRow({
  field,
  title,
  desc,
  unit,
  min = 0,
  max,
  value,
  message,
  onChange,
}: {
  field: "grace";
  title: string;
  desc: string;
  unit: string;
  min?: number;
  max: number;
  value: string;
  message: string | undefined;
  onChange: (value: string) => void;
}) {
  const id = FIELD_ID[field];
  return (
    <div>
      <SettingRow title={title} desc={desc}>
        <input
          id={id}
          type="number"
          aria-label={title}
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cx(inputClass, inputSize.sm, "w-20 text-right tabular-nums")}
          {...fieldErrorProps(id, message)}
        />
        <span className="text-[13px] text-fg-muted">{unit}</span>
      </SettingRow>
      {message ? (
        <div className="pb-3">
          <FieldError id={id}>{message}</FieldError>
        </div>
      ) : null}
    </div>
  );
}

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

      <SettingRow title={t("project.sourceStrategy")} desc={t(`project.sourceStrategy.desc.${draft.sourceStrategy}`)}>
        <Segmented
          name="sourceStrategy"
          label={t("project.sourceStrategy")}
          value={draft.sourceStrategy}
          onChange={(sourceStrategy) => update({ sourceStrategy })}
          options={[
            { value: "squash", label: t("project.sourceStrategy.squash") },
            { value: "whole", label: t("project.sourceStrategy.whole") },
          ]}
        />
      </SettingRow>

      <SettingRow title={t("project.publishMode")}>
        <Segmented
          name="publishMode"
          label={t("project.publishMode")}
          value={draft.publishMode}
          onChange={(publishMode) => update({ publishMode })}
          options={[
            { value: "manual", label: t("project.publishMode.manual") },
            { value: "scheduled", label: t("project.publishMode.scheduled") },
          ]}
        />
      </SettingRow>

      {draft.publishMode === "manual" ? (
        <SettingRow title={t("project.deadlineKind")}>
          <Segmented
            name="deadlineKind"
            label={t("project.deadlineKind")}
            value={draft.deadlineKind}
            onChange={(deadlineKind) => update({ deadlineKind })}
            options={[
              { value: "date", label: t("project.deadlineKind.date") },
              { value: "duration", label: t("project.deadlineKind.duration") },
            ]}
          />
        </SettingRow>
      ) : null}

      <SettingRow title={t("project.deadlineStrategy")} desc={t(`project.deadlineStrategy.desc.${draft.deadlineStrategy}`)}>
        <Segmented
          name="deadlineStrategy"
          label={t("project.deadlineStrategy")}
          value={draft.deadlineStrategy}
          onChange={(deadlineStrategy) => update({ deadlineStrategy })}
          options={[
            { value: "lock", label: t("project.deadlineStrategy.lock") },
            { value: "commit", label: t("project.deadlineStrategy.commit") },
          ]}
        />
      </SettingRow>

      <NumberRow
        field="grace"
        title={t("project.grace")}
        desc={t("project.grace.desc")}
        unit={t("project.grace.unit")}
        max={1440}
        value={draft.graceMinutes}
        message={message("grace")}
        onChange={(graceMinutes) => update({ graceMinutes })}
      />

      <SettingRow title={t("project.gradingMode")}>
        <Segmented
          name="gradingMode"
          label={t("project.gradingMode")}
          value={draft.gradingMode}
          onChange={(gradingMode) => update({ gradingMode })}
          options={[
            { value: "auto", label: t("project.gradingMode.auto") },
            { value: "none", label: t("project.gradingMode.none") },
          ]}
        />
      </SettingRow>

      {draft.gradingMode === "auto" ? (
        <SettingRow title={t("project.scale")} desc={t("project.scale.desc")}>
          <Segmented
            name="scale"
            label={t("project.scale")}
            value={draft.scaleKind}
            onChange={(scaleKind) => update({ scaleKind })}
            options={[
              { value: "linear", label: t("project.scale.linear") },
              { value: "score_is_grade", label: t("project.scale.score_is_grade") },
            ]}
          />
        </SettingRow>
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
