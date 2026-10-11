/*
 * The publication and deadline block of a draft (F-PROJ-03, docs/spec/08
 * §8.2), pure: what the block holds while the teacher fills it, and the one
 * `PATCH` a change amounts to — or none while it is incomplete. A scheduled
 * publication needs its start AND its deadline, so the pair is committed
 * together; a manual one counts its deadline as a date or as a number of
 * days from the publication, and moving from one kind to the other writes
 * nothing until the new value is given. `ProjectDraftPublication.tsx` draws it.
 */
import { ProjectPatch, type PublishMode, type ProjectDetail } from "@quiz/contracts";

/** A manual publication's deadline: a date, or a number of days counted from the publication. */
export type DeadlineKind = "date" | "duration";

/** The block's values: instants (ISO) or null while a field is empty. */
export interface DraftView {
  publishMode: PublishMode;
  /** Manual only: how the deadline is given. */
  kind: DeadlineKind;
  startAt: string | null;
  deadlineAt: string | null;
  /** Whole days, manual and by duration only. */
  days: number | null;
}

export type DraftChange =
  | { type: "mode"; mode: PublishMode }
  | { type: "kind"; kind: DeadlineKind }
  | { type: "start"; at: string | null }
  | { type: "deadline"; at: string | null }
  | { type: "days"; days: number | null };

const MINUTES_PER_DAY = 1440;

/** The block as the stored draft has it. A manual draft's start and, by duration, its deadline are provisional: not shown. */
export function draftView(
  p: Pick<ProjectDetail, "publishMode" | "startAt" | "deadlineAt" | "durationMinutes">,
): DraftView {
  if (p.publishMode === "scheduled") {
    return { publishMode: "scheduled", kind: "date", startAt: p.startAt, deadlineAt: p.deadlineAt, days: null };
  }
  const byDuration = p.durationMinutes !== null;
  return {
    publishMode: "manual",
    kind: byDuration ? "duration" : "date",
    startAt: null,
    deadlineAt: byDuration ? null : p.deadlineAt,
    days: byDuration ? Math.round(p.durationMinutes! / MINUTES_PER_DAY) : null,
  };
}

/** The block once `change` is made. A switch of mode or kind keeps what still means something in the new one. */
export function applyChange(view: DraftView, change: DraftChange): DraftView {
  switch (change.type) {
    case "mode":
      if (change.mode === view.publishMode) return view;
      // The manual draft's date stays as the deadline on offer; a duration is not a date.
      return change.mode === "scheduled"
        ? { ...view, publishMode: "scheduled", kind: "date", startAt: null, days: null, deadlineAt: view.kind === "date" ? view.deadlineAt : null }
        : { ...view, publishMode: "manual", kind: "date", startAt: null };
    case "kind":
      // The date and the duration exclude each other: the other one starts empty.
      return change.kind === view.kind ? view : { ...view, kind: change.kind, deadlineAt: null, days: null };
    case "start":
      return { ...view, startAt: change.at };
    case "deadline":
      return { ...view, deadlineAt: change.at };
    case "days":
      return { ...view, days: change.days };
  }
}

/** Whole days the schema takes as a duration (`ProjectPatch`'s own bounds), or not. */
export const validDays = (days: number | null): days is number =>
  days !== null && Number.isInteger(days) && ProjectPatch.shape.durationMinutes.safeParse(days * MINUTES_PER_DAY).success;

/**
 * The patch `change` amounts to on `view`, or null while it is incomplete
 * (or writes nothing by itself: a kind switch).
 *
 * - scheduled: the pair, whole — `publishMode`, `startAt`, `deadlineAt` and
 *   no duration — once both dates are filled;
 * - back to manual: `publishMode` alone, the server resets the start and
 *   keeps the deadline;
 * - manual by date: the deadline, and no duration (a duration given before
 *   becomes a date set by hand);
 * - manual by duration: the duration in minutes, the server recomputes the
 *   provisional deadline.
 */
export function draftPatch(view: DraftView, change: DraftChange): ProjectPatch | null {
  if (change.type === "kind") return null;
  const next = applyChange(view, change);
  if (next.publishMode === "scheduled") {
    // A switch to scheduled has no start yet, and `days` is not a scheduled field.
    if (change.type === "days" || change.type === "mode") return null;
    return next.startAt && next.deadlineAt
      ? { publishMode: "scheduled", startAt: next.startAt, deadlineAt: next.deadlineAt, durationMinutes: null }
      : null;
  }
  if (change.type === "mode") return view.publishMode === "manual" ? null : { publishMode: "manual" };
  if (next.kind === "duration") return change.type === "days" && validDays(next.days) ? { durationMinutes: next.days * MINUTES_PER_DAY } : null;
  return change.type === "deadline" && next.deadlineAt ? { deadlineAt: next.deadlineAt, durationMinutes: null } : null;
}
