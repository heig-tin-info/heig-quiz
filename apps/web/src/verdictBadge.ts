import { CheckCircle2, CircleDot, Hourglass, XCircle } from "lucide-react";

import type { Verdict } from "@quiz/contracts";

import type { Dict } from "./i18n";
import type { IconType, Tone } from "./ui";

/**
 * How a verdict reads, wherever a student or a teacher meets one as a word:
 * the grading's words, a badge's tone and icon. The drill's correctness, the
 * checked question of an exercise (ADR-124 §3) and the grading table's
 * glyph all read it from here.
 */
export const VERDICT_BADGE: Record<Verdict, { label: keyof Dict; tone: Tone; icon: IconType }> = {
  correct: { label: "grading.verdict.correct", tone: "green", icon: CheckCircle2 },
  partial: { label: "grading.verdict.partial", tone: "amber", icon: CircleDot },
  wrong: { label: "grading.verdict.wrong", tone: "red", icon: XCircle },
  pending: { label: "grading.verdict.ungraded", tone: "zinc", icon: Hourglass },
};
