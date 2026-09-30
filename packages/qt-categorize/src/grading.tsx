/**
 * The `categorize` columns of the grading table (ADR-044): one column per
 * CARD, headed by the card, each cell the column the student put it in —
 * a chip tinted by that card's own verdict, read from the grading's
 * breakdown (`details.cards[].right`, `@quiz/domain/categorizeScore`), never
 * judged here. A card left in the tray is an em dash. The expected row names
 * the column the key puts each card in, or "Left out" for a distractor.
 *
 * Past {@link CATEGORIZE_GRADING_MAX_COLUMNS} cards, a column per card is a
 * table nobody can read: the question gets ONE column counting the cards
 * right instead, and the side panel shows the board.
 */
import type { ReactNode } from "react";

import type { GradingColumn, QuestionTypeGrading } from "@quiz/core/client";
import { fmt, gradingSortKey, resolveStrings } from "@quiz/core/client";
import { AnswerChip, breakdownOf, countTone, Dash, headerOf, WordChip } from "@quiz/ui";

import { keyOf, placesOf, type Place } from "./placement.js";
import type { CategorizeAnswer, CategorizeDetails, CategorizeSolution, CategorizeStudent } from "./schema.js";
import { categorizeGradingStrings } from "./strings.js";

/** The most cards that each get a column; one more and the question gets one summary column. */
export const CATEGORIZE_GRADING_MAX_COLUMNS = 8;

/** A header is a column's name, not the card: the whole text is its tooltip. */
const HEADER_CHARS = 24;

type Column = GradingColumn<CategorizeAnswer, CategorizeDetails>;
type Strings = typeof categorizeGradingStrings;

/**
 * A chip that asks its column for no width of its own: zero wide to the
 * table's layout, as wide as the cell once laid out, so eight card columns
 * keep their equal shares and a long column name is cut, not the table
 * pushed past the page.
 */
const Fit = ({ children }: { children: ReactNode }) => (
  <span className="block w-0 min-w-full">{children}</span>
);

/**
 * What every column of one question reads: where each card of an answer
 * went — computed ONCE per answer, not once per card column (a row of
 * eight columns asks eight times) — and how a place is said.
 */
function board(student: CategorizeStudent, s: Strings) {
  const labelOf = new Map(student.columns.map((column) => [column.id, column.label]));
  const memo = new WeakMap<CategorizeAnswer, Map<string, Place>>();
  const none = new Map<string, Place>();
  return {
    placesIn(answer: CategorizeAnswer | null): Map<string, Place> {
      if (answer === null) return none;
      let places = memo.get(answer);
      if (places === undefined) {
        places = placesOf(student, answer);
        memo.set(answer, places);
      }
      return places;
    },
    text(place: Place): string {
      const column = labelOf.get(place.column) ?? "";
      return student.ordered ? fmt(s.ranked, { column, rank: place.rank }) : column;
    },
  };
}

type Board = ReturnType<typeof board>;

/** Past {@link CATEGORIZE_GRADING_MAX_COLUMNS} cards: one column counting the cards right. */
function summaryColumn(student: CategorizeStudent, b: Board, s: Strings): Column {
  const total = student.cards.length;
  return {
    key: "cards",
    label: s.cards,
    cell: ({ answer, details }) => {
      const verdicts = breakdownOf(details, "cards")?.cards;
      if (verdicts === undefined) {
        return <WordChip tone="neutral" text={fmt(s.placed, { placed: b.placesIn(answer).size, total })} />;
      }
      const right = verdicts.filter((card) => card.right).length;
      return <WordChip tone={countTone(right, total)} text={fmt(s.right, { right, total })} />;
    },
    expected: () => (
      <AnswerChip tone="expected" mono={false}>
        {fmt(s.total, { total })}
      </AnswerChip>
    ),
    // Where every card went, card after card: two identical boards sort
    // together, which is what grouping them will need.
    sortKey: (answer) => {
      const places = b.placesIn(answer);
      return gradingSortKey(
        student.cards
          .map((card) => {
            const place = places.get(card.id);
            return place === undefined ? "-" : b.text(place);
          })
          .join(" | "),
      );
    },
  };
}

/** One card's column: the column the student chose, tinted by that card's verdict. */
function cardColumn(
  card: CategorizeStudent["cards"][number],
  key: ReturnType<typeof keyOf> | null,
  b: Board,
  s: Strings,
): Column {
  const want = key?.get(card.id);
  return {
    key: `card-${card.id}`,
    ...headerOf(card.text, HEADER_CHARS),
    cell: ({ answer, details }) => {
      const place = b.placesIn(answer).get(card.id);
      if (place === undefined) return <Dash />;
      const right = breakdownOf(details, "cards")?.cards.find((c) => c.id === card.id)?.right;
      const text = b.text(place);
      return (
        <Fit>
          <AnswerChip tone={right === undefined ? "neutral" : right ? "good" : "bad"} title={text} mono={false}>
            {text}
          </AnswerChip>
        </Fit>
      );
    },
    expected: () => {
      if (key === null) return <Dash />;
      const text = want === undefined ? s.leftOut : b.text(want);
      return (
        <Fit>
          <AnswerChip tone="expected" title={text} mono={false}>
            {text}
          </AnswerChip>
        </Fit>
      );
    },
    sortKey: (answer) => {
      const place = b.placesIn(answer).get(card.id);
      return gradingSortKey(place === undefined ? "" : b.text(place));
    },
  };
}

export const categorizeGrading: QuestionTypeGrading<
  CategorizeStudent,
  CategorizeAnswer,
  CategorizeSolution,
  CategorizeDetails
> = {
  columns(student, solution, strings) {
    const s = resolveStrings(categorizeGradingStrings, strings);
    const b = board(student, s);
    if (student.cards.length > CATEGORIZE_GRADING_MAX_COLUMNS) return [summaryColumn(student, b, s)];
    const key = solution === null ? null : keyOf(solution.columns);
    return student.cards.map((card) => cardColumn(card, key, b, s));
  },
};
