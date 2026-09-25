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
 * action of the screen.
 */
export function PlayerActions({
  manyItems,
  canValidate,
  hasPrevious,
  hasNext,
  nextIsPrimary,
  onValidate,
  onMove,
}: {
  /** One question has no neighbours: both arrows are absent, not disabled. */
  manyItems: boolean;
  canValidate: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  nextIsPrimary: boolean;
  onValidate: () => void;
  onMove: (delta: 1 | -1) => void;
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
      {canValidate ? (
        <Button variant="primary" onClick={onValidate}>
          {t("player.validate")}
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
