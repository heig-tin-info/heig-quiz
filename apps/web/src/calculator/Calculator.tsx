/**
 * The calculator an evaluation provides (ADR-069): a keypad over the pure
 * engine of `@quiz/domain`, in its two modes. The Windows calculator is the
 * model the product owner gave — the expression above, the number below, the
 * scientific keys on ONE surface, without its trigonometry submenu. Its
 * look (no accent, soft-square keys, three tones) is `apps/web/DESIGN.md`,
 * "The calculator".
 *
 * The keyboard drives it while focus is inside, never otherwise: digits
 * typed in an answer field stay in the answer.
 */
import { CornerDownLeft, Delete } from "lucide-react";
import { useReducer, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react";

import {
  display,
  displayRpn,
  expression,
  initialCalculator,
  initialRpn,
  levelsRpn,
  press,
  pressRpn,
  type CalculatorKey,
  type CalculatorMode,
  type CalculatorState,
  type RpnState,
  type TrigFn,
} from "@quiz/domain";

import type { Dict } from "../i18n";
import { useT } from "../i18n";
import { cx, ToggleChip } from "../ui";

export type CalculatorKind = Exclude<CalculatorMode, "none">;

type Tone = "digit" | "fn" | "op" | "equals";

interface KeyDef {
  label: ReactNode;
  /** The key's name for a screen reader; a digit is its own. */
  name?: keyof Dict;
  key: CalculatorKey;
  tone?: Tone;
  /** The keyboard keys that press it while the keypad has the focus. */
  kbd?: string[];
}

/** A key, and the one `2nd` turns it into. */
type Slot = KeyDef | { normal: KeyDef; second: KeyDef };

const digit = (n: number): KeyDef => ({
  label: String(n),
  key: { kind: "digit", digit: n },
  tone: "digit",
  kbd: [String(n)],
});
const pow = (base: ReactNode, exp: ReactNode) => (
  <span>
    {base}
    <sup className="text-[0.7em]">{exp}</sup>
  </span>
);

const K = {
  percent: { label: "%", name: "calc.key.percent", key: { kind: "percent" }, kbd: ["%"] },
  clearEntry: { label: "CE", name: "calc.key.clearEntry", key: { kind: "clearEntry" }, kbd: ["Delete"] },
  clear: { label: "C", name: "calc.key.clear", key: { kind: "clear" } },
  back: { label: <Delete className="size-4" aria-hidden />, name: "calc.key.back", key: { kind: "back" }, kbd: ["Backspace"] },
  inv: { label: pow("1/", "x"), name: "calc.key.inv", key: { kind: "fn", fn: "inv" } },
  sqr: { label: pow("x", "2"), name: "calc.key.sqr", key: { kind: "fn", fn: "sqr" } },
  cube: { label: pow("x", "3"), name: "calc.key.cube", key: { kind: "fn", fn: "cube" } },
  sqrt: { label: "√x", name: "calc.key.sqrt", key: { kind: "fn", fn: "sqrt" } },
  cbrt: { label: "∛x", name: "calc.key.cbrt", key: { kind: "fn", fn: "cbrt" } },
  abs: { label: "|x|", name: "calc.key.abs", key: { kind: "fn", fn: "abs" } },
  fact: { label: "n!", name: "calc.key.fact", key: { kind: "fn", fn: "fact" }, kbd: ["!"] },
  exp: { label: "exp", name: "calc.key.exp", key: { kind: "exp" } },
  mod: { label: "mod", name: "calc.key.mod", key: { kind: "op", op: "mod" } },
  pow: { label: pow("x", "y"), name: "calc.key.pow", key: { kind: "op", op: "^" }, kbd: ["^"] },
  root: { label: <span><sup className="text-[0.7em]">y</sup>√x</span>, name: "calc.key.root", key: { kind: "op", op: "root" } },
  pow10: { label: pow("10", "x"), name: "calc.key.pow10", key: { kind: "fn", fn: "pow10" } },
  pow2: { label: pow("2", "x"), name: "calc.key.pow2", key: { kind: "fn", fn: "pow2" } },
  log: { label: "log", name: "calc.key.log", key: { kind: "fn", fn: "log" } },
  logBase: { label: <span>log<sub className="text-[0.7em]">y</sub>x</span>, name: "calc.key.logBase", key: { kind: "op", op: "logBase" } },
  ln: { label: "ln", name: "calc.key.ln", key: { kind: "fn", fn: "ln" } },
  powE: { label: pow("e", "x"), name: "calc.key.powE", key: { kind: "fn", fn: "powE" } },
  pi: { label: "π", name: "calc.key.pi", key: { kind: "const", name: "pi" } },
  e: { label: "e", name: "calc.key.e", key: { kind: "const", name: "e" } },
  open: { label: "(", name: "calc.key.open", key: { kind: "open" }, kbd: ["("] },
  close: { label: ")", name: "calc.key.close", key: { kind: "close" }, kbd: [")"] },
  divide: { label: "÷", name: "calc.key.divide", key: { kind: "op", op: "/" }, tone: "op", kbd: ["/"] },
  multiply: { label: "×", name: "calc.key.multiply", key: { kind: "op", op: "*" }, tone: "op", kbd: ["*", "x"] },
  minus: { label: "−", name: "calc.key.minus", key: { kind: "op", op: "-" }, tone: "op", kbd: ["-"] },
  plus: { label: "+", name: "calc.key.plus", key: { kind: "op", op: "+" }, tone: "op", kbd: ["+"] },
  equals: { label: "=", name: "calc.key.equals", key: { kind: "equals" }, tone: "equals", kbd: ["=", "Enter"] },
  neg: { label: "+/−", name: "calc.key.neg", key: { kind: "fn", fn: "neg" }, tone: "digit" },
  dot: { label: ".", name: "calc.key.dot", key: { kind: "dot" }, tone: "digit", kbd: [".", ","] },
  swap: { label: "x⇄y", name: "calc.key.swap", key: { kind: "swap" } },
  roll: { label: "R↓", name: "calc.key.roll", key: { kind: "roll" } },
  enter: { label: <CornerDownLeft className="size-4" aria-hidden />, name: "calc.key.enter", key: { kind: "enter" }, tone: "equals", kbd: ["Enter"] },
} satisfies Record<string, KeyDef>;

/** Windows's standard layout, four columns. */
const STANDARD: Slot[] = [
  K.percent, K.clearEntry, K.clear, K.back,
  K.inv, K.sqr, K.sqrt, K.divide,
  digit(7), digit(8), digit(9), K.multiply,
  digit(4), digit(5), digit(6), K.minus,
  digit(1), digit(2), digit(3), K.plus,
  K.neg, digit(0), K.dot, K.equals,
];

/** Windows's scientific layout, five columns; its `2nd` sits with the toggles. */
const SCIENTIFIC: Slot[] = [
  K.pi, K.e, K.clearEntry, K.clear, K.back,
  { normal: K.sqr, second: K.cube }, K.inv, K.abs, K.exp, K.mod,
  { normal: K.sqrt, second: K.cbrt }, K.open, K.close, K.fact, K.divide,
  { normal: K.pow, second: K.root }, digit(7), digit(8), digit(9), K.multiply,
  { normal: K.pow10, second: K.pow2 }, digit(4), digit(5), digit(6), K.minus,
  { normal: K.log, second: K.logBase }, digit(1), digit(2), digit(3), K.plus,
  { normal: K.ln, second: K.powE }, K.neg, digit(0), K.dot, K.equals,
];

/**
 * The same keypads for reverse Polish notation: `=` becomes Enter, and the
 * keys that only an expression needs (`%`, parentheses) give their place to
 * the stack's.
 */
const RPN_KEYS = new Map<string, Slot>([
  ["percent", K.swap],
  ["open", K.swap],
  ["close", K.roll],
  ["equals", K.enter],
]);
const rpnSlots = (slots: Slot[]): Slot[] =>
  slots.map((slot) => ("normal" in slot ? slot : (RPN_KEYS.get(slot.key.kind) ?? slot)));

const TRIG: TrigFn[] = ["sin", "cos", "tan", "sec", "csc", "cot"];

/**
 * What the keyboard presses, read off the layout itself: a key the mode does
 * not draw (`%` in scientific, `^` in standard) does nothing there. A slot
 * `2nd` swaps answers with its normal key.
 */
function keymap(slots: Slot[]): Map<string, CalculatorKey> {
  return new Map(
    slots.flatMap((slot) => {
      const def = "normal" in slot ? slot.normal : slot;
      return (def.kbd ?? []).map((k) => [k, def.key] as const);
    }),
  );
}

const KEYMAPS: Record<CalculatorKind, Record<"infix" | "rpn", Map<string, CalculatorKey>>> = {
  standard: { infix: keymap(STANDARD), rpn: keymap(rpnSlots(STANDARD)) },
  scientific: { infix: keymap(SCIENTIFIC), rpn: keymap(rpnSlots(SCIENTIFIC)) },
};

/**
 * `ref` is the keypad's root, focusable: the dock focuses it on open, so the
 * keyboard drives the calculator at once. `rpn` is the user's setting
 * (reverse Polish notation): the same keys, the stack instead of the
 * expression.
 */
export function Calculator({ kind, rpn = false, ref }: { kind: CalculatorKind; rpn?: boolean; ref?: Ref<HTMLDivElement> }) {
  return rpn ? <RpnCalculator kind={kind} ref={ref} /> : <InfixCalculator kind={kind} ref={ref} />;
}

function InfixCalculator({ kind, ref }: { kind: CalculatorKind; ref?: Ref<HTMLDivElement> }) {
  const [state, dispatch] = useReducer(press, initialCalculator);
  return (
    <Keypad
      kind={kind}
      mode="infix"
      slots={kind === "scientific" ? SCIENTIFIC : STANDARD}
      state={state}
      dispatch={dispatch}
      display={<Display state={state} />}
      ref={ref}
    />
  );
}

function RpnCalculator({ kind, ref }: { kind: CalculatorKind; ref?: Ref<HTMLDivElement> }) {
  const [state, dispatch] = useReducer(pressRpn, initialRpn);
  return (
    <Keypad
      kind={kind}
      mode="rpn"
      slots={rpnSlots(kind === "scientific" ? SCIENTIFIC : STANDARD)}
      state={state}
      dispatch={dispatch}
      display={<RpnDisplay state={state} />}
      ref={ref}
    />
  );
}

/** What the two engines share on the screen: the keys, the keyboard and the angle toggles. */
function Keypad({
  kind,
  mode,
  slots,
  state,
  dispatch,
  display,
  ref,
}: {
  kind: CalculatorKind;
  mode: "infix" | "rpn";
  slots: Slot[];
  state: Pick<CalculatorState | RpnState, "unit" | "second" | "hyp">;
  dispatch: (key: CalculatorKey) => void;
  display: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  const t = useT();
  const scientific = kind === "scientific";

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Enter on a key reached with Tab presses that key, as on any button.
    if (e.key === "Enter" && e.target !== e.currentTarget) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = KEYMAPS[kind][mode].get(e.key);
    if (key === undefined) return;
    e.preventDefault();
    dispatch(key);
  };
  // A click keeps the focus on the keypad, not on the key: Enter typed next
  // is `=`, never the last key clicked once more.
  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (!(e.target as Element).closest("button")) return;
    e.preventDefault();
    e.currentTarget.focus();
  };

  return (
    <div ref={ref} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={onMouseDown} className="flex flex-col gap-3 focus:outline-none">
      {display}
      {scientific ? (
        <div className="flex flex-col gap-1">
          <div className="mb-2 flex items-center gap-2">
            <ToggleChip
              tone="neutral"
              label={state.unit === "deg" ? "DEG" : "RAD"}
              aria-label={t(state.unit === "deg" ? "calc.unit.deg" : "calc.unit.rad")}
              onToggle={() => dispatch({ kind: "unit" })}
            />
            <ToggleChip
              tone="neutral"
              label={<span>2<sup className="text-[0.7em]">nd</sup></span>}
              aria-label={t("calc.second")}
              pressed={state.second}
              onToggle={() => dispatch({ kind: "second" })}
            />
            <ToggleChip
              tone="neutral"
              label="hyp"
              aria-label={t("calc.hyp")}
              pressed={state.hyp}
              onToggle={() => dispatch({ kind: "hyp" })}
            />
          </div>
          <div className="grid grid-cols-6 gap-1">
            {TRIG.map((fn) => {
              const name = `${fn}${state.hyp ? "h" : ""}`;
              const variant = state.second ? (state.hyp ? "inverseHyp" : "inverse") : state.hyp ? "hyp" : "plain";
              return (
                <Key
                  key={fn}
                  def={{
                    label: state.second ? pow(name, "−1") : name,
                    key: { kind: "trig", fn },
                  }}
                  ariaLabel={t(`calc.trig.${variant}`, { fn: t(`calc.trig.${fn}`) })}
                  size="sm"
                  onPress={dispatch}
                />
              );
            })}
          </div>
        </div>
      ) : null}
      <div
        role="group"
        aria-label={t("calc.keys")}
        className={cx("grid gap-1", scientific ? "grid-cols-5" : "grid-cols-4")}
      >
        {slots.map((slot, i) => {
          const def = "normal" in slot ? (state.second ? slot.second : slot.normal) : slot;
          return <Key key={i} def={def} onPress={dispatch} size={scientific ? "md" : "lg"} />;
        })}
      </div>
    </div>
  );
}

