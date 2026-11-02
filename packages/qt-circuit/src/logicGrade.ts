/**
 * The grade of a `logic` answer (docs/spec/04 §4.18, ADR-123 §6), in process
 * and final: the netlist rebuilt from the stored schematic, every row of the
 * truth table simulated from a fresh state by `checkCombinational`, the
 * points the share of rows whose outputs are ALL right.
 *
 * Two answers are never simulated and get 0, stored `proposed` as `circuit`
 * does: `ports_mismatch` (the terminals differ from the declared ones) and
 * `palette_violation` (a gate the question does not allow, or too many). The
 * editor produces neither, so the answer is stale or forged, and the teacher
 * decides.
 */
import type { GradeContext, GradeResult, StudentDetailsPolicy } from "@quiz/core/server";
import { zeroGrade } from "@quiz/core/server";
import { checkCombinational, parseExpression } from "@quiz/domain/logic";
import { round2 } from "@quiz/domain/round";

import { buildLogicNetlist, paletteViolation, portsMismatch } from "./logicNetlist.js";
import {
  FAILING_ROWS_MAX,
  isLogicAnswered,
  type LogicAnswer,
  type LogicConfig,
  type LogicDetails,
} from "./logicSchema.js";

function nothing(config: LogicConfig, reason: string): LogicDetails {
  return {
    inputs: [...config.inputs],
    outputs: config.outputs.map((o) => ({ name: o.name, rate: 0 })),
    right: 0,
    total: 2 ** config.inputs.length,
    rows: [],
    reason,
  };
}

export function gradeLogic(
  config: LogicConfig,
  answer: LogicAnswer | null,
  ctx: GradeContext,
): GradeResult<LogicDetails> {
  if (answer === null || !isLogicAnswered(answer)) return zeroGrade(ctx, nothing(config, "empty"), "validated");
  const declared = { inputs: config.inputs, outputs: config.outputs.map((o) => o.name) };
  if (portsMismatch(answer.schematic, declared)) {
    return zeroGrade(ctx, nothing(config, "ports_mismatch"), "proposed", "ports_mismatch");
  }
  if (paletteViolation(answer.schematic, config.palette)) {
    return zeroGrade(ctx, nothing(config, "palette_violation"), "proposed", "palette_violation");
  }

  const exprs = Object.fromEntries(config.outputs.map((o) => [o.name, parseExpression(o.expression, config.inputs)]));
  const check = checkCombinational(buildLogicNetlist(answer.schematic).netlist, exprs, config.inputs);
  const right = check.rows.filter((row) => row.ok.every(Boolean)).length;
  const total = check.rows.length;
  const details: LogicDetails = {
    inputs: check.inputs,
    outputs: check.outputs.map((name, k) => ({
      name,
      rate: check.rows.filter((row) => row.ok[k]).length / total,
    })),
    right,
    total,
    rows: check.rows
      .filter((row) => !row.ok.every(Boolean))
      .slice(0, FAILING_ROWS_MAX)
      .map(({ inputs, actual, expected }) => ({ inputs, actual, expected })),
  };
  return {
    kind: "graded",
    points: round2((right / total) * ctx.itemPoints),
    maxPoints: ctx.itemPoints,
    details,
    state: "validated",
  };
}

/**
 * What a student reads of the details (invariant 4): with 0/1 values, a
 * failing row's student outputs reveal the expected ones, so the rows go
 * only under a shown key; otherwise the score, the right rows and each
 * output's rate.
 */
export function logicStudentDetails(details: LogicDetails, policy: Pick<StudentDetailsPolicy, "showKey">): LogicDetails {
  if (policy.showKey) return details;
  const { rows: _rows, ...rest } = details;
  return rest;
}
