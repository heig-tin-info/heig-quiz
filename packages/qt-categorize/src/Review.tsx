/**
 * The `categorize` review: the student's board as they left it, every card
 * marked right or wrong, and — when the key is published — where a wrong card
 * belonged.
 *
 * What it may show is decided upstream, and the review never adds to it:
 *
 *  - the VERDICT of a card is `details.cards[].right`, and nothing else. When
 *    the key is not published, `studentDetails` has removed it from every card
 *    the student left in the tray (it would say which ones were distractors),
 *    and such a card is simply drawn neutral. The review never judges a card
 *    itself, not even from a solution it holds;
 *  - the SOLUTION feeds the "Expected: …" line under a wrong card, and only
 *    that — `null` when the feedback policy hides the key.
 */
import type { MarkdownRenderer, ReviewProps, StringOverrides } from "@quiz/core/client";
import { fmt, resolveStrings, showsSection } from "@quiz/core/client";
import { breakdownOf, caption, cx, markdown, reviewPrompt, ScoreHeader } from "@quiz/ui";

import { ColumnFrame, columnGrid, trayFrame } from "./Board.js";
import { keyOf, normalizePlacement, trayOf } from "./placement.js";
import type {
  CategorizeAnswer,
  CategorizeReviewDetails,
  CategorizeSolution,
  CategorizeStudent,
} from "./schema.js";
import { categorizeReviewStrings, type CategorizeReviewStringKey } from "./strings.js";
import { cardClass, cardTone, CheckIcon, CloseIcon, Rank } from "./ui.js";

type CategorizeReviewProps = ReviewProps<
  CategorizeStudent,
  CategorizeAnswer,
  CategorizeSolution,
  CategorizeReviewDetails
> & {
  strings?: StringOverrides<CategorizeReviewStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

export function CategorizeReview({
  student,
  answer,
  solution,
  details,
  points,
  maxPoints,
  sections,
  strings,
  renderMarkdown,
}: CategorizeReviewProps) {
  const s = resolveStrings(categorizeReviewStrings, strings);
  const placement = normalizePlacement(student.columns, student.cards, answer?.columns);
  const tray = trayOf(student.cards, placement);
  const text = new Map(student.cards.map((card) => [card.id, card.text]));
  const labelOf = new Map(student.columns.map((column) => [column.id, column.label]));
  const breakdown = breakdownOf(details, "cards");
  const verdicts = new Map(breakdown?.cards.map((card) => [card.id, card.right]) ?? []);
  const key = solution !== null && showsSection(sections, "solution") ? keyOf(solution.columns) : null;
  const ordered = student.ordered;

  /** Where a wrong card belonged, when the key is published. */
  const expectedLine = (card: string): string | null => {
    if (key === null) return null;
    const want = key.get(card);
    if (want === undefined) return s.expectedNone;
    const column = labelOf.get(want.column) ?? "";
    return ordered ? fmt(s.expectedRank, { column, rank: want.rank }) : fmt(s.expected, { column });
  };

  const cardView = (card: string, rank: number | null) => {
    const right = verdicts.get(card);
    const expected = right === false ? expectedLine(card) : null;
    return (
      <li
        key={card}
        className={cx(
          cardClass,
          right === undefined ? cardTone.neutral : right ? cardTone.right : cardTone.wrong,
        )}
      >
        {ordered && rank !== null ? <Rank n={rank} /> : null}
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {markdown(renderMarkdown, text.get(card) ?? "")}
          {expected === null ? null : <span className="block text-xs font-medium text-fg-muted">{expected}</span>}
        </span>
        {right === undefined ? null : (
          <span className={right ? "text-success" : "text-danger"}>
            {right ? <CheckIcon /> : <CloseIcon />}
            <span className="sr-only">{right ? s.right : s.wrong}</span>
          </span>
        )}
      </li>
    );
  };

  /**
   * The count beside the score. With the whole breakdown (the key published,
   * or the teacher), every card's verdict; without it, only the student's
   * own placements — "right among the cards you placed" — since the rest
   * would count the distractors.
   */
  const tally =
    breakdown === null
      ? null
      : breakdown.T === undefined
        ? `${s.breakdownPlaced} ${breakdown.t}/${breakdown.t + breakdown.x + breakdown.p}`
        : `${s.breakdown} ${breakdown.cards.filter((card) => card.right === true).length}/${student.cards.length}`;

  return (
    <div className="flex flex-col gap-3">
      {showsSection(sections, "prompt") ? (
        <div className={reviewPrompt}>{markdown(renderMarkdown, student.prompt)}</div>
      ) : null}

      {tray.length > 0 ? (
        <div className={trayFrame}>
          <h4 className="text-[13px] font-semibold text-fg">{s.leftOut}</h4>
          <ul className="flex flex-wrap gap-1.5">{tray.map((card) => cardView(card, null))}</ul>
        </div>
      ) : null}

      <div className={columnGrid}>
        {student.columns.map((column) => {
          const ids = placement[column.id] ?? [];
          return (
            <ColumnFrame
              key={column.id}
              head={
                <>
                  <span className="min-w-0 flex-1 text-sm font-semibold text-fg">{column.label}</span>
                  <span className="text-xs tabular-nums text-fg-faint">{ids.length}</span>
                </>
              }
            >
              <ul className="flex min-h-12 flex-col gap-1.5 p-2">
                {ids.map((card, index) => cardView(card, index + 1))}
              </ul>
            </ColumnFrame>
          );
        })}
      </div>

      {tray.length < student.cards.length ? null : <p className={caption}>{s.noAnswer}</p>}

      <ScoreHeader label={s.score} points={points} maxPoints={maxPoints}>
        {tally === null ? null : <span className="ml-2 text-fg-faint">· {tally}</span>}
      </ScoreHeader>
      {breakdown?.negativeMarking ? <p className={caption}>{s.negativeMarking}</p> : null}
    </div>
  );
}