function Display({ state }: { state: CalculatorState }) {
  const t = useT();
  const value = state.error ? t(`calc.error.${state.error}`) : display(state);
  // Long numbers shrink rather than wrap: the line is one number.
  const size = state.error || value.length > 16 ? "text-[18px]" : value.length > 11 ? "text-[22px]" : "text-[28px]";
  return (
    <div className="rounded-field bg-surface-2 px-3 py-2 text-right">
      {/* The start of a long expression gives way, not its end: `dir="rtl"`
          puts the ellipsis on the left, the inner span keeps the text LTR. */}
      <p dir="rtl" className="h-5 truncate text-[13px] text-fg-muted">
        <span dir="ltr">{expression(state)}</span>
      </p>
      <output aria-live="polite" className={cx("block truncate font-semibold leading-tight tabular-nums select-all", size)}>
        {value}
      </output>
    </div>
  );
}

function RpnDisplay({ state }: { state: RpnState }) {
  const t = useT();
  const value = state.error ? t(`calc.error.${state.error}`) : displayRpn(state);
  const size = state.error || value.length > 16 ? "text-[18px]" : value.length > 11 ? "text-[22px]" : "text-[28px]";
  // Levels 3, 2, 1 above the number: what an operator is about to take.
  const levels = levelsRpn(state);
  return (
    <div className="rounded-field bg-surface-2 px-3 py-2 text-right">
      <ol aria-label={t("calc.stack")} className="h-[3.75rem] text-[13px] leading-5 text-fg-muted tabular-nums">
        {levels.map((v, i) => (
          <li key={i} className="flex justify-between gap-2">
            <span className="text-fg-faint">{levels.length - i}:</span>
            <span className="truncate">{v}</span>
          </li>
        ))}
      </ol>
      <output aria-live="polite" className={cx("block truncate font-semibold leading-tight tabular-nums select-all", size)}>
        {value}
      </output>
    </div>
  );
}

