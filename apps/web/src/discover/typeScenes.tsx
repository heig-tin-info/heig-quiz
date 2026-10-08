import { Bold, Check, ChevronDown, Code, Italic, List, Lock, X } from "lucide-react";
import type { CSSProperties, ReactNode, RefObject } from "react";

import { type Dict, useT } from "../i18n";
import { cx } from "../ui";
import { STILL, useInView, useStep } from "./motion";

/*
 * One looping miniature per question type of the registry
 * (`packages/registry/src/server.ts`), for the discovery page's types
 * section. Each shows what the student DOES with the type, then how it is
 * judged. Pictures only (`aria-hidden`): the card's text says the same.
 */

type Key = keyof Dict;

/** A scene's clock: the step while on screen, its last step under reduced motion. */
function useLoop(period: number, length: number): [RefObject<HTMLDivElement | null>, number] {
  const [ref, inView] = useInView<HTMLDivElement>();
  const step = useStep(period, length, inView);
  return [ref, step === STILL ? length - 1 : step];
}

function Stage({ stageRef, children, className }: { stageRef: RefObject<HTMLDivElement | null>; children: ReactNode; className?: string }) {
  return (
    <div ref={stageRef} aria-hidden className={cx("relative h-52 overflow-hidden rounded-field bg-surface-2 p-4", className)}>
      {children}
    </div>
  );
}

const pop = "pop-in";

// --- Multiple choice ------------------------------------------------------

const POLICIES: readonly Key[] = [
  "discover.qt.mcq.policy1",
  "discover.qt.mcq.policy2",
  "discover.qt.mcq.policy3",
  "discover.qt.mcq.policy4",
  "discover.qt.mcq.policy5",
];

export function McqType() {
  const t = useT();
  const [ref, step] = useLoop(650, 12);
  const choices = ["git add", "git commit", "git push", "git status"];
  const key = new Set([0, 1]);
  const ticked = new Set<number>([...(step >= 1 ? [0] : []), ...(step >= 2 ? [3] : []), ...(step >= 3 ? [1] : [])]);
  if (step >= 4) ticked.delete(3);
  const reveal = step >= 6;
  return (
    <Stage stageRef={ref}>
      <p className="mb-2 text-[13px] font-semibold text-fg">{t("discover.qt.mcq.stem")}</p>
      <div className="grid grid-cols-2 gap-1.5">
        {choices.map((c, i) => {
          const on = ticked.has(i);
          const good = reveal && key.has(i);
          return (
            <div
              key={c}
              className={cx(
                "flex items-center gap-2 rounded-field border bg-surface px-2.5 py-1.5 font-mono text-[12px] transition-colors duration-300",
                good ? "border-success text-fg" : on ? "border-line-strong text-fg" : "border-line text-fg-muted",
              )}
            >
              <span className={cx("grid size-4 place-items-center rounded-[4px] border transition-colors", on ? "border-accent bg-accent text-on-fill" : "border-line-strong")}>
                {on ? <Check className="pop-in size-3" /> : null}
              </span>
              {c}
              {good ? <Check className="pop-in ml-auto size-3.5 text-success" /> : null}
            </div>
          );
        })}
      </div>
      <span key={step >= 6 ? step % 5 : "x"} className={cx("absolute right-3 bottom-3 rounded-full bg-info-soft px-2.5 py-1 text-[11px] font-medium text-info", step >= 6 && pop)}>
        {t(POLICIES[step >= 6 ? (step - 6) % 5 : 0]!)}
      </span>
    </Stage>
  );
}

// --- Short answer ---------------------------------------------------------

const SHORT_TRIES = [
  { value: "9.81", ok: true },
  { value: "9.8", ok: true },
  { value: "98.1", ok: false },
];

