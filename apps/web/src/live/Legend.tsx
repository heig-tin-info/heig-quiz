import type { Dict } from "../i18n";
import { useT } from "../i18n";
import { VerdictCell, type VerdictState } from "../ui";

/**
 * The eight states a cell can wear, named, and the flag a student can put
 * on any of them (issue #89). A tint alone is not a legend, and a
 * dashboard on a lecture-hall wall has lost half of its saturation anyway.
 *
 * They are listed in the order a cell goes through them: the three progress
 * states first, left to right and pale to filled, then the three verdicts the
 * "Results" switch replaces them with. `pending` is left out on purpose: it
 * belongs to the grading screen, and a legend that lists a state the grid
 * cannot show is a legend nobody trusts.
 *
 * With the switch ON, the three verdicts appear while the quiz is still
 * running: the server grades the answers it already holds (ADR-020), for the
 * question types it can grade without the runner. The legend says so in one
 * line rather than letting the teacher wonder whether a green cell is final.
 */
const SHOWN = [
  ["blank", "verdict.blank"],
  ["inProgress", "verdict.inProgress"],
  ["answered", "verdict.answered"],
  ["skipped", "live.verdict.skipped"],
  ["done", "live.verdict.done"],
  ["correct", "verdict.correct"],
  ["partial", "verdict.partial"],
  ["wrong", "verdict.wrong"],
] as const satisfies readonly (readonly [VerdictState, keyof Dict])[];

export function Legend({ showResults = false }: { showResults?: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-muted">
      <ul
        aria-label={t("live.legend")}
        className="flex flex-wrap items-center gap-x-4 gap-y-2"
      >
        {SHOWN.map(([state, key]) => (
          <li key={state} className="flex items-center gap-1.5">
            <span className="w-8">
              <VerdictCell state={state} />
            </span>
            {t(key)}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="w-8">
            <VerdictCell state="blank" flagged />
          </span>
          {t("live.legend.flag")}
        </li>
      </ul>
      <span className="text-fg-faint">
        {showResults ? t("live.legend.live") : t("live.legend.off")}
      </span>
    </div>
  );
}
