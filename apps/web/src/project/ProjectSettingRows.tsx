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

/** One choice among a few, as a segmented control: every row here but the grace. */
function ChoiceRow<V extends string>({
  name,
  title,
  desc,
  options,
  ...choice
}: RowProps<V> & { name: string; title: string; desc?: ReactNode; options: readonly { value: V; label: string }[] }) {
  return (
    <SettingRow title={title} desc={desc}>
      <Segmented name={name} label={title} options={options} {...choice} />
    </SettingRow>
  );
}

/**
 * The start choice (ADR-127 §2): now or at a date. The column behind it is
 * `publishMode` — `manual` is now, `scheduled` a date — and the draft's one
 * button follows it: Publish for now, Schedule for a date to come.
 */
export function PublishModeRow(props: RowProps<PublishMode> & { desc?: ReactNode }) {
  const t = useT();
  const options = [
    { value: "manual" as const, label: t("project.startChoice.now") },
    { value: "scheduled" as const, label: t("project.startChoice.date") },
  ];
  return <ChoiceRow {...props} name="publishMode" title={t("project.startChoice")} options={options} />;
}

export function DeadlineKindRow(props: RowProps<DeadlineKind>) {
  const t = useT();
  const options = [
    { value: "date" as const, label: t("project.deadlineKind.date") },
    { value: "duration" as const, label: t("project.deadlineKind.duration") },
  ];
  return <ChoiceRow {...props} name="deadlineKind" title={t("project.deadlineKind")} options={options} />;
}

export function SourceStrategyRow(props: RowProps<SourceStrategy>) {
  const t = useT();
  const options = [
    { value: "squash" as const, label: t("project.sourceStrategy.squash") },
    { value: "whole" as const, label: t("project.sourceStrategy.whole") },
  ];
  const desc = t(`project.sourceStrategy.desc.${props.value}`);
  return <ChoiceRow {...props} name="sourceStrategy" title={t("project.sourceStrategy")} desc={desc} options={options} />;
}

/** What happens at the deadline. */
export function DeadlineStrategyRow(props: RowProps<DeadlineStrategy>) {
  const t = useT();
  const options = [
    { value: "lock" as const, label: t("project.deadlineStrategy.lock") },
    { value: "commit" as const, label: t("project.deadlineStrategy.commit") },
  ];
  const desc = t(`project.deadlineStrategy.desc.${props.value}`);
  return <ChoiceRow {...props} name="deadlineStrategy" title={t("project.deadlineStrategy")} desc={desc} options={options} />;
}

/**
 * The grading mode, among the `modes` offered: `criteria` only where the
 * project exists already (a draft, ADR-106 §1), since choosing it reads the
 * source's `criteria.yml` — and then each mode says what it does.
 */
export function GradingModeRow<M extends ProjectGradingMode>({ modes, ...props }: RowProps<M> & { modes: readonly M[] }) {
  const t = useT();
  const options = modes.map((mode) => ({ value: mode, label: t(`project.gradingMode.${mode}`) }));
  const desc = modes.includes("criteria" as M) ? t(`project.gradingMode.desc.${props.value}`) : undefined;
  return <ChoiceRow {...props} name="gradingMode" title={t("project.gradingMode")} desc={desc} options={options} />;
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
