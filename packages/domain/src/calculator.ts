/**
 * The engine of the on-screen calculator an evaluation provides (ADR-069;
 * which one, `calculatorOn` in `./evaluationConfig.ts`).
 *
 * The engine is a pure reducer: a state and a key give the next state, and
 * the screen only renders `display` and `expression`. It reads like the
 * Windows calculator — the expression above, the operand being formed below,
 * a function applied to that operand at once (`sin(30)` shows `0.5`) — with
 * one difference, settled by the product owner on 2026-10-04: BOTH modes
 * respect the order of operations (`2 + 3 × 4 = 14`), where Windows's
 * standard mode computes from left to right.
 *
 * Numbers are binary floats, written with 15 significant digits (one fewer
 * than a double holds), so `0.1 + 0.2` reads 0.3 and `1 / 3 × 3` reads 1; a
 * sum that cancels to float noise is 0, and a degree angle on a quarter turn
 * is exact (`sin(180°)` is 0, `tan(90°)` has no value). The precision of a
 * pocket calculator, without a decimal library.
 */
export type AngleUnit = "deg" | "rad";

export type BinaryOp = "+" | "-" | "*" | "/" | "^" | "mod" | "root" | "logBase";

export type UnaryFn =
  | "neg"
  | "sqr"
  | "cube"
  | "sqrt"
  | "cbrt"
  | "inv"
  | "abs"
  | "fact"
  | "pow10"
  | "pow2"
  | "powE"
  | "log"
  | "ln";

/** The six trigonometric keys; `second` and `hyp` pick the variant. */
export type TrigFn = "sin" | "cos" | "tan" | "sec" | "csc" | "cot";

export type CalculatorError = "divideByZero" | "invalid" | "overflow";

export type CalculatorKey =
  | { kind: "digit"; digit: number }
  | { kind: "dot" }
  | { kind: "exp" }
  | { kind: "back" }
  | { kind: "clearEntry" }
  | { kind: "clear" }
  | { kind: "op"; op: BinaryOp }
  | { kind: "fn"; fn: UnaryFn }
  | { kind: "trig"; fn: TrigFn }
  | { kind: "const"; name: "pi" | "e" }
  | { kind: "percent" }
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "equals" }
  | { kind: "unit" }
  | { kind: "second" }
  | { kind: "hyp" };

interface Operand {
  value: number;
  label: string;
}

type Token = ({ kind: "num" } & Operand) | { kind: "op"; op: BinaryOp } | { kind: "open" };

/** The operand being formed: digits as typed, or a value a key computed. */
type Entry = { kind: "typed"; text: string } | ({ kind: "value" } & Operand);

export interface CalculatorState {
  /** The committed expression; it always ends with an operator or `(`. */
  tokens: Token[];
  entry: Entry | null;
  /** `=` was the last key: the next digit starts a new expression. */
  done: boolean;
  /** The expression `=` evaluated, shown above its result. */
  last: string | null;
  error: CalculatorError | null;
  unit: AngleUnit;
  second: boolean;
  hyp: boolean;
}

export const initialCalculator: CalculatorState = {
  tokens: [],
  entry: null,
  done: false,
  last: null,
  error: null,
  unit: "deg",
  second: false,
  hyp: false,
};

/** Digits a typed operand may hold, like the 16 of Windows. */
const MAX_DIGITS = 16;

const OP_LABEL: Record<BinaryOp, string> = {
  "+": "+",
  "-": "−",
  "*": "×",
  "/": "÷",
  "^": "^",
  mod: "mod",
  root: "ʸ√",
  logBase: "logᵧ",
};

const PRECEDENCE: Record<BinaryOp, number> = {
  "+": 1,
  "-": 1,
  "*": 2,
  "/": 2,
  mod: 2,
  "^": 3,
  root: 3,
  logBase: 3,
};

class CalcFailure extends Error {
  constructor(readonly code: CalculatorError) {
    super(code);
  }
}