const KEY_SIZE = { sm: "h-8 text-[13px]", md: "h-10 text-[15px]", lg: "h-12 text-[16px]" } as const;

function Key({
  def,
  onPress,
  ariaLabel,
  size,
}: {
  def: KeyDef;
  onPress: (key: CalculatorKey) => void;
  /** The trigonometry row's names, which change with `2nd` and `hyp`. */
  ariaLabel?: string;
  /** `sm` the trigonometry row, `md` the scientific keypad, `lg` the standard one. */
  size: "sm" | "md" | "lg";
}) {
  const t = useT();
  const tone = def.tone ?? "fn";
  const label = ariaLabel ?? (def.name ? t(def.name) : undefined);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => onPress(def.key)}
      className={cx(
        "inline-flex select-none items-center justify-center rounded-field transition-[background-color,transform] duration-120 active:scale-[0.97]",
        KEY_SIZE[size],
        // The four operators and `=` are glyphs a size up: drawn at the
        // label's size, `÷` and `−` are specks.
        (tone === "op" || tone === "equals") && "!text-[20px]",
        tone === "digit" && "bg-surface-2 font-semibold text-fg hover:bg-surface-3",
        (tone === "fn" || tone === "op") && "border border-line bg-canvas text-fg hover:bg-surface-2",
        tone === "equals" && "bg-fg font-semibold text-surface hover:opacity-90",
      )}
    >
      {def.label}
    </button>
  );
}
