/**
 * The `categorize` answer key of the debrief (ADR-033, ADR-109): its
 * columns, and the cards to sort. Hidden, every card waits above the empty
 * columns, as the class found them; revealed, each card sits in the column
 * the key puts it in — in the key's order when the order counts — and the
 * distractors stay above, "in no column". No count and no answer rows: the
 * type groups no answers (its verdicts are the head's bar).
 *
 * Drawn at the debrief's scale, not with the board of the player and the
 * review (`Board.tsx`): a card here is a line of the wall, its rank a plain
 * "1.", so its frame and its columns are this file's own; its tones are the
 * type's (`cardTone`, `ui.tsx`).
 *
 * Staff only (`QuestionTypeClient.Key`): never mounted on a student surface.
 */
import type { KeyProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { CORRECTION_SCALE, cx } from "@quiz/ui";

import type { CategorizeSolution, CategorizeStudent } from "./schema.js";
import { categorizeKeyStrings, type CategorizeKeyStringKey } from "./strings.js";
import { cardTone } from "./ui.js";

type CategorizeKeyProps = KeyProps<CategorizeStudent | null, CategorizeSolution> & {
  strings?: StringOverrides<CategorizeKeyStringKey>;
};

export function CategorizeKey({ student, solution, revealed, density, prompt, renderMarkdown, strings }: CategorizeKeyProps) {
  const s = resolveStrings(categorizeKeyStrings, strings);
  const scale = CORRECTION_SCALE[density];
  if (!student) return prompt;
  const text = new Map(student.cards.map((card) => [card.id, card.text]));
  const key = new Map((solution?.columns ?? []).map((c) => [c.id, c.cards]));
  const placed = new Set([...key.values()].flat());
  const pool = student.cards.map((card) => card.id).filter((id) => !revealed || !placed.has(id));
  const card = (id: string, rank: number | null, tone: string) => (
    <li key={id} className={cx("flex min-w-0 items-baseline gap-2 rounded-field border px-3 py-1.5 font-medium", scale.answer, tone)}>
      {rank === null ? null : <span className="font-mono tabular-nums text-fg-muted">{rank}.</span>}
      <span className="min-w-0 [overflow-wrap:anywhere]">{renderMarkdown(text.get(id) ?? "")}</span>
    </li>
  );
  return (
    <>
      {prompt}
      <div className="flex flex-col gap-4">
        {pool.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className={cx("font-medium text-fg-muted", scale.caption)}>{revealed ? s.none : s.cards}</p>
            <ul className="flex flex-wrap gap-2">
              {pool.map((id) =>
                card(id, null, revealed ? "border-line text-fg-muted" : cardTone.neutral),
              )}
            </ul>
          </div>
        ) : null}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
          {student.columns.map((column) => (
            <section key={column.id} className="flex min-w-0 flex-col rounded-card border border-line">
              <h3 className={cx("border-b border-line px-3 py-2 font-semibold", scale.answer)}>{column.label}</h3>
              <ol aria-label={column.label} className="flex min-h-12 flex-col gap-2 p-3">
                {revealed
                  ? (key.get(column.id) ?? []).map((id, index) =>
                      card(id, student.ordered ? index + 1 : null, cardTone.right),
                    )
                  : null}
              </ol>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