export function ShortType() {
  const t = useT();
  const [ref, step] = useLoop(170, 42);
  const n = Math.min(SHORT_TRIES.length - 1, Math.floor(step / 14));
  const local = step - n * 14;
  const tryOf = SHORT_TRIES[step === 41 ? 0 : n]!;
  const typed = step === 41 ? tryOf.value : tryOf.value.slice(0, local);
  const judged = step === 41 || local >= tryOf.value.length + 3;
  return (
    <Stage stageRef={ref}>
      <p className="text-[13px] font-semibold text-fg">{t("discover.qt.short.stem")}</p>
      <div
        className={cx(
          "mt-3 flex h-10 items-center rounded-field border bg-surface px-3 font-mono text-sm transition-colors",
          judged ? (tryOf.ok ? "border-success" : "border-danger") : "border-line-strong",
        )}
      >
        <span className={cx(!judged && "caret")}>{typed}</span>
        <span className="ml-1.5 text-fg-faint">m/s²</span>
        {judged ? (
          tryOf.ok ? <Check className="pop-in ml-auto size-4 text-success" /> : <X className="pop-in ml-auto size-4 text-danger" />
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {(["discover.qt.short.m1", "discover.qt.short.m2", "discover.qt.short.m3", "discover.qt.short.m4"] as const).map((k, i) => (
          <span
            key={k}
            className={cx(
              "rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors",
              i === 0 ? "border-info/50 bg-info-soft text-info" : "border-line text-fg-faint",
            )}
          >
            {t(k)}
          </span>
        ))}
      </div>
    </Stage>
  );
}

// --- Cloze ----------------------------------------------------------------

export function ClozeType() {
  const t = useT();
  const [ref, step] = useLoop(260, 26);
  const first = "LIFO".slice(0, Math.max(0, step - 2));
  const open = step >= 9 && step < 15;
  const picked = step >= 15;
  return (
    <Stage stageRef={ref}>
      <p className="text-[14px] leading-[2.2] text-fg">
        {t("discover.qt.cloze.a")}{" "}
        <span className="inline-flex h-7 min-w-16 items-center rounded-[6px] border border-accent/50 bg-accent-soft px-2 align-middle font-mono text-[13px] text-accent">
          <span className={cx(step < 7 && step >= 2 && "caret")}>{first}</span>
        </span>
        {t("discover.qt.cloze.b")}{" "}
        <span className="relative inline-block align-middle">
          <span className="inline-flex h-7 min-w-20 items-center gap-1 rounded-[6px] border border-info/50 bg-info-soft px-2 font-mono text-[13px] text-info">
            {picked ? <span className="pop-in">FIFO</span> : <span className="opacity-50">…</span>}
            <ChevronDown className="ml-auto size-3.5" />
          </span>
          {open ? (
            <span className="pop-in absolute top-8 left-0 z-10 w-24 rounded-menu border border-line bg-surface p-1 font-mono text-[12px] shadow-(--shadow-popover)">
              {["LIFO", "FIFO", "LRU"].map((o, i) => (
                <span key={o} className={cx("block rounded-[6px] px-2 py-1 leading-normal", step >= 12 && i === 1 ? "bg-info-soft text-info" : "text-fg")}>
                  {o}
                </span>
              ))}
            </span>
          ) : null}
        </span>
        {t("discover.qt.cloze.c")}
      </p>
      {step >= 18 ? (
        <div className="pop-in absolute right-3 bottom-3 flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-semibold text-success">
          <Check className="size-3.5" /> 2 / 2
        </div>
      ) : null}
    </Stage>
  );
}

// --- Code -----------------------------------------------------------------

const LANGS = ["C", "C++", "Python", "JavaScript", "Rust"];
const BODY = "return a > b ? a : b;";

export function CodeType() {
  const t = useT();
  const [ref, step] = useLoop(90, BODY.length + 40);
  const typed = BODY.slice(0, step);
  const after = step - BODY.length;
  const locked = "flex items-center gap-2 px-3 text-fg-faint";
  return (
    <Stage stageRef={ref} className="flex flex-col gap-3 p-3">
      <div className="overflow-hidden rounded-field border border-line bg-surface font-mono text-[12px] leading-6">
        <div className={locked}>
          <Lock className="size-3 shrink-0" /> int max(int a, int b) {"{"}
        </div>
        <div className="border-y border-dashed border-accent/40 bg-accent-soft/50 px-3 pl-8 text-fg">
          <span className={cx(after < 0 && "caret")}>{typed}</span>
        </div>
        <div className={locked}>
          <Lock className="size-3 shrink-0" /> {"}"}
        </div>
      </div>
      <div className="flex items-center gap-3 font-mono text-[11px]">
        {[0, 1, 2].map((i) =>
          after > 6 + i * 6 ? (
            <span key={i} className="pop-in flex items-center gap-1 text-success">
              <Check className="size-3.5" /> test {i + 1}
            </span>
          ) : (
            <span key={i} className="flex items-center gap-1 text-fg-faint">
              <span className="size-3 rounded-full bg-surface-3" /> test {i + 1}
            </span>
          ),
        )}
      </div>
      <div className="mt-auto flex flex-wrap gap-1.5">
        {LANGS.map((l, i) => (
          <span
            key={l}
            className={cx(
              "rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors duration-500",
              Math.floor(step / 12) % LANGS.length === i ? "border-(--q-green) text-fg" : "border-line text-fg-faint",
            )}
          >
            {l}
          </span>
        ))}
        <span className="ml-auto self-center text-[11px] text-fg-faint">{t("discover.qt.code.locked")}</span>
      </div>
    </Stage>
  );
}

// --- Code that draws an image ---------------------------------------------

const HEART = [
  "0110001100",
  "1111011110",
  "1111111111",
  "1111111111",
  "0111111110",
  "0011111100",
  "0001111000",
  "0000110000",
];

function Pixels({ upTo, label }: { upTo: number; label: string }) {
  let k = 0;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="grid gap-[2px] rounded-[6px] bg-surface p-1.5" style={{ gridTemplateColumns: "repeat(10, 0.6rem)" }}>
        {HEART.flatMap((row) =>
          [...row].map((bit) => {
            const index = k++;
            const shown = index < upTo;
            return (
              <span
                key={index}
                className={cx("size-[0.6rem] rounded-[2px] transition-colors duration-200", shown && bit === "1" ? "bg-(--q-red)" : "bg-surface-3")}
              />
            );
          }),
        )}
      </div>
      <span className="text-[11px] text-fg-faint">{label}</span>
    </div>
  );
}

export function CodeImageType() {
  const t = useT();
  const [ref, step] = useLoop(45, 110);
  const total = HEART.length * 10;
  return (
    <Stage stageRef={ref} className="flex items-center justify-center gap-6">
      <Pixels upTo={total} label={t("discover.qt.codeimage.target")} />
      <span className={cx("grid size-8 place-items-center rounded-full transition-colors", step >= total + 4 ? "bg-success text-on-fill" : "bg-surface-3 text-fg-faint")}>
        {step >= total + 4 ? <Check className="pop-in size-4" /> : "="}
      </span>
      <Pixels upTo={step} label={t("discover.qt.codeimage.output")} />
    </Stage>
  );
}

// --- Circuit --------------------------------------------------------------

function wave(amp: number, phase: number, y0: number, w = 260) {
  let d = "";
  for (let x = 0; x <= w; x += 4) {
    const y = y0 - amp * Math.sin((x / w) * Math.PI * 4 - phase);
    d += `${x === 0 ? "M" : "L"}${x},${y.toFixed(1)} `;
  }
  return d;
}

const draw = (on: boolean, len = 400): CSSProperties => ({
  strokeDasharray: len,
  strokeDashoffset: on ? 0 : len,
  transition: "stroke-dashoffset 1.2s cubic-bezier(.2,.7,.2,1)",
});

export function CircuitType() {
  const t = useT();
  const [ref, step] = useLoop(600, 12);
  return (
    <Stage stageRef={ref} className="p-3">
      <svg viewBox="0 0 280 180" className="h-full w-full text-fg" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <rect x="40" y="8" width="200" height="92" rx="8" className="stroke-line-strong" strokeDasharray="4 4" />
        {[
          [40, 30, "in+"],
          [40, 80, "in−"],
          [240, 30, "out+"],
          [240, 80, "out−"],
        ].map(([x, y, l]) => (
          <g key={l as string}>
            <circle cx={x as number} cy={y as number} r="3.5" className="fill-surface stroke-fg-muted" strokeWidth="1.5" />
            <text x={(x as number) < 100 ? 6 : 248} y={(y as number) + 4} className="fill-fg-faint font-mono text-[9px]">
              {l}
            </text>
          </g>
        ))}
        {/* wires */}
        <path d="M44 30 H100 M156 30 H236 M190 30 V48 M190 62 V80 M44 80 H236" stroke="currentColor" strokeWidth="1.5" style={draw(step >= 3)} />
        {/* resistor */}
        <path
          d="M100 30 l4 -7 l8 14 l8 -14 l8 14 l8 -14 l8 14 l4 -7"
          className={cx("transition-opacity duration-300", step >= 1 ? "opacity-100" : "opacity-0")}
          stroke="var(--q-yellow)"
          strokeWidth="2"
        />
        {/* capacitor */}
        <path d="M178 48 H202 M178 62 H202" className={cx("transition-opacity duration-300", step >= 2 ? "opacity-100" : "opacity-0")} stroke="var(--q-blue)" strokeWidth="2.5" />
        {step >= 1 ? <text x="118" y="20" className="pop-in fill-fg-muted font-mono text-[9px]">R 1k</text> : null}
        {step >= 2 ? <text x="208" y="58" className="pop-in fill-fg-muted font-mono text-[9px]">C 100n</text> : null}
        {/* waveforms */}
        <line x1="10" y1="145" x2="270" y2="145" className="stroke-line" />
        <path d={wave(22, 0, 145)} transform="translate(10 0)" className="stroke-fg-faint" strokeWidth="1.5" style={draw(step >= 5, 700)} />
        <path d={wave(11, 0.9, 145)} transform="translate(10 0)" stroke="var(--q-blue)" strokeWidth="2" style={draw(step >= 6, 700)} />
      </svg>
      {step >= 8 ? (
        <span className="pop-in absolute top-3 right-3 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-semibold text-success">
          {t("discover.qt.circuit.sim")}
        </span>
      ) : null}
    </Stage>
  );
}

// --- Essay ----------------------------------------------------------------

export function RichType() {
  const t = useT();
  const [ref, step] = useLoop(70, 150);
  const before = t("discover.qt.rich.before");
  const bold = t("discover.qt.rich.bold");
  const after = t("discover.qt.rich.after");
  const all = before.length + bold.length + after.length;
  const n = Math.min(step * 2, all);
  const a = before.slice(0, n);
  const b = bold.slice(0, Math.max(0, n - before.length));
  const c = after.slice(0, Math.max(0, n - before.length - bold.length));
  return (
    <Stage stageRef={ref} className="flex flex-col gap-2 p-3">
      <div className="flex gap-1 text-fg-muted">
        {[Bold, Italic, List, Code].map((I, i) => (
          <span key={i} className={cx("grid size-6 place-items-center rounded-[6px]", i === 0 && n > before.length && n < before.length + bold.length ? "bg-accent-soft text-accent" : "")}>
            <I className="size-3.5" />
          </span>
        ))}
      </div>
      <div className="flex-1 rounded-field border border-line bg-surface p-3 text-[13px] leading-relaxed text-fg">
        {a}
        <strong>{b}</strong>
        <span className={cx(n < all && "caret")}>{c}</span>
      </div>
      <div className="flex items-center justify-between text-[11px] text-fg-faint">
        <span className="tabular-nums">{t("discover.qt.rich.count", { n })}</span>
        {n >= all ? (
          <span className="pop-in rounded-full bg-info-soft px-2 py-0.5 font-medium text-info">{t("discover.qt.rich.rubric")}</span>
        ) : null}
      </div>
    </Stage>
  );
}

// --- Categorize -----------------------------------------------------------

const CARDS = [
  { id: "C", col: 0 },
  { id: "Python", col: 1 },
  { id: "Rust", col: 0 },
  { id: "Bash", col: 1 },
  { id: "HTML", col: -1 },
];

export function CategorizeType() {
  const t = useT();
  const [ref, step] = useLoop(700, 9);
  const placed = (i: number) => CARDS[i]!.col >= 0 && step > i;
  const card = (id: string, extra?: string) => (
    <span key={id} className={cx("pop-in rounded-[8px] border border-line bg-surface px-2.5 py-1 font-mono text-[12px] text-fg shadow-sm", extra)}>
      {id}
    </span>
  );
  return (
    <Stage stageRef={ref} className="flex flex-col gap-2 p-3">
      <div className="grid flex-1 grid-cols-2 gap-2">
        {(["discover.qt.categorize.col1", "discover.qt.categorize.col2"] as const).map((k, col) => (
          <div key={k} className="flex flex-col gap-1.5 rounded-field border border-dashed border-line-strong p-2">
            <span className="text-[11px] font-semibold text-fg-muted">{t(k)}</span>
            <div className="flex flex-wrap gap-1.5">{CARDS.filter((x, i) => x.col === col && placed(i)).map((x) => card(x.id))}</div>
          </div>
        ))}
      </div>
      <div className="flex min-h-9 items-center gap-1.5 rounded-field bg-surface-3/60 px-2">
        {CARDS.filter((_, i) => !placed(i)).map((x) => card(x.id, x.col < 0 && step >= 6 ? "border-success" : ""))}
        {step >= 6 ? <span className="pop-in ml-auto text-[11px] text-fg-faint">{t("discover.qt.categorize.distractor")}</span> : null}
      </div>
    </Stage>
  );
}

// --- Diagram --------------------------------------------------------------

export function DiagramType() {
  const [ref, step] = useLoop(550, 12);
  const node = (x: number, label: string, at: number, accept = false) =>
    step >= at ? (
      <g key={label} className="pop-in" style={{ transformOrigin: `${x}px 60px` }}>
        <circle cx={x} cy="60" r="20" className="fill-surface stroke-fg" strokeWidth="1.5" />
        {accept ? <circle cx={x} cy="60" r="15" className="stroke-fg" strokeWidth="1.5" /> : null}
        <text x={x} y="64" textAnchor="middle" className="fill-fg font-mono text-[11px]">
          {label}
        </text>
      </g>
    ) : null;
  return (
    <Stage stageRef={ref}>
      <svg viewBox="0 0 280 150" className="h-full w-full" fill="none" strokeLinecap="round">
        <defs>
          <marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L10 5 L0 10z" className="fill-fg" />
          </marker>
        </defs>
        <path d="M10 60 H28" className="stroke-fg" strokeWidth="1.5" markerEnd={step >= 2 ? "url(#dg-arrow)" : undefined} style={draw(step >= 1, 30)} />
        <path d="M70 60 H118" className="stroke-fg" strokeWidth="1.5" markerEnd={step >= 5 ? "url(#dg-arrow)" : undefined} style={draw(step >= 4, 60)} />
        <path d="M160 60 H208" className="stroke-fg" strokeWidth="1.5" markerEnd={step >= 6 ? "url(#dg-arrow)" : undefined} style={draw(step >= 5, 60)} />
        <path d="M128 42 C 118 12, 158 12, 148 42" className="stroke-fg" strokeWidth="1.5" markerEnd={step >= 7 ? "url(#dg-arrow)" : undefined} style={draw(step >= 6, 80)} />
        <path d="M222 80 C 200 125, 80 125, 58 80" stroke="var(--q-blue)" strokeWidth="1.5" markerEnd={step >= 8 ? "url(#dg-arrow)" : undefined} style={draw(step >= 7, 260)} />
        {node(50, "q0", 1)}
        {node(140, "q1", 2)}
        {node(230, "q2", 3, true)}
        {step >= 4 ? <text x="94" y="54" className="pop-in fill-fg-muted font-mono text-[11px]">a</text> : null}
        {step >= 5 ? <text x="184" y="54" className="pop-in fill-fg-muted font-mono text-[11px]">b</text> : null}
        {step >= 6 ? <text x="134" y="12" className="pop-in fill-fg-muted font-mono text-[11px]">a</text> : null}
        {step >= 7 ? <text x="138" y="132" className="pop-in fill-(--q-blue) font-mono text-[11px]">ε</text> : null}
      </svg>
    </Stage>
  );
}

// --- Brainstorm -----------------------------------------------------------

const IDEAS: readonly [Key, string][] = [
  ["discover.qt.brainstorm.w1", "var(--q-red)"],
  ["discover.qt.brainstorm.w2", "var(--q-blue)"],
  ["discover.qt.brainstorm.w3", "var(--q-green)"],
  ["discover.qt.brainstorm.w1", "var(--q-red)"],
  ["discover.qt.brainstorm.w4", "var(--q-yellow)"],
  ["discover.qt.brainstorm.w5", "var(--q-blue)"],
  ["discover.qt.brainstorm.w1", "var(--q-red)"],
  ["discover.qt.brainstorm.w6", "var(--q-green)"],
  ["discover.qt.brainstorm.w2", "var(--q-blue)"],
];
const SPOTS = [
  [50, 46],
  [24, 28],
  [76, 30],
  [30, 72],
  [72, 72],
  [52, 18],
  [12, 54],
  [88, 54],
];

export function BrainstormType() {
  const t = useT();
  const [ref, step] = useLoop(650, IDEAS.length + 4);
  const counts = new Map<Key, { n: number; color: string; order: number }>();
  IDEAS.slice(0, step + 1).forEach(([w, c]) => {
    const prev = counts.get(w);
    counts.set(w, { n: (prev?.n ?? 0) + 1, color: c, order: prev?.order ?? counts.size });
  });
  return (
    <Stage stageRef={ref}>
      {[...counts.entries()].map(([word, { n, color, order }]) => {
        const [x, y] = SPOTS[order % SPOTS.length]!;
        const size = 2.6 + n * 1.1;
        return (
          <span
            key={word}
            className="pop-in absolute grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full font-semibold text-fg transition-all duration-500"
            style={{
              left: `${x}%`,
              top: `${y}%`,
              width: `${size}rem`,
              height: `${size}rem`,
              fontSize: `${10 + n * 2}px`,
              background: `color-mix(in srgb, ${color} 22%, var(--surface))`,
              border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
            }}
          >
            {t(word)}
          </span>
        );
      })}
    </Stage>
  );
}
