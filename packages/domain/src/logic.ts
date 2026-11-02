/**
 * Combinational digital logic (issue #459, ADR-123): the netlist, the
 * event-driven engine, the boolean expressions and the exhaustive check.
 * Pure (invariant 8): the browser animates with it, the server grades with it.
 *
 * This file is the module's ONLY entry point (`@quiz/domain/logic`);
 * `./logic/*` is internal. It is not in the package barrel: its names
 * (`evaluate`, `Value`) are generic, a subpath keeps them apart.
 */
export {
  CELL_SPECS,
  cellInputs,
  LOGIC_LIMITS,
  LogicError,
  validateNetlist,
  type Bit,
  type CellSpec,
  type CellType,
  type LogicErrorCode,
  type Netlist,
  type NetlistCell,
  type NetlistIssue,
  type NetlistIssueCode,
  type NetlistPort,
  type NetId,
  type Value,
} from "./logic/netlist.js";
export { compileNetlist, type CompiledNetlist, type SettleResult, type Simulator } from "./logic/simulator.js";
export { evaluate, parseExpression, toLatex, type Expr } from "./logic/expression.js";
export { checkCombinational, type CombinationalCheck, type CombinationalRow } from "./logic/check.js";