/** A result the calculator can go on with: a number, and a finite one. */
function settle(v: number): number {
  if (Number.isNaN(v)) throw new CalcFailure("invalid");
  if (!Number.isFinite(v)) throw new CalcFailure("overflow");
  return v;
}

/**
 * A sum or a difference that cancels down to float noise is zero:
 * `0.1 + 0.2 − 0.3` is 0, not 5.55e-17.
 */
function cancel(r: number, a: number, b: number): number {
  return Math.abs(r) < 1e-13 * Math.max(Math.abs(a), Math.abs(b)) ? 0 : r;
}

/**
 * How a number is written: its 15 significant digits, in their shortest
 * form, so the noise in the 16th never shows (`0.1 + 0.2` reads 0.3).
 */
export function formatNumber(v: number): string {
  const r = Number(v.toPrecision(15));
  return String(r === 0 ? 0 : r);
}

function binary(op: BinaryOp, a: number, b: number): number {
  switch (op) {
    case "+":
      return cancel(a + b, a, b);
    case "-":
      return cancel(a - b, a, b);
    case "*":
      return a * b;
    case "/":
      if (b === 0) throw new CalcFailure("divideByZero");
      return a / b;
    case "mod":
      if (b === 0) throw new CalcFailure("divideByZero");
      return a % b;
    case "^":
      return a ** b;
    case "root":
      if (b === 0) throw new CalcFailure("invalid");
      // An odd root of a negative number is real: ∛(−8) = −2.
      if (a < 0 && Number.isInteger(b) && Math.abs(b) % 2 === 1) return -((-a) ** (1 / b));
      return a ** (1 / b);
    case "logBase":
      if (a <= 0 || b <= 0 || b === 1) throw new CalcFailure("invalid");
      return Math.log(a) / Math.log(b);
  }
}

function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) throw new CalcFailure("invalid");
  if (n > 170) throw new CalcFailure("overflow");
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function unary(fn: UnaryFn, x: number): number {
  switch (fn) {
    case "neg":
      return -x;
    case "sqr":
      return x * x;
    case "cube":
      return x * x * x;
    case "sqrt":
      if (x < 0) throw new CalcFailure("invalid");
      return Math.sqrt(x);
    case "cbrt":
      return Math.cbrt(x);
    case "inv":
      if (x === 0) throw new CalcFailure("divideByZero");
      return 1 / x;
    case "abs":
      return Math.abs(x);
    case "fact":
      return factorial(x);
    case "pow10":
      return 10 ** x;
    case "pow2":
      return 2 ** x;
    case "powE":
      return Math.exp(x);
    case "log":
    case "ln":
      if (x <= 0) throw new CalcFailure("invalid");
      return fn === "log" ? Math.log10(x) : Math.log(x);
  }
}

/**
 * How a function is written around its operand, in symbols only: the
 * expression line is mathematics, read the same in every language, so no
 * English word (`negate`, `cube`) reaches a French student untranslated.
 */
const FN_LABEL: Record<UnaryFn, (x: string) => string> = {
  neg: (x) => `−(${x})`,
  sqr: (x) => `${postfixOperand(x)}²`,
  cube: (x) => `${postfixOperand(x)}³`,
  sqrt: (x) => `√(${x})`,
  cbrt: (x) => `∛(${x})`,
  inv: (x) => `1/(${x})`,
  abs: (x) => `|${x}|`,
  fact: (x) => `${postfixOperand(x)}!`,
  pow10: (x) => `10^(${x})`,
  pow2: (x) => `2^(${x})`,
  powE: (x) => `e^(${x})`,
  log: (x) => `log(${x})`,
  ln: (x) => `ln(${x})`,
};

/** An operand under a postfix sign: a negative number or an exponent form takes parentheses. */
const postfixOperand = (x: string) => (/^[0-9.π]+$|^e$|\)$|\|$/.test(x) ? x : `(${x})`);

