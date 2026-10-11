/**
 * The sentence for an expression that could not be read, shared by the
 * editor (a key), the player (the live echo) and the review (the verdict).
 * No parser here: the review says a problem the server already decided.
 */
import { fmt } from "@quiz/core/client";
import type { MathProblem } from "@quiz/domain/math";

import type { mathProblemStrings } from "./strings.js";

export type ProblemStrings = Readonly<Record<keyof typeof mathProblemStrings, string>>;

export function problemText(s: ProblemStrings, problem: MathProblem, symbols: readonly string[]): string {
  switch (problem.code) {
    case "empty":
      return s.problemEmpty;
    case "too_long":
      return fmt(s.problemTooLong, { max: problem.max });
    case "syntax":
      return s.problemSyntax;
    case "unknown_symbol":
      return fmt(s.problemUnknownSymbol, { names: problem.names.join(", "), symbols: symbols.join(", ") });
    case "unsupported":
      return fmt(s.problemUnsupported, { names: problem.names.join(", ") });
    case "forbidden_function":
      return fmt(s.problemForbiddenFunction, { names: problem.names.join(", ") });
  }
}
