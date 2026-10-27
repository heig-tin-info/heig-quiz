import type { ComponentProps, InputHTMLAttributes, ReactNode } from "react";

import {
  PROJECT_DURATION_DAYS,
  PROJECT_GRACE_MAX_MINUTES,
  type DeadlineStrategy,
  type ProjectGradingMode,
  type PublishMode,
  type SourceStrategy,
} from "@quiz/contracts";

import { useT } from "../i18n";
import { Field, FieldError, fieldErrorProps, Segmented, SettingRow, TextInput } from "../ui";
import { FIELD_ID } from "./newProject";
import type { DeadlineKind } from "./draftPatch";

/*
 * The rows of a project's settings, shared by the creation form
 * (`ProjectAdvanced`, `NewProjectPage`), a draft's form (`ProjectDraftForm`,
 * `ProjectDraftPublication`) and a published project's Settings
 * (`ProjectSettings`): each is a value, whether it is held, and what a change
 * does. Whether the server lets the field change (`editable`) is the
 * caller's to say, through `disabled`.
 */
interface RowProps<V> {
  value: V;
  disabled?: boolean;
  onChange: (value: V) => void;
}

export function PublishModeRow({ value, disabled, onChange, desc }: RowProps<PublishMode> & { desc?: ReactNode }) {
  const t = useT();
  return (
    <SettingRow title={t("project.publishMode")} desc={desc}>
      <Segmented
        name="publishMode"
        label={t("project.publishMode")}
        value={value}
        disabled={disabled}
        onChange={onChange}
        options={[
          { value: "manual", label: t("project.publishMode.manual") },
          { value: "scheduled", label: t("project.publishMode.scheduled") },
        ]}
      />
    </SettingRow>
  );
}

export function DeadlineKindRow({ value, disabled, onChange }: RowProps<DeadlineKind>) {
  const t = useT();
  return (
    <SettingRow title={t("project.deadlineKind")}>
      <Segmented
        name="deadlineKind"
        label={t("project.deadlineKind")}
        value={value}
        disabled={disabled}
        onChange={onChange}
        options={[
          { value: "date", label: t("project.deadlineKind.date") },
          { value: "duration", label: t("project.deadlineKind.duration") },
        ]}
      />
    </SettingRow>
  );
}

export function SourceStrategyRow({ value, disabled, onChange }: RowProps<SourceStrategy>) {
  const t = useT();
  return (
    <SettingRow title={t("project.sourceStrategy")} desc={t(`project.sourceStrategy.desc.${value}`)}>
      <Segmented
        name="sourceStrategy"
        label={t("project.sourceStrategy")}
        value={value}
        disabled={disabled}
        onChange={onChange}
        options={[
          { value: "squash", label: t("project.sourceStrategy.squash") },
          { value: "whole", label: t("project.sourceStrategy.whole") },
        ]}
      />
    </SettingRow>
  );
}

/** What happens at the deadline. */
export function DeadlineStrategyRow({ value, disabled, onChange }: RowProps<DeadlineStrategy>) {
  const t = useT();
  return (
    <SettingRow title={t("project.deadlineStrategy")} desc={t(`project.deadlineStrategy.desc.${value}`)}>
      <Segmented
        name="deadlineStrategy"
        label={t("project.deadlineStrategy")}
        value={value}
        disabled={disabled}
        onChange={onChange}
        options={[
          { value: "lock", label: t("project.deadlineStrategy.lock") },
          { value: "commit", label: t("project.deadlineStrategy.commit") },
        ]}
      />
    </SettingRow>
  );
}

/**
 * The grading mode, among the `modes` offered: `criteria` only where the
 * project exists already (a draft, ADR-106 §1), since choosing it reads the
 * source's `criteria.yml` — and then each mode says what it does.
 */
export function GradingModeRow<M extends ProjectGradingMode>({
  value,
  disabled,
  onChange,
  modes,
}: RowProps<M> & { modes: readonly M[] }) {
  const t = useT();
  const options = modes.map((mode) => ({ value: mode, label: t(`project.gradingMode.${mode}`) }));
  return (
    <SettingRow title={t("project.gradingMode")} desc={modes.includes("criteria" as M) ? t(`project.gradingMode.desc.${value}`) : undefined}>
      <Segmented name="gradingMode" label={t("project.gradingMode")} value={value} disabled={disabled} onChange={onChange} options={options} />
    </SettingRow>
  );
}

/**
 * The grace, in minutes after the deadline: the row's title names the input,
 * its unit stands after it, a refusal under the row. The input's own props
 * (value, handlers, `disabled`) are the caller's.
 */
export function GraceMinutesRow({
  message,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { message: string | undefined }) {
  const t = useT();
  const id = FIELD_ID.grace;
  return (
    <div>
      <SettingRow title={t("project.grace")} desc={t("project.grace.desc")}>
        <TextInput
          id={id}
          type="number"
          aria-label={t("project.grace")}
          min={0}
          max={PROJECT_GRACE_MAX_MINUTES}
          size="sm"
          className="w-20 text-right tabular-nums"
          {...input}
          {...fieldErrorProps(id, message)}
        />
        <span className="text-[13px] text-fg-muted">{t("project.grace.unit")}</span>
      </SettingRow>
      {message ? (
        <div className="pb-3">
          <FieldError id={id}>{message}</FieldError>
        </div>
      ) : null}
    </div>
  );
}

/** A manual publication's deadline counted in days: one field, one width, on the creation form and on a draft. */
export function DurationDaysField({
  message,
  ...input
}: Omit<ComponentProps<typeof Field>, "label" | "id" | "type" | "min" | "max" | "width" | "className"> & {
  message: string | undefined;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1">
      <Field
        id={FIELD_ID.duration}
        label={t("project.duration")}
        type="number"
        min={PROJECT_DURATION_DAYS.min}
        max={PROJECT_DURATION_DAYS.max}
        width="w-32"
        className="text-right tabular-nums"
        {...input}
        {...fieldErrorProps(FIELD_ID.duration, message)}
      />
      <FieldError id={FIELD_ID.duration}>{message}</FieldError>
    </div>
  );
}
