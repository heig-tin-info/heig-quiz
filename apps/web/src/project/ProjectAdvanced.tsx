import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import type { ProjectSourceDetail } from "@quiz/contracts";

import { useT } from "../i18n";
import { Alert, Card, Checkbox, cx, inputClass, inputSize, Segmented, Select, SettingRow, Switch, ToggleChip } from "../ui";
import { FIELD_ID, FieldMessage, invalidProps } from "./fields";
import {
  chosenBranches,
  chosenProtected,
  gradingUnprotected,
  type ProjectDraft,
  type ProjectField,
} from "./newProject";

/** A setting whose control is a list, laid under its title rather than beside it. */
function StackedRow({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2.5 py-3">
      <div>
        <p className="text-sm font-medium text-fg">{title}</p>
        {desc ? <p className="mt-0.5 text-[13px] text-fg-muted">{desc}</p> : null}
      </div>
      {children}
    </div>
  );
}

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
  field: "grace" | "groupMaxSize";
  title: string;
  desc: string;
  unit: string;
  min?: number;
  max: number;
  value: string;
  message: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <SettingRow title={title} desc={desc}>
        <input
          id={FIELD_ID[field]}
          type="number"
          aria-label={title}
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cx(inputClass, inputSize.sm, "w-20 text-right tabular-nums")}
          {...invalidProps(field, message)}
        />
        <span className="text-[13px] text-fg-muted">{unit}</span>
      </SettingRow>
      {message ? (
        <div className="pb-3">
          <FieldMessage field={field}>{message}</FieldMessage>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Advanced options" of the new project (F-PROJ-01, docs/spec/08 §8.2):
 * every setting a novice never needs to read, each with its default and one
 * line on what the current choice does. The branches and the protected
 * files need the source's detail; before a source is picked they say so.
 *
 * The publication: by hand (the deadline a date, or a duration counted from
 * the publication) or at a start. The form never holds a start and a
 * duration at once: the duration is offered for a manual publication only,
 * and the start for a scheduled one only, as `ProjectCreate` requires.
 */
export function ProjectAdvanced({
  draft,
  detail,
  update,
  message,
}: {
  draft: ProjectDraft;
  detail: ProjectSourceDetail | undefined;
  update: (patch: Partial<ProjectDraft>) => void;
  message: (field: ProjectField) => string | undefined;
}) {
  const t = useT();
  const branches = detail ? chosenBranches(draft, detail) : [];
  const protectedFiles = detail ? chosenProtected(draft, detail) : [];
  // The suggestions the source holds, then any file added by hand.
  const listed = detail ? [...new Set([...detail.suggestedProtected, ...protectedFiles])] : [];
  const addable = detail ? detail.tree.filter((e) => e.type === "blob" && !listed.includes(e.path)) : [];

  const toggleBranch = (branch: string) => {
    if (!branches.includes(branch)) update({ branches: [...branches, branch] });
    // The last one stays: a project hands out at least one branch.
    else if (branches.length > 1) update({ branches: branches.filter((b) => b !== branch) });
  };
  const toggleProtected = (path: string, on: boolean) =>
    update({ protectedFiles: on ? [...protectedFiles, path] : protectedFiles.filter((p) => p !== path) });

  return (
    <Card className="divide-y divide-line px-4">
      <StackedRow
        title={t("project.branches")}
        desc={
          detail ? t("project.branches.desc", { branch: branches[0] ?? detail.defaultBranch }) : t("project.needSource")
        }
      >
        {detail ? (
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
        ) : null}
      </StackedRow>

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

      <SettingRow title={t("project.publishMode")} desc={t(`project.publishMode.desc.${draft.publishMode}`)}>
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
        <SettingRow title={t("project.deadlineKind")} desc={t(`project.deadlineKind.desc.${draft.deadlineKind}`)}>
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

      <SettingRow title={t("project.gradingMode")} desc={t(`project.gradingMode.desc.${draft.gradingMode}`)}>
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
        <SettingRow title={t("project.scale")} desc={t(`project.scale.desc.${draft.scaleKind}`)}>
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

      <StackedRow
        title={t("project.protected")}
        desc={detail ? t("project.protected.desc") : t("project.needSource")}
      >
        {detail ? (
          <div className="space-y-3">
            {listed.length > 0 ? (
              <div className="flex flex-col gap-2">
                {listed.map((path) => (
                  <Checkbox
                    key={path}
                    label={<span className="font-mono text-[13px]">{path}</span>}
                    checked={protectedFiles.includes(path)}
                    onChange={(e) => toggleProtected(path, e.target.checked)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-fg-faint">{t("project.protected.none")}</p>
            )}
            {gradingUnprotected(draft, detail) ? (
              <Alert tone="warning" icon={AlertTriangle} title={t("project.protected.gradingWarning")} />
            ) : null}
            {addable.length > 0 ? (
              <Select
                aria-label={t("project.protected.add")}
                size="sm"
                width="w-full sm:w-80"
                value=""
                onChange={(e) => {
                  if (e.target.value) toggleProtected(e.target.value, true);
                }}
              >
                <option value="">{t("project.protected.add")}</option>
                {addable.map((e) => (
                  <option key={e.path} value={e.path}>
                    {e.path}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>
        ) : null}
      </StackedRow>

      <SettingRow title={t("project.groups")} desc={t(`project.groups.desc.${draft.groupMode ? "on" : "off"}`)}>
        <Switch checked={draft.groupMode} label={t("project.groups")} onChange={(groupMode) => update({ groupMode })} />
      </SettingRow>
      {draft.groupMode ? (
        <NumberRow
          field="groupMaxSize"
          title={t("project.groupMaxSize")}
          desc={t("project.groupMaxSize.desc")}
          unit={t("project.groupMaxSize.unit")}
          min={1}
          max={50}
          value={draft.groupMaxSize}
          message={message("groupMaxSize")}
          onChange={(groupMaxSize) => update({ groupMaxSize })}
        />
      ) : null}
    </Card>
  );
}
