/**
 * The `mcq` answer key of the debrief (ADR-033, ADR-109): every choice, its
 * letter, and the share of the papers that ticked it, the count beside.
 * Revealed, a key's bar is green and a distractor's red, and its name says
 * which; hidden, every bar is muted and says "ticked" only — how the class
 * voted, which the ticks alone do not tell the key from.
 *
 * Staff only (`QuestionTypeClient.Key`): never mounted on a student surface.
 */
import type { KeyBarPart, KeyProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { answeredCount, CorrectionCount, cx } from "@quiz/ui";

import { letteredChoices, type McqSolution, type McqStudent } from "./schema.js";
import { mcqKeyStrings, type McqKeyStringKey } from "./strings.js";

/** The sizes only this key draws, per density (DESIGN.md, "Correction projection"). */
const SCALE = {
  wall: {
    choiceRow:
      "grid-cols-[minmax(0,1fr)_minmax(180px,38%)_3rem] gap-x-[clamp(16px,2vw,28px)] py-[clamp(10px,1.4vh,16px)]",
    choiceGap: "gap-3.5",
    letter: "size-[clamp(30px,2.4vw,38px)] text-[clamp(14px,1.2vw,18px)]",
    choice: "text-[clamp(18px,1.8vw,27px)]",
  },
  page: {
    choiceRow: "grid-cols-[minmax(0,1fr)_minmax(120px,30%)_2.5rem] gap-x-4 py-2",
    choiceGap: "gap-2.5",
    letter: "size-6 text-xs",
    choice: "text-sm",
  },
} as const;

type McqKeyProps = KeyProps<McqStudent | null, McqSolution> & {
  strings?: StringOverrides<McqKeyStringKey>;
};

export function McqKey({ student, solution, revealed, density, stats, prompt, Bar, renderMarkdown, strings }: McqKeyProps) {
  const s = resolveStrings(mcqKeyStrings, strings);
  const scale = SCALE[density];
  const ticks = new Map(stats.distribution.map((d) => [d.key, d.count]));
  const n = answeredCount(stats);
  return (
    <>
      {prompt}
      <ul className="flex flex-col">
        {/* The SERVED order, lettered by position: what every student had on screen. */}
        {letteredChoices(student, solution).map((choice) => {
          const right = choice.correct;
          const ticked = ticks.get(String(choice.id)) ?? 0;
          const part: KeyBarPart = !revealed
            ? { tone: "muted", label: s.ticked, value: ticked }
            : right
              ? { tone: "success", label: s.key, value: ticked }
              : { tone: "danger", label: s.distractor, value: ticked };
          return (
            <li
              key={choice.id}
              className={cx(
                "grid items-center border-b border-line px-1 max-md:grid-cols-[minmax(0,1fr)_3rem] max-md:gap-y-2",
                scale.choiceRow,
              )}
            >
              <span className={cx("flex items-start max-md:col-span-2", scale.choiceGap)}>
                <span
                  className={cx(
                    "grid shrink-0 place-items-center rounded-full font-bold",
                    scale.letter,
                    !revealed
                      ? "bg-surface-3 text-fg-muted"
                      : right
                        ? "bg-success text-on-fill"
                        : "bg-danger-soft text-danger",
                  )}
                >
                  {choice.letter}
                </span>
                <span
                  className={cx(
                    "min-w-0 flex-1 pt-px font-medium leading-snug",
                    scale.choice,
                    revealed && !right && "text-fg-muted [&_code]:text-inherit",
                  )}
                >
                  {renderMarkdown(choice.text)}
                </span>
              </span>
              <Bar parts={[part]} total={Math.max(1, n)} />
              <CorrectionCount density={density}>{ticked}</CorrectionCount>
            </li>
          );
        })}
      </ul>
    </>
  );
}
