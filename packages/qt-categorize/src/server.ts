/**
 * `@quiz/qt-categorize/server` — the server half of the `categorize` type,
 * shown as "Categorize" / « Classement » (docs/spec/04 §4.13, ADR-036).
 *
 * NOTHING in this module's import graph may reach React: it is loaded by the
 * API and by the grading worker. The browser half is `./client`.
 */
import { ConfigMigrationError, type QuestionTypeServer, type StudentView } from "@quiz/core/server";
import { shuffle, streamSeed } from "@quiz/core/rng";
import { categorizeGenerator } from "./generate.js";
import { gradeCategorize, negativeMarkingFrom } from "./grade.js";
import { placesOf } from "./placement.js";
import {
  CATEGORIZE_CONFIG_VERSION,
  CategorizeAnswerSchema,
  CategorizeConfigSchema,
  CategorizeDetailsSchema,
  CategorizeSolutionSchema,
  CategorizeStudentSchema,
  emptyCategorizeDraft,
  isCategorizeAnswered,
  type CategorizeAnswer,
  type CategorizeConfig,
  type CategorizeDetails,
  type CategorizeReviewDetails,
  type CategorizeSolution,
  type CategorizeStudent,
} from "./schema.js";

/**
 * The display order of a list, for one student.
 *
 * A permutation is never stored: it is recomputed from `(attempt.seed,
 * item.id, purpose)`, so a reload, the teacher preview and a regrade all show
 * the same order (decision D19). The cards and the columns draw from two
 * streams, so switching one shuffle on does not reorder the other.
 */
function displayOrder<T>(items: readonly T[], on: boolean, view: StudentView, purpose: string): T[] {
  return view.shuffle && on ? shuffle(items, streamSeed(view.seed, view.itemId, purpose)) : [...items];
}

export const categorizeServer: QuestionTypeServer<
  CategorizeConfig,
  CategorizeAnswer,
  CategorizeStudent,
  CategorizeSolution,
  CategorizeDetails
> = {
  id: "categorize",
  configVersion: CATEGORIZE_CONFIG_VERSION,

  configSchema: CategorizeConfigSchema,
  answerSchema: CategorizeAnswerSchema,
  isAnswered: isCategorizeAnswered,
  studentSchema: CategorizeStudentSchema,
  solutionSchema: CategorizeSolutionSchema,
  detailsSchema: CategorizeDetailsSchema,

  emptyDraft: emptyCategorizeDraft,

  migrate(config: unknown, fromVersion: number): CategorizeConfig {
    if (fromVersion === CATEGORIZE_CONFIG_VERSION) return config as CategorizeConfig;
    throw new ConfigMigrationError("categorize", fromVersion, CATEGORIZE_CONFIG_VERSION, "unknown source version");
  },

  defaultPoints: () => 1,

  shuffleable: (config) =>
    (config.shuffleCards && config.cards.length > 1) || (config.shuffleColumns && config.columns.length > 1),

  /**
   * THE single exit toward a student (invariant 4). The columns go WITHOUT
   * their `cards` — that list is the key — and the policy stays home, as it
   * does for `mcq`. What the student is told is whether the order counts (a
   * rule they must know to answer) and the evaluation's negative marking.
   *
   * With the card shuffle off, the cards keep the teacher's order: that is a
   * choice the teacher makes in the editor, knowing it is what students see.
   */
  toStudent(config, view): CategorizeStudent {
    const student: CategorizeStudent = {
      prompt: config.prompt,
      columns: displayOrder(config.columns, config.shuffleColumns, view, "columns").map((column) => ({
        id: column.id,
        label: column.label,
      })),
      cards: displayOrder(config.cards, config.shuffleCards, view, "cards").map((card) => ({
        id: card.id,
        text: card.text,
      })),
      ordered: config.ordered,
    };
    if (negativeMarkingFrom(view.defaults)) student.negativeMarking = true;
    return student;
  },

  toSolution: (config) => ({
    columns: config.columns.map((column) => ({ id: column.id, cards: [...column.cards] })),
  }),

  /**
   * One card, one column. The player cannot send anything else; a crafted
   * write can, and a card placed in every column at once would otherwise be
   * a free bet. The grader still reads such an answer (first place wins).
   */
  answerMisfit(config, answer) {
    const columns = new Set(config.columns.map((column) => column.id));
    const cards = new Set(config.cards.map((card) => card.id));
    const seen = new Set<string>();
    for (const [column, ids] of Object.entries(answer.columns)) {
      if (!columns.has(column)) return "categorize.answer_misfit";
      for (const id of ids) {
        if (!cards.has(id) || seen.has(id)) return "categorize.answer_misfit";
        seen.add(id);
      }
    }
    return null;
  },

  /**
   * Without the published key, the breakdown keeps only what the student's
   * OWN placements say (invariant 4):
   *
   *  - `expected` and `expectedRank` go from every card — they are the key;
   *  - `right` goes from every card the student left in the tray: "right"
   *    there means "a distractor", "wrong" means "a target", which is the key
   *    again, one card at a time;
   *  - `T` and `D` go: together they count the distractors.
   *
   * `t`, `x`, `p` and the fraction stay: they are the student's own score,
   * and a verdict on a card the student placed is the grade itself.
   */
  studentDetails(details, policy): CategorizeReviewDetails {
    if (policy.showKey) return details;
    const { T: _T, D: _D, ...rest } = details;
    return {
      ...rest,
      cards: details.cards.map(({ expected: _expected, expectedRank: _rank, right, ...card }) =>
        card.placed === null ? card : { ...card, right },
      ),
    };
  },

  // `ctx.defaults` carries the EVALUATION's per-type settings; the grader
  // reads its own `categorize` entry to resolve an `inherit` config.
  grade: (config, answer, ctx) => gradeCategorize(config, answer, ctx.itemPoints, ctx.defaults),

  /**
   * The live grid (F-DASH-02): how many cards are placed, out of how many —
   * "5/9". Figures only: the cell is not translated, and it says nothing of
   * whether a card is right.
   */
  summarizeAnswer: (config, answer) => `${placesOf(config, answer).size}/${config.cards.length}`,

  /*
   * No `aggregate`: the hook receives the answers and their gradings but not
   * the config, so a distribution could only be keyed on opaque ids, which a
   * teacher cannot read. The item keeps its success rate.
   */

  searchText: (config) =>
    [config.prompt, ...config.columns.map((c) => c.label), ...config.cards.map((c) => c.text)].join("\n"),

  generator: categorizeGenerator,
};