/** sin and cos of an angle in the current unit, exact on the quarter turns of a degree angle. */
function sinCos(x: number, unit: AngleUnit): [number, number] {
  if (unit === "deg") {
    const a = ((x % 360) + 360) % 360;
    const quarter = [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ] as const;
    if (a % 90 === 0) return [...quarter[a / 90]!];
    const r = (a * Math.PI) / 180;
    return [Math.sin(r), Math.cos(r)];
  }
  // A sine or cosine 1e15 times smaller than its angle is the noise of π, not
  // a value: cos(π/2) is 0, and tan(π/2) has no value rather than a huge one;
  // sin(1e-16) stays 1e-16.
  const zero = (v: number) => (Math.abs(v) < 1e-15 * Math.abs(x) ? 0 : v);
  return [zero(Math.sin(x)), zero(Math.cos(x))];
}

const ratio = (n: number, d: number) => {
  if (d === 0) throw new CalcFailure("invalid");
  return n / d;
};

/** The six circular functions, from the sine and cosine of the angle. */
function circular(fn: TrigFn, x: number, unit: AngleUnit): number {
  const [s, c] = sinCos(x, unit);
  switch (fn) {
    case "sin":
      return s;
    case "cos":
      return c;
    case "tan":
      return ratio(s, c);
    case "sec":
      return ratio(1, c);
    case "csc":
      return ratio(1, s);
    case "cot":
      return ratio(c, s);
  }
}

/**
 * The six hyperbolic functions, each from its own `Math` function: sinh and
 * cosh overflow together, and tanh(800) is 1, not ∞ / ∞.
 */
function hyperbolic(fn: TrigFn, x: number): number {
  switch (fn) {
    case "sin":
      return Math.sinh(x);
    case "cos":
      return Math.cosh(x);
    case "tan":
      return Math.tanh(x);
    case "sec":
      return 1 / Math.cosh(x);
    case "csc":
      return ratio(1, Math.sinh(x));
    case "cot":
      return ratio(1, Math.tanh(x));
  }
}

/** The base function an inverse key reduces to: asec(x) = acos(1/x), and so on. */
const RECIPROCAL: Partial<Record<TrigFn, TrigFn>> = { sec: "cos", csc: "sin", cot: "tan" };

function inverse(fn: TrigFn, x: number, unit: AngleUnit, hyp: boolean): number {
  // 1/0 is ∞, which every base function takes as it should: acot(0) is a
  // quarter turn, asec(0) has no value.
  const reciprocal = RECIPROCAL[fn];
  if (reciprocal !== undefined) return inverse(reciprocal, 1 / x, unit, hyp);
  if (hyp) {
    const f = { sin: Math.asinh, cos: Math.acosh, tan: Math.atanh }[fn as "sin" | "cos" | "tan"];
    return f(x);
  }
  const f = { sin: Math.asin, cos: Math.acos, tan: Math.atan }[fn as "sin" | "cos" | "tan"];
  const r = f(x);
  return unit === "deg" ? (r * 180) / Math.PI : r;
}

/**
 * `sin(30°)`, `sinh⁻¹(2)`: the degree sign is written on the angle a circular
 * function reads, because the same key gives 0.5 or −0.988 depending on a
 * toggle the expression would otherwise not show.
 */
function trigLabel(fn: TrigFn, x: string, s: CalculatorState): string {
  const degrees = s.unit === "deg" && !s.hyp && !s.second ? "°" : "";
  return `${fn}${s.hyp ? "h" : ""}${s.second ? "⁻¹" : ""}(${x}${degrees})`;
}

/** Shunting-yard over a token list; unmatched `(` close at the end. */
function evaluate(tokens: Token[]): number {
  const values: number[] = [];
  const ops: (BinaryOp | "(")[] = [];
  const reduce = () => {
    const op = ops.pop() as BinaryOp;
    const b = values.pop()!;
    const a = values.pop()!;
    values.push(settle(binary(op, a, b)));
  };
  for (const t of tokens) {
    if (t.kind === "num") values.push(t.value);
    else if (t.kind === "open") ops.push("(");
    else {
      for (;;) {
        const top = ops.at(-1);
        if (top === undefined || top === "(") break;
        // `^` is right-associative: 2 ^ 3 ^ 2 = 2 ^ 9.
        const right = t.op === "^" || t.op === "root";
        if (PRECEDENCE[top] > PRECEDENCE[t.op] || (PRECEDENCE[top] === PRECEDENCE[t.op] && !right)) reduce();
        else break;
      }
      ops.push(t.op);
    }
  }
  while (ops.length > 0) {
    if (ops.at(-1) === "(") ops.pop();
    else reduce();
  }
  return values[0]!;
}

