import { Check, Star, X } from "lucide-react";
import type { CSSProperties } from "react";

import type { GradingEntry } from "@quiz/contracts";

import { useT, type Dict } from "../i18n";
import { cx, Tip } from "../ui";
import { pendingReason, rowVerdict, type RowVerdict } from "./rows";

/**
 * Partly right is right in STRIPES: the success colour at full strength and
 * at 40 % on the surface, so it reads as "some of it" before the eye reaches
 * the check, in both themes, and apart from a solid correct at a glance.
 */
const HATCH: CSSProperties = {
  background:
    "repeating-linear-gradient(135deg, var(--success) 0 2.5px, color-mix(in srgb, var(--success) 40%, var(--surface)) 2.5px 5px)",
};

const WORDS: Record<Exclude<RowVerdict, "pending">, keyof Dict> = {
  correct: "grading.verdict.correct",
  partial: "grading.verdict.partial",
  wrong: "grading.verdict.wrong",
};

const BOX = "inline-flex size-5.5 shrink-0 items-center justify-center rounded-md";

/**
 * The verdict of one answer, as the first cell of its row (ADR-044): a
 * 22 px square that says correct (solid success, a check), partly correct
 * (hatched, a small solid check inside), wrong (solid danger, a cross) or
 * not judged yet (a dashed outline and a "?", its reason in the tooltip).
 * Its words are its accessible name.
 */
export function VerdictGlyph({ entry }: { entry: GradingEntry }) {
  const t = useT();
  const verdict = rowVerdict(entry);
  if (verdict === "pending") {
    const label = t(
      pendingReason(entry) === "byHand" ? "grading.verdict.byHand" : "grading.verdict.ungraded",
    );
    return (
      <Tip label={label}>
        <span
          role="img"
          aria-label={label}
          className={cx(
            BOX,
            "border-[1.5px] border-dashed border-fg-faint text-xs font-bold text-fg-faint",
          )}
        >
          ?
        </span>
      </Tip>
    );
  }
  const label = t(WORDS[verdict]);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={verdict === "partial" ? HATCH : undefined}
      className={cx(
        BOX,
        "text-on-fill",
        verdict === "correct" && "bg-success",
        verdict === "wrong" && "bg-danger",
      )}
    >
      {verdict === "partial" ? (
        <span className="flex size-3.5 items-center justify-center rounded-sm bg-success">
          <Check className="size-2.5 stroke-4" aria-hidden />
        </span>
      ) : verdict === "correct" ? (
        <Check className="size-3.5 stroke-3" aria-hidden />
      ) : (
        <X className="size-3.5 stroke-3" aria-hidden />
      )}
    </span>
  );
}

/** The expected row's mark: the key, in the colour of "a set of possibilities". */
export function ExpectedGlyph() {
  const t = useT();
  return (
    <span
      role="img"
      aria-label={t("grading.expected")}
      title={t("grading.expected")}
      className={cx(BOX, "bg-info text-on-fill")}
    >
      <Star className="size-3.5 fill-current" aria-hidden />
    </span>
  );
}
