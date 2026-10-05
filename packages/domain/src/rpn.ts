/**
 * The RPN engine of the on-screen calculator (ADR-069, amended): the same
 * keys as the infix one, read the way an HP reads them. A number is typed,
 * `enter` puts it on the stack, an operator takes the top two values and
 * leaves its result: `3 enter 4 +` is 7, and there is no `=` nor `(`.
 *
 * It is a pure reducer like `press`, and it shares what is not about the
 * stack with `./calculator.ts`: the arithmetic, the trigonometry, the
 * digits being typed and the precision of a pocket calculator.
 */
import {
  appendDigit,
  appendDot,
  binary,
  CalcFailure,
  CONSTANTS,
  formatNumber,
  negateTyped,
  settle,
  trigValue,
  unary,
  type AngleUnit,
  type CalculatorError,
  type CalculatorKey,
} from "./calculator.js";

export interface RpnState {
  /** The values entered, the top last. */
  stack: number[];
  /** The number being typed, which is not on the stack yet. */
  entry: string | null;
  error: CalculatorError | null;
  unit: AngleUnit;
  second: boolean;
  hyp: boolean;
}

export const initialRpn: RpnState = {
  stack: [],
  entry: null,
  error: null,
  unit: "deg",
  second: false,
  hyp: false,
};

/** How many levels of the stack the screen shows above the number. */
const STACK_LEVELS = 3;

const fresh = (s: RpnState): RpnState => ({ ...initialRpn, unit: s.unit, second: s.second, hyp: s.hyp });

/** The stack with the number being typed put on it. */
function committed(s: RpnState): number[] {
  return s.entry === null ? s.stack : [...s.stack, parseFloat(s.entry)];
}

function need(stack: number[], n: number): void {
  if (stack.length < n) throw new CalcFailure("operands");
}

/** The state a result leaves: nothing being typed, the result on top. */
const result = (s: RpnState, stack: number[]): RpnState => ({ ...s, stack, entry: null });

function apply(state: RpnState, key: CalculatorKey): RpnState {
  const typing = (edit: (t: string) => string): RpnState => {
    const base = state.error ? fresh(state) : state;
    return { ...base, entry: edit(base.entry ?? "0") };
  };
  switch (key.kind) {
    case "digit":
      return typing((t) => appendDigit(t, key.digit));
    case "dot":
      return typing(appendDot);
    case "unit":
      return { ...state, unit: state.unit === "deg" ? "rad" : "deg" };
    case "second":
      return { ...state, second: !state.second };
    case "hyp":
      return { ...state, hyp: !state.hyp };
    case "clear":
      return fresh(state);
    case "clearEntry":
      // Clears x: the number being typed, or the top of the stack.
      if (state.error) return fresh(state);
      return state.entry !== null ? { ...state, entry: null } : { ...state, stack: state.stack.slice(0, -1) };
    case "back": {
      if (state.error) return fresh(state);
      if (state.entry === null) return state;
      const t = /e[+-]$/.test(state.entry) ? state.entry.slice(0, -2) : state.entry.slice(0, -1);
      return { ...state, entry: t === "" || t === "-" ? null : t };
    }
    case "exp":
      return state.entry === null || state.entry.includes("e") ? state : { ...state, entry: `${state.entry}e+` };
    default:
      break;
  }
  if (state.error) return state;
  switch (key.kind) {
    case "const":
      return result(state, [...committed(state), CONSTANTS[key.name].value]);
    case "enter": {
      const stack = committed(state);
      // `enter` with nothing being typed duplicates the top.
      return result(state, state.entry === null && stack.length > 0 ? [...stack, stack.at(-1)!] : stack);
    }
    case "swap": {
      const stack = committed(state);
      need(stack, 2);
      return result(state, [...stack.slice(0, -2), stack.at(-1)!, stack.at(-2)!]);
    }
    case "roll": {
      // R↓ of the HP: the top goes to the bottom, so every value comes up a level.
      const stack = committed(state);
      return result(state, stack.length < 2 ? stack : [stack.at(-1)!, ...stack.slice(0, -1)]);
    }
    case "op": {
      const stack = committed(state);
      need(stack, 2);
      return result(state, [...stack.slice(0, -2), settle(binary(key.op, stack.at(-2)!, stack.at(-1)!))]);
    }
    case "fn": {
      if (key.fn === "neg" && state.entry !== null) return { ...state, entry: negateTyped(state.entry) };
      const stack = committed(state);
      return result(state, [...stack.slice(0, -1), settle(unary(key.fn, stack.at(-1) ?? 0))]);
    }
    case "trig": {
      const stack = committed(state);
      return result(state, [...stack.slice(0, -1), trigValue(key.fn, stack.at(-1) ?? 0, state)]);
    }
    // `%`, `(`, `)` and `=` belong to the infix keypad: the RPN one does not draw them.
    default:
      return state;
  }
}

/** The next state of the calculator. An impossible operation is an error state, never a throw. */
export function pressRpn(state: RpnState, key: CalculatorKey): RpnState {
  try {
    return apply(state, key);
  } catch (e) {
    if (!(e instanceof CalcFailure)) throw e;
    return { ...fresh(state), error: e.code };
  }
}

/** The big line: the number being typed, or the top of the stack. */
export function displayRpn(state: RpnState): string {
  return state.entry ?? formatNumber(state.stack.at(-1) ?? 0);
}

/**
 * The three levels above the one displayed, the nearest last: what the
 * stack holds besides the big line, so the numbers an operator is about to
 * take are in front of the eyes.
 */
export function levelsRpn(state: RpnState): string[] {
  const below = state.entry === null ? state.stack.slice(0, -1) : state.stack;
  return below.slice(-STACK_LEVELS).map(formatNumber);
}
