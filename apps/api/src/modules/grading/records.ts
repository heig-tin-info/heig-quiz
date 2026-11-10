/**
 * What every file of the `grading` module shares: the row type, the
 * newest-first order of a cell's history, the module's refusals and the key
 * of a grid cell.
 */
import { desc, sql } from "drizzle-orm";

import { attempts, gradings } from "../../db/schema.js";
import { refusalClass, type Refusal } from "../http.js";

export type GradingRecord = typeof gradings.$inferSelect;
export type AttemptRecord = typeof attempts.$inferSelect;

/**
 * "Newest first", made total. Two gradings written in the same millisecond —
 * the automatic pass and the override a teacher pressed right after it, on a
 * clock a test holds still — would otherwise come back in an arbitrary order.
 * A superseded grading is never newer than the one that replaced it, so that
 * is the tiebreaker.
 */
export const NEWEST_FIRST = [
  desc(gradings.gradedAt),
  sql`case when ${gradings.state} = 'superseded' then 1 else 0 end`,
] as const;

// --- Failures -------------------------------------------------------------

/**
 * Everything this module refuses, by code: its status and, where the
 * refusal reads the same wherever it is thrown, its message.
 */
const REFUSALS = {
  // F-GRADE-05: overriding a correction without saying why is not allowed.
  comment_required: [422, "a manual override must carry a comment"],
  // F-GRADE-05 (ADR-026): a manual score outside what the item can be worth —
  // `[0, max]`, or `[-max, max]` for a choice question under negative marking.
  points_out_of_range: [422],
  not_pending: [409, "this grading is not a proposal any more"],
  // A regrade with a version whose variables are not the item's (ADR-056 §5):
  // the values the students were served could not be read under it, so the
  // item keeps its version and nothing is regraded.
  variables_changed: [409, "the version declares other variables than the item's"],
  // Audit L2: an item the model grades is re-graded at most
  // `LLM_REGRADES_PER_ITEM_PER_DAY` times a day; the code is the gateway's.
  llm_budget_exhausted: [429, "this item was re-graded by the model as often as a day allows: try again tomorrow"],
  // ADR-118 §6: the points per criterion name every criterion of the item
  // exactly once, each within its maximum; an essay with criteria is graded
  // by them, never by a bare total; an item without criteria takes none.
  criteria_invalid: [422, "the points per criterion do not match the item's criteria"],
  // F-EXP-01 (ADR-121 §2): the Markdown export of an item whose type does not
  // render as text, or of a parameterized one; its JSON record still exists.
  not_exportable: [409, "this question does not export as text"],
  // ADR-128: accepting an answer at grading time — never on a poll nor for a
  // type that takes none, only once the item list is frozen (as ADR-108),
  // only for one student on a parameterized question, and only an answer
  // the part can hold.
  acceptance_unavailable: [409, "this question cannot accept an answer"],
  acceptance_not_frozen: [409, "an answer is accepted once the item list is frozen"],
  acceptance_scope: [422, "this answer is accepted for one student only"],
  acceptance_invalid: [422, "this part of the question cannot hold this answer"],
} satisfies Record<string, Refusal>;

export class GradingError extends refusalClass("GradingError", REFUSALS) {}

// --- Keys -----------------------------------------------------------------

/** A grading addresses a CELL of the grid, not an answer: an absent answer is graded too. */
export type PairKey = `${string}:${string}`;
export const pairKey = (attemptId: string, itemId: string): PairKey =>
  `${attemptId}:${itemId}`;