function render(tokens: Token[]): string {
  return tokens.map((t) => (t.kind === "num" ? t.label : t.kind === "open" ? "(" : OP_LABEL[t.op])).join(" ");
}

const openCount = (tokens: Token[]) =>
  tokens.filter((t) => t.kind === "open").length;

const num = ({ value, label }: Operand): Token => ({ kind: "num", value, label });

/** The operand a function or an operator applies to. */
function current(state: CalculatorState): Operand {
  const e = state.entry;
  if (e?.kind === "typed") {
    const value = parseFloat(e.text);
    return { value, label: formatNumber(value) };
  }
  if (e?.kind === "value") return e;
  // No entry: the operand left of the trailing operator, as Windows shows it.
  const before = state.tokens.at(-2);
  return state.tokens.at(-1)?.kind === "op" && before?.kind === "num" ? before : { value: 0, label: "0" };
}

/** The tokens since the innermost `(` still open, without the trailing operator. */
function innerGroup(tokens: Token[]): Token[] {
  const at = tokens.findLastIndex((t) => t.kind === "open");
  return tokens.slice(at + 1, -1);
}

const fresh = (s: CalculatorState): CalculatorState => ({
  ...initialCalculator,
  unit: s.unit,
  second: s.second,
  hyp: s.hyp,
});

function typed(state: CalculatorState, edit: (text: string) => string): CalculatorState {
  const base = state.done || state.error ? fresh(state) : state;
  const text = base.entry?.kind === "typed" ? base.entry.text : "0";
  return { ...base, entry: { kind: "typed", text: edit(text) } };
}

const CONSTANTS: Record<"pi" | "e", Operand> = {
  pi: { value: Math.PI, label: "π" },
  e: { value: Math.E, label: "e" },
};

/** ± on digits being typed: flips their sign, or the exponent's once there is one. */
function negateTyped(t: string): string {
  if (t.includes("e")) return t.replace(/e([+-])/, (_, s: string) => (s === "+" ? "e-" : "e+"));
  if (t.startsWith("-")) return t.slice(1);
  return t === "0" ? t : `-${t}`;
}

const digitCount = (text: string) => text.replace(/e.*$/, "").replace(/[^0-9]/g, "").length;

