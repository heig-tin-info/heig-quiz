/**
 * Digital logic (issue #459, ADR-123): the netlist, the event-driven engine,
 * the boolean expressions and the exhaustive check of a combinational
 * circuit, the test vectors and the step-by-step check of a sequential one.
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
  type CellKind,
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
  type VectorErrorCode,
} from "./logic/netlist.js";
export { compileNetlist, type CompiledNetlist, type SettleResult, type Simulator } from "./logic/simulator.js";
export { evaluate, parseExpression, toLatex, type Expr } from "./logic/expression.js";
export {
  checkCombinational,
  checkSequential,
  type CombinationalCheck,
  type CombinationalRow,
  type SequentialCheck,
  type SequentialRow,
} from "./logic/check.js";
export {
  checksOutput,
  parseVectors,
  type TestVectors,
  type VectorInput,
  type VectorOutput,
  type VectorRow,
} from "./logic/vectors.js";
