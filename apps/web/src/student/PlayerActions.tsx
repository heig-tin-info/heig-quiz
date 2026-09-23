import { ChevronLeft, ChevronRight } from "lucide-react";

import { useT } from "../i18n";
import { Button } from "../ui";

/**
 * The player's three actions — previous, the centre one, next — laid out
 * the same in the phone footer and under the question on a desktop. Who
 * wears the accent is decided by `Player` (its header comment); this only
 * draws the decision.
 */
export function PlayerActions({
  manyItems,
  done,
  canReopen,
  readOnly,
  hasPrevious,
  hasNext,
  nextIsPrimary,
  onToggleDone,
  onMove,
}: {
  /** One question has no neighbours: both arrows are absent, not disabled. */
  manyItems: boolean;
  done: boolean;
  canReopen: boolean;
  readOnly: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  nextIsPrimary: boolean;
  onToggleDone: () => void;
  onMove: (delta: 1 | -1) => void;
}) {
  const t = useT();
  const centre = !done ? (
    <Button variant="primary" onClick={onToggleDone} disabled={readOnly}>
      {t("player.markDone")}
    </Button>
  ) : canReopen ? (
    // Secondary, named for what it does, and with no tick: the button that
    // used to sit here read "Done ✓" in the primary style and un-did the
    // question when pressed.
    <Button variant="secondary" onClick={onToggleDone}>
      {t("player.reopen")}
    </Button>
  ) : null;
  return (
    <>
      {manyItems ? (
        <Button variant="secondary" onClick={() => onMove(-1)} disabled={!hasPrevious}>
          <ChevronLeft className="size-4" aria-hidden />
          {t("player.prev")}
        </Button>
      ) : null}
      <div className="flex-1" />
      {centre}
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
