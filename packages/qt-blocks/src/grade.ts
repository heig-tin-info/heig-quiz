/**
 * Grading a `blocks` answer (docs/spec/04 §4.17, ADR-103 §2): the program
 * runs on every warehouse through `@quiz/domain/blocks`, the interpreter the
 * player animates; a warehouse passes when its run ends at the dock. As
 * `code`: the points of the cases that passed, or all or nothing.
 *
 * Synchronous and final (`state: "validated"`): no runner, no proposal.
 * Pure: no React, no Blockly.
 */
import type { GradedResult } from "@quiz/core/server";
import { parseMap, runProgram, type RunResult, type Stmt } from "@quiz/domain/blocks";
import { round2 } from "@quiz/domain/round";

import {
  kindsOutside,
  totalCasePoints,
  type BlocksAnswer,
  type BlocksCase,
  type BlocksConfig,
  type BlocksDetails,
  type BlocksReviewDetails,
  type CaseResult,
} from "./schema.js";

/**
 * One program on one warehouse. The trace (`events`) is the animation's;
 * the grader asks for none.
 */
export function runCase(
  program: Stmt[],
  kase: Pick<BlocksCase, "map" | "battery">,
  options: { events?: boolean } = {},
): RunResult {
  return runProgram(program, parseMap(kase.map), kase.battery, options);
}

/** The answer key's misfit: a program using a block the toolbox does not offer. */
export function answerMisfit(config: Pick<BlocksConfig, "toolbox">, answer: BlocksAnswer): string | null {
  return kindsOutside(answer.program, config.toolbox).length > 0 ? "blocks.answer_misfit" : null;
}

export function gradeBlocks(
  config: BlocksConfig,
  answer: BlocksAnswer | null,
  itemPoints: number,
): GradedResult<BlocksDetails> {
  // The write refuses a misfit; the grader still defends itself (an answer
  // stored before the toolbox changed) by running nothing at all.
  const misfit = answer === null ? null : answerMisfit(config, answer);
  const program = answer === null || misfit !== null ? [] : answer.program;
  const cases = config.cases.map((kase): CaseResult => {
    const run = runCase(program, kase, { events: false });
    return {
      name: kase.name,
      visible: kase.visible,
      points: kase.points,
      ok: run.ok,
      reason: run.reason,
      moves: run.moves,
      trail: run.trail,
    };
  });
  const total = totalCasePoints(config.cases);
  const earned = totalCasePoints(cases.filter((c) => c.ok));
  const fraction = config.allOrNothing ? (earned === total && total > 0 ? 1 : 0) : total > 0 ? earned / total : 0;
  return {
    kind: "graded",
    points: round2(fraction * itemPoints),
    maxPoints: itemPoints,
    details: { cases, earned, total },
    state: "validated",
    ...(misfit === null ? {} : { comment: misfit }),
  };
}

/**
 * The details a STUDENT may read without the key (spec 4.17, ADR-096 §5). A
 * visible case travels whole: its map is published already. A hidden case
 * keeps its verdict, its points and the coarse reason, and loses its trail
 * and its move count — a trace on a hidden map draws the map; its name too,
 * unless the policy opens the names.
 */
export function studentDetails(
  details: BlocksDetails,
  options: { showHiddenCaseNames?: boolean } = {},
): BlocksReviewDetails {
  const show = options.showHiddenCaseNames === true;
  return {
    ...details,
    cases: details.cases.map((c, i) =>
      c.visible
        ? c
        : { name: show ? c.name : `#${i + 1}`, visible: false, points: c.points, ok: c.ok, reason: c.reason },
    ),
  };
}
