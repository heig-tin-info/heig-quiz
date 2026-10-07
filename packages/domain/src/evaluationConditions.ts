/**
 * The conditions of an evaluation (ADR-079, F-EVAL-33): what a student reads
 * before the clock runs, and can reopen during the attempt.
 *
 * Two halves, never mixed:
 *
 *   - ANNOUNCED: written by the teacher (`settings.conditions`), a snapshot of
 *     plain text in the teacher's order. The platform does not check any of
 *     it — "notes allowed" is the teacher's word, not a fact Quiz can see.
 *   - IMPOSED: derived here from the settings, and only from what the
 *     platform itself ENFORCES or records (ADR-069 §2, generalised by
 *     ADR-079). A calculator set to `none` says nothing — Quiz forbids no
 *     other calculator, only a trusted client can — and the network allowlist
 *     and the shuffles are left out: they are not the student's to act on.
 *     So is `requireFullscreen`: no player asks for full screen nor records
 *     leaving it yet, and a line saying so would state what is not true.
 *     Visibility changes are journalled (F-EVAL-13), so `logVisibility`
 *     says so.
 *
 * {@link imposedConditions} is the one derivation: the server sends its
 * result to the student (the waiting room, the ready screen, the attempt),
 * and the teacher's editor and launch preview call it on the configuration
 * they hold, so both read the same lines.
 */
import { calculatorOn, negativeMarkingOn, trustedClientsOf, type EvaluationModeName, type TrustedClient } from "./evaluationConfig.js";
import { retakesOn, type RetakePolicy } from "./retake.js";

/** What a condition says about the thing it names, as on the wire. */
export const CONDITION_KINDS = ["allowed", "forbidden", "provided", "info"] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

/** At most this many announced conditions on one evaluation. */
export const MAX_CONDITIONS = 20;
/** The longest text of one announced condition, trimmed. */
export const MAX_CONDITION_LENGTH = 200;

/**
 * A poll has no conditions to sit under: the server refuses them there, and
 * an evaluation of that mode reads them as empty whatever its row says —
 * exactly like the calculator (ADR-069).
 */
export function conditionsAllowedFor(mode: EvaluationModeName): boolean {
  return mode !== "poll";
}

/** The announced conditions an evaluation of `mode` shows: none on a poll, whatever its row says. */
export function announcedConditionsOn<T>(mode: EvaluationModeName, conditions: readonly T[] | undefined): T[] {
  return conditionsAllowedFor(mode) ? [...(conditions ?? [])] : [];
}

/** One imposed line: a key the screens translate, its kind, and its parameters. */
export type ImposedCondition =
  | { key: "trusted_client"; kind: "forbidden"; clients: TrustedClient[] }
  | { key: "calculator"; kind: "provided"; calculator: "standard" | "scientific" }
  | { key: "duration"; kind: "info"; durationS: number; bonusPercent: number }
  | { key: "deadline"; kind: "info"; closesAt: string; bonusPercent: number }
  | { key: "attempts"; kind: "info"; maxAttempts: number | null }
  | { key: "navigation"; kind: "info"; navigation: "forward_only" | "milestones" }
  | { key: "negative_marking"; kind: "info" }
  | { key: "visibility_logged"; kind: "info" }
  | { key: "autosave"; kind: "info" };

export type ImposedConditionKey = ImposedCondition["key"];

/** Every imposed key, in the fixed order the lines are drawn. */
export const IMPOSED_CONDITION_KEYS = [
  "trusted_client",
  "calculator",
  "duration",
  "deadline",
  "attempts",
  "navigation",
  "negative_marking",
  "visibility_logged",
  "autosave",
] as const satisfies readonly ImposedConditionKey[];

/** The keys that state the time a student has (the ready screen says it beside Start). */
export const TIMING_CONDITION_KEYS: readonly ImposedConditionKey[] = ["duration", "deadline"];

/** What the derivation reads: the evaluation's mode, settings and timing, and the student's bonus. */
export interface ConditionsInput {
  mode: EvaluationModeName;
  settings: {
    navigation: "free" | "forward_only" | "milestones";
    timing: "duration" | "deadline" | "manual";
    logVisibility: boolean;
    retakes?: RetakePolicy | undefined;
    negativeMarking?: boolean | undefined;
    safeExamBrowser?: boolean | undefined;
    kiosk?: boolean | undefined;
    calculator?: "none" | "standard" | "scientific" | undefined;
  };
  durationS: number | null;
  /** An ISO instant, or null (a template has none). */
  closesAt: string | null;
  /** The student's extra time (an accommodation); 0 for the teacher's previews. */
  timeBonusPercent: number;
}

/**
 * The lines the platform adds to an evaluation's conditions, in the fixed
 * order of {@link IMPOSED_CONDITION_KEYS}. A poll has none.
 */
export function imposedConditions(input: ConditionsInput): ImposedCondition[] {
  const { mode, settings } = input;
  if (!conditionsAllowedFor(mode)) return [];
  const lines: ImposedCondition[] = [];
  const clients = trustedClientsOf(mode, settings);
  if (clients.length > 0) lines.push({ key: "trusted_client", kind: "forbidden", clients });
  const calculator = calculatorOn(mode, settings.calculator);
  if (calculator !== "none") lines.push({ key: "calculator", kind: "provided", calculator });
  const bonusPercent = input.timeBonusPercent;
  if (settings.timing === "duration" && input.durationS !== null && input.durationS > 0) {
    lines.push({ key: "duration", kind: "info", durationS: input.durationS, bonusPercent });
  } else if (settings.timing === "deadline" && input.closesAt !== null) {
    lines.push({ key: "deadline", kind: "info", closesAt: input.closesAt, bonusPercent });
  }
  const retakes = settings.retakes;
  lines.push({
    key: "attempts",
    kind: "info",
    maxAttempts: retakes !== undefined && retakesOn(mode, retakes) ? retakes.maxAttempts : 1,
  });
  if (settings.navigation !== "free") {
    lines.push({ key: "navigation", kind: "info", navigation: settings.navigation });
  }
  if (negativeMarkingOn(mode, settings.negativeMarking)) lines.push({ key: "negative_marking", kind: "info" });
  if (settings.logVisibility) lines.push({ key: "visibility_logged", kind: "info" });
  lines.push({ key: "autosave", kind: "info" });
  return lines;
}
