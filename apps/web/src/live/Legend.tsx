import type { Dict } from "../i18n";
import { useT } from "../i18n";
import { VerdictCell, type VerdictState } from "../ui";

/**
 * The seven states a cell can wear, named. A tint alone is not a legend, and a
 * dashboard on a lecture-hall wall has lost half of its saturation anyway.
 *
 * They are listed in the order a cell goes through them: the three progress
 * states first, left to right and pale to filled, then the three verdicts the
 * "Results" switch replaces them with. `pending` is left out on purpose: it
 * belongs to the grading screen, and a legend that lists a state the grid
 * cannot show is a legend nobody trusts.
 */
const SHOWN = [
  ["blank", "verdict.blank"],
  ["inProgress", "verdict.inProgress"],
  ["answered", "verdict.answered"],
  ["done", "live.verdict.done"],
  ["correct", "verdict.correct"],
  ["partial", "verdict.partial"],
  ["wrong", "verdict.wrong"],
] as const satisfies readonly (readonly [VerdictState, keyof Dict])[];

export function Legend() {
  const t = useT();
  return (
    <ul
      aria-label={t("live.legend")}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-muted"
    >
      {SHOWN.map(([state, key]) => (
        <li key={state} className="flex items-center gap-1.5">
          <span className="w-8">
            <VerdictCell state={state} />
          </span>
          {t(key)}
        </li>
      ))}
    </ul>
  );
}
