import { useState } from "react";

import type { ProjectDetail } from "@quiz/contracts";

import { refusalCodeOf, refusedWith } from "../api";
import { DateField } from "../evaluation/TimingStep";
import { useT, type TFunction } from "../i18n";
import { Card, FieldError, fieldErrorProps, useNumberDraft } from "../ui";
import { applyChange, draftPatch, draftView, validDays, type DraftChange } from "./draftPatch";
import { FIELD_ID, foreignZone } from "./newProject";
import type { WriteProject } from "./projectPage";
import { DeadlineKindRow, DurationDaysField, PublishModeRow } from "./ProjectSettingRows";

type Place = "start" | "deadline";

/** A refusal said under the field it concerns: where, and the words. */
export interface PlacedRefusal {
  place: Place;
  message: string;
}

/**
 * Where a refusal of the publication block is said, or null for one the page
 * says: `start_past` under the start, `deadline_past` and a deadline that
 * does not come after the start under the deadline. A patch of the block
 * earns them, and so do Schedule and Publish in the header (ADR-127).
 */
export function publicationRefusal(error: unknown, t: TFunction): PlacedRefusal | null {
  const code = refusalCodeOf(error);
  if (code === "start_past") return { place: "start", message: t("project.refusal.startPast") };
  if (code === "deadline_past") return { place: "deadline", message: t("project.refusal.deadlinePast") };
  // The one 400 this block can earn: a deadline that does not come after the start.
  if (refusedWith(error, "validation")) return { place: "deadline", message: t("project.missing.deadlineOrder") };
  return null;
}

/** The days of a duration, written when the teacher leaves the field. */
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
      <DurationDaysField size="sm" disabled={disabled} message={message} {...input} />
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
 * concerns, and the dates typed stay on screen — except a refused switch of
 * the mode, which puts the screen back to what the server stores. The block
 * is keyed by its caller on the stored values, so a write from elsewhere
 * replaces them.
 *
 * The start choice (now / a date, ADR-127) says what the header's one button
 * will do; a scheduled project keeps its form, the choice held on "a date"
 * (Publish now is the header's way back to now). `refused` is what the
 * header's Schedule or Publish earned, said under its field until the block
 * says something else.
 */
export function ProjectDraftPublication({
  project,
  pending,
  write,
  refused = null,
}: {
  project: ProjectDetail;
  pending: boolean;
  write: WriteProject;
  refused?: PlacedRefusal | null;
}) {
  const t = useT();
  const [view, setView] = useState(() => draftView(project));
  const [said, setSaid] = useState<PlacedRefusal | null>(null);
  /** What the block said itself, else the header's refusal (cleared by the page on the next successful patch). */
  const shown = said ?? refused;
  const isScheduled = project.state === "scheduled";
  const can = (field: "publishMode" | "startAt" | "deadlineAt" | "durationMinutes") => project.editable.includes(field);
  const held = pending || project.archivedAt !== null;
  const zone = foreignZone();
  const scheduled = view.publishMode === "scheduled";

  /** Under the field a refusal is about; false for the others, which the page says. */
  const sayRefusal = (error: unknown): boolean => {
    const placed = publicationRefusal(error, t);
    if (placed) setSaid(placed);
    return placed !== null;
  };

  const change = (c: DraftChange) => {
    setSaid(null);
    // Back to the mode the server stores: nothing to write, and what was typed meanwhile is dropped.
    if (c.type === "mode" && c.mode === project.publishMode) {
      setView(draftView(project));
      return;
    }
    const body = draftPatch(view, c);
    setView(applyChange(view, c));
    if (!body) return;
    write(body, (error) => {
      // A refused mode must not stay on screen while the row says otherwise.
      if (c.type === "mode") setView(draftView(project));
      return sayRefusal(error);
    });
  };
  const at = (place: Place) => (shown?.place === place ? shown.message : undefined);

  return (
    <Card className="divide-y divide-line px-4">
      <PublishModeRow
        value={view.publishMode}
        desc={isScheduled ? undefined : t(view.publishMode === "scheduled" ? "project.startChoice.desc.date" : "project.startChoice.desc.now")}
        disabled={held || !can("publishMode")}
        onChange={(mode) => change({ type: "mode", mode })}
      />

      {scheduled ? null : (
        <DeadlineKindRow
          value={view.kind}
          disabled={held || !can("durationMinutes")}
          onChange={(kind) => change({ type: "kind", kind })}
        />
      )}

      <div className="space-y-2 py-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start">
          {scheduled ? (
            <div className="flex flex-col gap-1">
              <DateField
                key="start"
                id={FIELD_ID.start}
                label={t("project.start")}
                disabled={held || !can("startAt")}
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
              disabled={held || !can("durationMinutes")}
              message={view.days !== null && !validDays(view.days) ? t("project.missing.duration") : undefined}
              onCommit={(days) => change({ type: "days", days })}
            />
          ) : (
            <div className="flex flex-col gap-1">
              <DateField
                key={scheduled ? "scheduled-deadline" : "manual-deadline"}
                id={FIELD_ID.deadline}
                label={t("project.deadline")}
                endOfWeek
                disabled={held || !can("deadlineAt")}
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
