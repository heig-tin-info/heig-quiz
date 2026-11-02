/**
 * The grade of a `logic` answer (docs/spec/04 §4.18, ADR-123 §6), in process
 * and final: the netlist rebuilt from the stored schematic, then either every
 * row of the truth table simulated from a fresh state (`checkCombinational`),
 * against the expressions or the reference circuit, simulated the same way,
 * or the test vectors' steps run in order on one simulator
 * (`checkSequential`); the points the share of rows whose checked outputs
 * are ALL right.
 *
 * Two answers are never simulated and get 0, stored `proposed` as `circuit`
 * does: `ports_mismatch` (the terminals differ from the declared ones) and
 * `palette_violation` (a gate the question does not allow, or too many). The
 * editor produces neither, so the answer is stale or forged, and the teacher
 * decides.
 */
import type { GradeContext, GradeResult, StudentDetailsPolicy } from "@quiz/core/server";
import { zeroGrade } from "@quiz/core/server";
import {
  checkCombinational,
  checkSequential,
  checksOutput,
  circuitKey,
  expressionKey,
  LogicError,
  parseExpression,
  parseVectors,
  type CombinationalCheck,
  type CombinationalKey,
  type Netlist,
  type SequentialCheck,
} from "@quiz/domain/logic";
import { round2 } from "@quiz/domain/round";

import { buildLogicNetlist, paletteViolation, portsMismatch } from "./logicNetlist.js";
import {
  declaredOf,
  FAILING_ROWS_MAX,
  isLogicAnswered,
  type LogicAnswer,
  type LogicConfig,
  type LogicDetails,
} from "./logicSchema.js";

/** The rows a grade counts: every row of the truth table, or every step that checks an output. */
function rowsOf(config: LogicConfig): number {
  return config.mode === "sequential"
    ? parseVectors(config.vectors, declaredOf(config)).rows.filter(checksOutput).length
    : 2 ** config.inputs.length;
}

function nothing(config: LogicConfig, reason: string): LogicDetails {
  return {
    inputs: [...config.inputs],
    outputs: config.outputs.map((o) => ({ name: o.name, rate: 0 })),
    right: 0,
    total: rowsOf(config),
    rows: [],
    reason,
  };
}

/**
 * A combinational question's key: the expressions, or the reference circuit
 * rebuilt into a netlist here, never stored, simulated once per row
 * (`circuitKey`). Publication guarantees it reads a level on every row.
 */
function combinationalKey(config: LogicConfig): CombinationalKey {
  const outputs = config.outputs.map((o) => o.name);
  if (config.keyFrom === "reference") {
    if (config.reference === null) throw new Error("logic: a reference key without a reference circuit");
    return circuitKey(buildLogicNetlist(config.reference).netlist, config.inputs, outputs);
  }
  return expressionKey(Object.fromEntries(config.outputs.map((o) => [o.name, parseExpression(o.expression, config.inputs)])));
}

/** The circuit against the question's key. */
function check(config: LogicConfig, netlist: Netlist): CombinationalCheck | SequentialCheck {
  if (config.mode === "sequential") return checkSequential(netlist, parseVectors(config.vectors, declaredOf(config)));
  return checkCombinational(netlist, combinationalKey(config), config.inputs);
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

  let checked: CombinationalCheck | SequentialCheck;
  try {
    checked = check(config, buildLogicNetlist(answer.schematic).netlist);
  } catch (error) {
    // A draft tried before its reference reads a level on every row (publication refuses it): nothing to compare with.
    if (error instanceof LogicError && error.code === "logic.reference_undefined") {
      return zeroGrade(ctx, nothing(config, "reference_undefined"), "proposed");
    }
    throw error;
  }
  const { inputs, outputs, rows } = checked;
  const right = rows.filter((row) => row.ok.every(Boolean)).length;
  const total = rows.length;
  /** Over the rows that check output `k` (every row, but for a step's don't cares). */
  const rate = (k: number): number => {
    const checked = rows.filter((row) => row.expected[k] !== "X");
    return checked.length === 0 ? 1 : checked.filter((row) => row.ok[k]).length / checked.length;
  };
  const details: LogicDetails = {
    inputs,
    outputs: outputs.map((name, k) => ({ name, rate: rate(k) })),
    right,
    total,
    rows: rows
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