function apply(state: CalculatorState, key: CalculatorKey): CalculatorState {
  switch (key.kind) {
    case "digit":
      return typed(state, (t) => {
        // Three digits of exponent, the most a double can use.
        if (t.includes("e")) return /e[+-]\d{3}$/.test(t) ? t : t + key.digit;
        if (digitCount(t) >= MAX_DIGITS) return t;
        if (t === "0") return String(key.digit);
        if (t === "-0") return `-${key.digit}`;
        return t + key.digit;
      });
    case "dot":
      return typed(state, (t) =>
        t.includes(".") || t.includes("e") ? t : `${t}.`,
      );
    case "exp":
      if (state.entry?.kind !== "typed" || state.entry.text.includes("e")) return state;
      return { ...state, entry: { kind: "typed", text: `${state.entry.text}e+` } };
    case "back": {
      if (state.error) return fresh(state);
      if (state.entry?.kind !== "typed" || state.done) return state;
      const t0 = state.entry.text;
      const t = /e[+-]$/.test(t0) ? t0.slice(0, -2) : t0.slice(0, -1);
      return { ...state, entry: { kind: "typed", text: t === "" || t === "-" ? "0" : t } };
    }
    case "clearEntry":
      if (state.error || state.done) return fresh(state);
      return { ...state, entry: { kind: "typed", text: "0" } };
    case "clear":
      return fresh(state);
    case "unit":
      return { ...state, unit: state.unit === "deg" ? "rad" : "deg" };
    case "second":
      return { ...state, second: !state.second };
    case "hyp":
      return { ...state, hyp: !state.hyp };
    case "const": {
      const base = state.done || state.error ? fresh(state) : state;
      return { ...base, entry: { kind: "value", ...CONSTANTS[key.name] } };
    }
    default:
      break;
  }
  if (state.error) return state;
  const base = state.done ? { ...state, tokens: [], done: false } : state;
  switch (key.kind) {
    case "fn": {
      if (key.fn === "neg" && base.entry?.kind === "typed") {
        return { ...base, entry: { kind: "typed", text: negateTyped(base.entry.text) } };
      }
      const x = current(base);
      return {
        ...base,
        entry: { kind: "value", value: settle(unary(key.fn, x.value)), label: FN_LABEL[key.fn](x.label) },
      };
    }
    case "trig": {
      const x = current(base);
      const value = base.second
        ? inverse(key.fn, x.value, base.unit, base.hyp)
        : base.hyp
          ? hyperbolic(key.fn, x.value)
          : circular(key.fn, x.value, base.unit);
      return { ...base, entry: { kind: "value", value: settle(value), label: trigLabel(key.fn, x.label, base) } };
    }
    case "percent": {
      // Like Windows: after + or −, x % is x percent of what precedes;
      // otherwise it is x hundredths.
      const x = current(base);
      const last = base.tokens.at(-1);
      const of = last?.kind === "op" && (last.op === "+" || last.op === "-") ? evaluate(innerGroup(base.tokens)) : 1;
      const value = settle((of * x.value) / 100);
      return { ...base, entry: { kind: "value", value, label: formatNumber(value) } };
    }
    case "op": {
      if (base.entry === null && base.tokens.at(-1)?.kind === "op") {
        return { ...base, tokens: [...base.tokens.slice(0, -1), { kind: "op", op: key.op }] };
      }
      return { ...base, tokens: [...base.tokens, num(current(base)), { kind: "op", op: key.op }], entry: null };
    }
    case "open": {
      const tokens: Token[] = [...base.tokens];
      // A number before `(` multiplies it, as on paper: 2(3 + 4) = 14; a
      // result does not, `(` after `=` starts over.
      if (!state.done && base.entry !== null) tokens.push(num(current(base)), { kind: "op", op: "*" });
      return { ...base, tokens: [...tokens, { kind: "open" }], entry: null };
    }
    case "close": {
      const at = base.tokens.findLastIndex((t) => t.kind === "open");
      if (at < 0) return base;
      const group: Token[] = [...base.tokens.slice(at + 1), num(current(base))];
      return {
        ...base,
        tokens: base.tokens.slice(0, at),
        entry: { kind: "value", value: evaluate(group), label: `(${render(group)})` },
      };
    }
    case "equals": {
      if (state.done) return state;
      const all: Token[] = [...base.tokens, num(current(base))];
      const value = evaluate(all);
      return {
        ...base,
        tokens: [],
        entry: { kind: "value", value, label: formatNumber(value) },
        done: true,
        last: `${render(all)}${")".repeat(openCount(all))} =`,
      };
    }
  }
}

/** The next state of the calculator. An impossible operation is an error state, never a throw. */
export function press(state: CalculatorState, key: CalculatorKey): CalculatorState {
  try {
    return apply(state, key);
  } catch (e) {
    if (!(e instanceof CalcFailure)) throw e;
    return { ...fresh(state), error: e.code };
  }
}

/** The big line: the operand being formed, or the last one entered. */
export function display(state: CalculatorState): string {
  if (state.entry?.kind === "typed") return state.entry.text;
  return formatNumber(current(state).value);
}

/** The line above it: the expression so far, or the one `=` evaluated. */
export function expression(state: CalculatorState): string {
  if (state.done) return state.last ?? "";
  const pending = state.entry?.kind === "value" ? [state.entry.label] : [];
  return [render(state.tokens), ...pending].filter((s) => s !== "").join(" ");
}
