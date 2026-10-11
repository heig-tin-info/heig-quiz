import type { UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";

import type { ProjectDetail, ProjectPatch, ProjectSummary } from "@quiz/contracts";

import { refusalCodeOf, refusedWith } from "../api";
import { DateField } from "../evaluation/TimingStep";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Card, Field, FieldError, fieldErrorProps, Segmented, SettingRow } from "../ui";
import {
  applyChange,
  draftPatch,
  draftView,
  MAX_DAYS,
  MIN_DAYS,
  validDays,
  type DeadlineKind,
  type DraftChange,
} from "./draftPatch";
import { FIELD_ID, foreignZone } from "./newProject";
import { refusalMessage } from "./projectPage";
import { useNumberDraft } from "./useNumberDraft";

type Place = "start" | "deadline" | "duration";

/** The days of a duration, typed: written when the teacher leaves the field (a number typed digit by digit is a run of wrong values). */
function DaysField({
  days,
  disabled,
  message,
  onCommit,
}: {
  days: number | null;
  disabled: boolean;
  message: string | undefined;
  onCommit: (days: number | null) => void;
}) {
  const t = useT();
  const input = useNumberDraft(days, onCommit);
  return (
    <div className="flex flex-col gap-1">
      <Field
        id={FIELD_ID.duration}
        label={t("project.duration")}
        type="number"
        min={MIN_DAYS}
        max={MAX_DAYS}
        width="w-40"
        size="sm"
        className="text-right tabular-nums"
        disabled={disabled}
        {...input}
        {...fieldErrorProps(FIELD_ID.duration, message)}
      />
      <FieldError id={FIELD_ID.duration}>{message}</FieldError>
      <p className="text-xs text-fg-muted">{t("project.draft.duration.desc")}</p>
    </div>
  );
}

/**
 * The publication and the deadline of a draft (F-PROJ-03, docs/spec/08 §8.2):
 * the three things a novice reads. A manual publication is a button the
 * teacher presses, its deadline a date or a number of days counted from it; a
 * scheduled one has a start and a deadline, written TOGETHER as one patch
 * once both are filled (`draftPatch`). Nothing is written by the switch of a
 * mode or a kind alone; what the server refuses is said under the field it
 * concerns, and the dates typed stay on screen. The block is keyed by its
 * caller on the stored values, so a write from elsewhere replaces them.
 */
export function ProjectDraftPublication({
  project,
  patch,
}: {
  project: ProjectDetail;
  patch: UseMutationResult<ProjectSummary, Error, ProjectPatch>;
}) {
  const t = useT();
  const toast = useToast();
  const [view, setView] = useState(() => draftView(project));
  const [said, setSaid] = useState<{ place: Place; message: string } | null>(null);
  const can = (field: "publishMode" | "startAt" | "deadlineAt" | "durationMinutes") => project.editable.includes(field);
  const disabled = patch.isPending || project.archivedAt !== null;
  const zone = foreignZone();
  const scheduled = view.publishMode === "scheduled";

  /** Under the field a refusal is about, else a toast. */
  const sayRefusal = (error: unknown) => {
    const code = refusalCodeOf(error);
    if (code === "start_past") setSaid({ place: "start", message: t("project.refusal.startPast") });
    else if (code === "deadline_past") setSaid({ place: "deadline", message: t("project.refusal.deadlinePast") });
    // The one 400 this block can earn: a deadline that does not come after the start.
    else if (refusedWith(error, "validation") && scheduled) setSaid({ place: "deadline", message: t("project.missing.deadlineOrder") });
    else toast(refusalMessage(error, t), "error");
  };

  const change = (c: DraftChange) => {
    setSaid(null);
    const body = draftPatch(view, c);
    setView(applyChange(view, c));
    if (body) patch.mutate(body, { onError: sayRefusal });
  };
  const at = (place: Place) => (said?.place === place ? said.message : undefined);

  return (
    <Card className="divide-y divide-line px-4">
      <SettingRow title={t("project.publishMode")} desc={t(`project.draft.publishMode.desc.${view.publishMode}`)}>
        <Segmented
          name="publishMode"
          label={t("project.publishMode")}
          value={view.publishMode}
          disabled={disabled || !can("publishMode")}
          onChange={(mode) => change({ type: "mode", mode })}
          options={[
            { value: "manual", label: t("project.publishMode.manual") },
            { value: "scheduled", label: t("project.publishMode.scheduled") },
          ]}
        />
      </SettingRow>

      {scheduled ? null : (
        <SettingRow title={t("project.deadlineKind")}>
          <Segmented
            name="deadlineKind"
            label={t("project.deadlineKind")}
            value={view.kind}
            disabled={disabled || !can("durationMinutes")}
            onChange={(kind: DeadlineKind) => change({ type: "kind", kind })}
            options={[
              { value: "date", label: t("project.deadlineKind.date") },
              { value: "duration", label: t("project.deadlineKind.duration") },
            ]}
          />
        </SettingRow>
      )}

      <div className="space-y-2 py-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start">
          {scheduled ? (
            <div className="flex flex-col gap-1">
              <DateField
                key="start"
                id={FIELD_ID.start}
                label={t("project.start")}
                disabled={disabled || !can("startAt")}
                value={view.startAt}
                onCommit={(value) => change({ type: "start", at: value })}
                {...fieldErrorProps(FIELD_ID.start, at("start"))}
              />
              <FieldError id={FIELD_ID.start} className="max-w-52">
                {at("start")}
              </FieldError>
            </div>
          ) : null}
          {view.kind === "duration" && !scheduled ? (
            <DaysField
              days={view.days}
              disabled={disabled || !can("durationMinutes")}
              message={
                at("duration") ??
                (view.days !== null && !validDays(view.days) ? t("project.missing.duration") : undefined)
              }
              onCommit={(days) => change({ type: "days", days })}
            />
          ) : (
            <div className="flex flex-col gap-1">
              <DateField
                key={scheduled ? "scheduled-deadline" : "manual-deadline"}
                id={FIELD_ID.deadline}
                label={t("project.deadline")}
                disabled={disabled || !can("deadlineAt")}
                value={view.deadlineAt}
                onCommit={(value) => change({ type: "deadline", at: value })}
                {...fieldErrorProps(FIELD_ID.deadline, at("deadline"))}
              />
              <FieldError id={FIELD_ID.deadline} className="max-w-52">
                {at("deadline")}
              </FieldError>
            </div>
          )}
        </div>
        {zone ? <p className="text-[13px] text-fg-muted">{t("project.zone", { zone })}</p> : null}
      </div>
    </Card>
  );
}

/**
 * The key the block is remounted on: the stored values it shows. A refused
 * write changes none of them, so the dates typed stay.
 */
export const publicationKey = (p: Pick<ProjectDetail, "publishMode" | "startAt" | "deadlineAt" | "durationMinutes">): string =>
  [p.publishMode, p.startAt, p.deadlineAt, p.durationMinutes].join("|");
