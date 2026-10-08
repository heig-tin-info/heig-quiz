/**
 * Who drives the clock (ADR-086, #555): the one question the timing step
 * asks, mapped onto the stored `timing` and `lobby` with no migration.
 *
 * | Choice                | `timing`   | `lobby`         | Fields                             |
 * |-----------------------|------------|-----------------|------------------------------------|
 * | Scheduled, no limit   | `deadline` | `skip`          | start, end                         |
 * | Scheduled, with limit | `duration` | `skip`          | start, end, minutes                |
 * | Live, no limit        | `manual`   | `manual`*       | date (a hint), safety deadline     |
 * | Live, with limit      | `duration` | `manual`*       | date (a hint), minutes             |
 *
 * (*) `auto`, or `skip` without a limit, from the advanced options. Live
 * with a limit and no waiting room is `duration` + `skip`, which IS
 * Scheduled with a limit: the store cannot tell them apart, so the mode
 * reads it as Scheduled and Live never offers that pair.
 *
 * The mode is never stored: it is read back from the two settings every
 * time ({@link clockChoiceOf}), so an evaluation or a template saved before
 * the choice existed shows the mode its settings mean.
 */
import type { EvaluationTiming } from "./deadline.js";
import type { LobbyName } from "./evaluationConfig.js";

/** Scheduled: the platform opens and closes it. Live: the teacher does. */
export type ClockMode = "scheduled" | "live";
export const CLOCK_MODES: readonly ClockMode[] = ["scheduled", "live"];

export interface ClockChoice {
  mode: ClockMode;
  /** A time limit per student (`duration` timing). */
  limited: boolean;
}

/** The two stored settings the choice decides. */
export interface ClockSettings {
  timing: EvaluationTiming;
  lobby: LobbyName;
}

/** A field of the timing a mode shows, in screen order. */
export type ClockField = "opensAt" | "closesAt" | "durationS";

/** The limit a choice turning it on starts from: a HEIG-VD period, minus sitting down. */
export const DEFAULT_LIMIT_S = 45 * 60;

/** The choice the stored settings mean. */
export function clockChoiceOf(settings: ClockSettings): ClockChoice {
  return {
    mode: settings.lobby === "skip" && settings.timing !== "manual" ? "scheduled" : "live",
    limited: settings.timing === "duration",
  };
}

/** The waiting rooms a live evaluation may use (advanced options), in screen order. */
export function liveLobbies(limited: boolean): readonly LobbyName[] {
  return limited ? ["manual", "auto"] : ["manual", "auto", "skip"];
}

/**
 * The settings of `choice`. Live keeps the waiting room the teacher chose
 * among the advanced options when the evaluation was live already and that
 * room is still offered; it starts from `manual` otherwise.
 */
export function clockSettingsFor(choice: ClockChoice, current: ClockSettings): ClockSettings {
  if (choice.mode === "scheduled") {
    return { timing: choice.limited ? "duration" : "deadline", lobby: "skip" };
  }
  const keeps = clockChoiceOf(current).mode === "live" && liveLobbies(choice.limited).includes(current.lobby);
  return { timing: choice.limited ? "duration" : "manual", lobby: keeps ? current.lobby : "manual" };
}

/** The fields `choice` shows. */
export function clockFields(choice: ClockChoice): readonly ClockField[] {
  if (choice.mode === "scheduled") {
    return choice.limited ? ["opensAt", "closesAt", "durationS"] : ["opensAt", "closesAt"];
  }
  return choice.limited ? ["opensAt", "durationS"] : ["opensAt", "closesAt"];
}

/** What choosing a mode writes: the settings, and the fields it fills or clears. */
export interface ClockPatch {
  settings: ClockSettings;
  durationS?: number;
  closesAt?: null;
}

/**
 * The patch that moves `current` to `choice`. A limit turned on with none
 * stored starts from {@link DEFAULT_LIMIT_S}; an end the choice no longer
 * shows is cleared, since the ticker would still close on it (ADR-086 §3).
 * `current.closesAt` is absent on a template, which has no dates.
 */
export function clockPatch(
  choice: ClockChoice,
  current: ClockSettings & { durationS: number | null; closesAt?: string | null },
): ClockPatch {
  return {
    settings: clockSettingsFor(choice, current),
    ...(choice.limited && current.durationS === null ? { durationS: DEFAULT_LIMIT_S } : {}),
    ...(current.closesAt != null && !clockFields(choice).includes("closesAt") ? { closesAt: null } : {}),
  };
}
