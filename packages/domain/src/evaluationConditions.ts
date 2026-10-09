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
 *     other calculator, only a trusted client can (nor does a notepad set to
 *     `none` forbid paper, ADR-090) — and the network allowlist
 *     and the shuffles are left out: they are not the student's to act on.
 *     So is `requireFullscreen`: no player asks for full screen nor records
 *     leaving it yet, and a line saying so would state what is not true.
 *     Leaving the page and pasting from outside it are journalled
 *     (F-EVAL-13, ADR-088), so
 *     `logVisibility` says so.
 *
 * {@link imposedConditions} is the one derivation: the server sends its
 * result to the student (the waiting room, the ready screen, the attempt),
 * and the teacher's editor and launch preview call it on the configuration
 * they hold, so both read the same lines.
 *
 * The two halves are kept apart in the data, not on the screen: the student
 * reads them grouped by kind ({@link conditionsByKind}, ADR-079 §6 as
 * amended 2026-10-08, issue #584), the teacher's lines first inside each kind.
 */
import type { EvaluationTiming } from "./deadline.js";
import {
  calculatorAllowedFor,
  calculatorOn,
  integrityJournalOn,
  negativeMarkingOn,
  notepadOn,
  trustedClientsOf,
  type CalculatorMode,
  type NotepadMode,
  type EvaluationModeName,
  type TrustedClient,
} from "./evaluationConfig.js";
import type { NavigationMode } from "./questionProgress.js";
import { retakesOn, type RetakePolicy } from "./retake.js";

/** What a condition says about the thing it names, as on the wire. */
export const CONDITION_KINDS = ["allowed", "forbidden", "provided", "info"] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

/**
 * The order in which a student reads the kinds: what they must not use
 * first, then what they may, what they are given, and the rest.
 */
export const CONDITION_KIND_ORDER = ["forbidden", "allowed", "provided", "info"] as const satisfies readonly ConditionKind[];

/** At most this many announced conditions on one evaluation. */
export const MAX_CONDITIONS = 20;
/** The longest text of one announced condition, trimmed. */
export const MAX_CONDITION_LENGTH = 200;

/** The calculators a line can say are provided: every mode but `none`. */
export const PROVIDED_CALCULATORS = ["standard", "scientific"] as const satisfies readonly CalculatorMode[];
/** The navigations a line states: those that do not go back. */
export const LOCKED_NAVIGATIONS = ["forward_only", "milestones"] as const satisfies readonly NavigationMode[];

/**
 * A poll has no conditions to sit under: the server refuses them there, and
 * an evaluation of that mode reads them as empty whatever its row says —
 * the same modes as the calculator's (ADR-069), hence the same rule.
 */
export const conditionsAllowedFor = calculatorAllowedFor;

/** The announced conditions an evaluation of `mode` shows: none on a poll, whatever its row says. */
export function announcedConditionsOn<T>(mode: EvaluationModeName, conditions: readonly T[] | undefined): T[] {
  return conditionsAllowedFor(mode) ? [...(conditions ?? [])] : [];
}

/** One imposed line: a key the screens translate, its kind, and its parameters. */
export type ImposedCondition =
  | { key: "trusted_client"; kind: "forbidden"; clients: TrustedClient[] }
  | { key: "calculator"; kind: "provided"; calculator: (typeof PROVIDED_CALCULATORS)[number] }
  | { key: "notepad"; kind: "provided" }
  | { key: "notepad_no_clipboard"; kind: "provided" }
  | { key: "duration"; kind: "info"; durationS: number; bonusPercent: number }
  | { key: "deadline"; kind: "info"; closesAt: string; bonusPercent: number }
  | { key: "attempts"; kind: "info"; maxAttempts: number | null }
  | { key: "navigation"; kind: "info"; navigation: (typeof LOCKED_NAVIGATIONS)[number] }
  | { key: "negative_marking"; kind: "info" }
  | { key: "visibility_logged"; kind: "info" }
  | { key: "autosave"; kind: "info" };

export type ImposedConditionKey = ImposedCondition["key"];

/** What the derivation reads: the evaluation's mode, settings and timing, and the student's bonus. */
export interface ConditionsInput {
  mode: EvaluationModeName;
  settings: {
    navigation: NavigationMode;
    timing: EvaluationTiming;
    logVisibility: boolean;
    retakes?: RetakePolicy | undefined;
    negativeMarking?: boolean | undefined;
    safeExamBrowser?: boolean | undefined;
    kiosk?: boolean | undefined;
    calculator?: CalculatorMode | undefined;
    notepad?: NotepadMode | undefined;
  };
  durationS: number | null;
  /** An ISO instant, or null (a template has none). */
  closesAt: string | null;
  /** The student's extra time (an accommodation); 0 for the teacher's previews. */
  timeBonusPercent: number;
}

type Line<K extends ImposedConditionKey> = Extract<ImposedCondition, { key: K }>;

const isLocked = (navigation: NavigationMode): navigation is Line<"navigation">["navigation"] =>
  (LOCKED_NAVIGATIONS as readonly string[]).includes(navigation);

/**
 * THE order of the imposed lines, and how each is derived: the table is
 * walked in its own key order, a key whose fact does not hold giving null.
 */
const DERIVE: { [K in ImposedConditionKey]: (input: ConditionsInput) => Line<K> | null } = {
  trusted_client: ({ mode, settings }) => {
    const clients = trustedClientsOf(mode, settings);
    return clients.length > 0 ? { key: "trusted_client", kind: "forbidden", clients } : null;
  },
  calculator: ({ mode, settings }) => {
    const calculator = calculatorOn(mode, settings.calculator);
    return calculator === "none" ? null : { key: "calculator", kind: "provided", calculator };
  },
  // ADR-090: the notepad, then — only when it is enforced — that copy and
  // paste are blocked IN it (the answer fields are untouched, so the line
  // says nothing about them). Both "provided", so they read side by side.
  notepad: ({ mode, settings }) =>
    notepadOn(mode, settings.notepad) === "none" ? null : { key: "notepad", kind: "provided" },
  notepad_no_clipboard: ({ mode, settings }) =>
    notepadOn(mode, settings.notepad) === "provided_no_clipboard"
      ? { key: "notepad_no_clipboard", kind: "provided" }
      : null,
  duration: ({ settings, durationS, timeBonusPercent }) =>
    settings.timing === "duration" && durationS !== null && durationS > 0
      ? { key: "duration", kind: "info", durationS, bonusPercent: timeBonusPercent }
      : null,
  // Whatever the timing (ADR-086): the common end, the end of the window
  // that cuts a duration, or a live evaluation's safety deadline. The
  // accommodation pushes the first two, never a safety deadline.
  deadline: ({ settings, closesAt, timeBonusPercent }) =>
    closesAt !== null
      ? {
          key: "deadline",
          kind: "info",
          closesAt,
          bonusPercent: settings.timing === "manual" ? 0 : timeBonusPercent,
        }
      : null,
  attempts: ({ mode, settings: { retakes } }) => ({
    key: "attempts",
    kind: "info",
    maxAttempts: retakes !== undefined && retakesOn(mode, retakes) ? retakes.maxAttempts : 1,
  }),
  navigation: ({ settings: { navigation } }) =>
    isLocked(navigation) ? { key: "navigation", kind: "info", navigation } : null,
  negative_marking: ({ mode, settings }) =>
    negativeMarkingOn(mode, settings.negativeMarking) ? { key: "negative_marking", kind: "info" } : null,
  visibility_logged: ({ mode, settings }) =>
    integrityJournalOn(mode, settings.logVisibility) ? { key: "visibility_logged", kind: "info" } : null,
  autosave: () => ({ key: "autosave", kind: "info" }),
};

/** The lines the platform adds to an evaluation's conditions, in the fixed order of the table. A poll has none. */
export function imposedConditions(input: ConditionsInput): ImposedCondition[] {
  if (!conditionsAllowedFor(input.mode)) return [];
  return Object.values(DERIVE).flatMap((derive) => derive(input) ?? []);
}

/** The lines of one kind: the teacher's, in their order, then the platform's, in the fixed order. */
export interface ConditionGroup<A, I> {
  kind: ConditionKind;
  announced: A[];
  imposed: I[];
}

/**
 * The conditions as the student reads them (ADR-079 §6, amended 2026-10-08):
 * one group per kind, in {@link CONDITION_KIND_ORDER}, a kind with no line
 * left out. The order inside each half is kept as given, so a caller that
 * hides an imposed line (the ready screen's clock) filters before calling.
 */
export function conditionsByKind<A extends { kind: ConditionKind }, I extends { kind: ConditionKind }>(
  announced: readonly A[],
  imposed: readonly I[],
): ConditionGroup<A, I>[] {
  return CONDITION_KIND_ORDER.map((kind) => ({
    kind,
    announced: announced.filter((line) => line.kind === kind),
    imposed: imposed.filter((line) => line.kind === kind),
  })).filter((group) => group.announced.length + group.imposed.length > 0);
}
