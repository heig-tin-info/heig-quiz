import { ChevronLeft, ChevronRight } from "lucide-react";

import { useT } from "../i18n";
import { Button } from "../ui";

/**
 * The player's three actions — previous, the centre one, next — laid out
 * the same in the phone footer and under the question on a desktop. Who
 * wears the accent is decided by `Player` (its header comment); this only
 * draws the decision.
 *
 * The centre is "Validate and continue", and only where the navigation asks
 * for it (`forward_only`, a checkpoint in `milestones`): in `free` there is
 * nothing irreversible to validate, and a question counts as answered as soon
 * as it holds an answer (issue #89). When it is there, it is THE primary
 * action of the screen, and on an empty question it says so: "Leave blank
 * and continue".
 *
 * In an exercise the centre also holds "Check" (ADR-124 §3) while the
 * question is open: the primary once it holds an answer, disabled on an
 * empty one, whose reason the hint under the question gives.
 */
export function PlayerActions({
  manyItems,
  canValidate,
  validateLabel,
  hasPrevious,
  hasNext,
  nextIsPrimary,
  onValidate,
  onMove,
  check,
}: {
  /** One question has no neighbours: both arrows are absent, not disabled. */
  manyItems: boolean;
  canValidate: boolean;
  /** "Validate and continue", or "Leave blank and continue" on an empty question. */
  validateLabel: string;
  hasPrevious: boolean;
  hasNext: boolean;
  nextIsPrimary: boolean;
  onValidate: () => void;
  onMove: (delta: 1 | -1) => void;
  /** ADR-124 §3: an exercise's open question; absent elsewhere. */
  check?: { primary: boolean; disabled: boolean; busy: boolean; onCheck: () => void } | undefined;
}) {
  const t = useT();
  return (
    <>
      {manyItems ? (
        <Button variant="secondary" onClick={() => onMove(-1)} disabled={!hasPrevious}>
          <ChevronLeft className="size-4" aria-hidden />
          {t("player.prev")}
        </Button>
      ) : null}
      <div className="flex-1" />
      {check ? (
        <Button
          variant={check.primary ? "primary" : "secondary"}
          disabled={check.disabled}
          loading={check.busy}
          onClick={check.onCheck}
        >
          {t("player.check")}
        </Button>
      ) : null}
      {canValidate ? (
        <Button variant="primary" onClick={onValidate}>
          {validateLabel}
        </Button>
      ) : null}
      <div className="flex-1" />
      {manyItems ? (
        <Button
          variant={nextIsPrimary ? "primary" : "secondary"}
          onClick={() => onMove(1)}
          disabled={!hasNext}
        >
          {t("player.next")}
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      ) : null}
    </>
  );
}
