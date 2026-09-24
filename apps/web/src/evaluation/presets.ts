/*
 * The two named presets of docs/spec/08 §8.2 ("Préréglages nommés"), as data.
 *
 * A preset is not a mode and not a stored column: it is one click that writes
 * a handful of settings a novice would otherwise have to reason about one by
 * one. Which is why it lives here as a plain patch body — the screen applies
 * it with the same `PATCH /evaluations/:id` every individual control uses,
 * and reading back "which preset is this?" is a comparison, never a flag that
 * could drift from the settings it claims to describe.
 */
import type { EvaluationDetail, EvaluationPatch } from "@quiz/contracts";

export type PresetId = "classroom" | "homework";

/** 45 minutes: a period at HEIG-VD, minus the time it takes to sit down. */
const CLASSROOM_DURATION_S = 45 * 60;

/** A week, which is what "exercise of the week" means. */
const HOMEWORK_WINDOW_MS = 7 * 24 * 3600 * 1000;

export function presetPatch(id: PresetId, now = Date.now()): EvaluationPatch {
  if (id === "classroom") {
    return {
      settings: {
        timing: "duration",
        lobby: "manual",
        navigation: "free",
        presentation: "zen",
        shuffleItems: true,
        shuffleChoices: true,
        showProgressBar: true,
      },
      durationS: CLASSROOM_DURATION_S,
      closesAt: null,
      feedbackPolicy: { when: "on_release", showKey: true, showExplanation: true },
    };
  }
  return {
    settings: {
      timing: "deadline",
      lobby: "skip",
      navigation: "free",
      presentation: "continuous",
      shuffleItems: false,
      shuffleChoices: true,
      showProgressBar: true,
    },
    durationS: null,
    // A common end needs its opening time: it is the base of the extra time
    // (decision D8), and the waiting room refuses to open without it (#76).
    // The window the preset promises starts now.
    opensAt: new Date(now).toISOString(),
    closesAt: new Date(now + HOMEWORK_WINDOW_MS).toISOString(),
    // An `exam` never stores `immediate`; the server clamps it back to
    // `on_release` (WP5 deviation W5-18), so sending it is safe either way.
    feedbackPolicy: { when: "immediate", showKey: true, showExplanation: true },
  };
}

/**
 * Which preset the current settings look like, or null for "custom". Only the
 * decisions the preset is ABOUT are compared: a teacher who ticked "shuffle
 * the choices" off has not left the in-class preset behind.
 */
export function matchPreset(detail: EvaluationDetail): PresetId | null {
  const { settings } = detail.evaluation;
  if (settings.timing === "duration" && settings.lobby === "manual") return "classroom";
  if (settings.timing === "deadline" && settings.lobby === "skip") return "homework";
  return null;
}
