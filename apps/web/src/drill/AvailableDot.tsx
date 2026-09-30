import { useT } from "../i18n";

/**
 * "Today's drill is available" (ADR-041 §6): an accent dot, never a count —
 * a number of cards left is a streak by another name (06, question 28) —
 * with its words for a screen reader. The bottom bar's Drill slot and the
 * sidebar's Drill row both wear it; where it sits is theirs to say.
 */
export function AvailableDot() {
  const t = useT();
  return (
    <>
      <span
        aria-hidden
        data-testid="drill-available"
        className="block size-2 shrink-0 rounded-full bg-accent ring-2 ring-canvas"
      />
      <span className="sr-only">{t("drill.available")}</span>
    </>
  );
}
