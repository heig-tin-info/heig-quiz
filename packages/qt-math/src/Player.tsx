/**
 * The `math` player: one prompt, one math field, and under it the ECHO —
 * how the parser read what was typed, or why it could not — before anything
 * counts (STACK's validation step, issue #460). A syntax slip is told while
 * typing, never graded as a mistake of mathematics.
 *
 * Controlled — the host owns the answer and autosaves it. The student view
 * IS the reading options (`fieldRules`): what the field accepts is what the
 * grader reads the answer with. The intervals and the tolerance stayed on
 * the server. With `plot`, the expression is drawn over the window as it is
 * typed, and the target curve behind it when the teacher asked for it.
 */
import { useMemo } from "react";

import type { PlayerProps, StringOverrides } from "@quiz/core/client";
import { fmt, resolveStrings } from "@quiz/core/client";
import { curveOf } from "@quiz/domain/math";
import { caption, isLocked, label, markdown, Verdict } from "@quiz/ui";

import { MathEcho } from "./MathEcho.js";
import { MathField } from "./MathField.js";
import { Plot, type PlotSeries } from "./Plot.js";
import { useMathReading } from "./reading.js";
import { MATH_PLOT_POINTS, type MathAnswer, type MathSolution, type MathStudent } from "./schema.js";
import { mathPlayerStrings, type MathPlayerStringKey } from "./strings.js";

type MathPlayerProps = PlayerProps<MathStudent, MathAnswer, MathSolution> & {
  /** Alias of `readOnly`, for hosts that speak in disabled controls. */
  disabled?: boolean;
  strings?: StringOverrides<MathPlayerStringKey>;
};

export function MathPlayer({ student, answer, onChange, readOnly, answerKey, disabled, strings, renderMarkdown }: MathPlayerProps) {
  const s = resolveStrings(mathPlayerStrings, strings);
  const locked = isLocked(readOnly, disabled);
  const latex = answer?.latex ?? "";
  const reading = useMathReading(latex, student);
  const symbol = student.symbols[0];
  const { axis } = student;
  const series = useMemo((): PlotSeries[] => {
    if (student.plot === "none" || axis === undefined || symbol === undefined) return [];
    const out: PlotSeries[] = [];
    if (student.target) out.push({ y: student.target, kind: "target", label: s.targetCurve });
    if (reading.ok) out.push({ y: curveOf(reading.reading, symbol, axis.from, axis.to, MATH_PLOT_POINTS), kind: "answer", label: s.yourCurve });
    return out;
  }, [student.plot, student.target, axis, symbol, reading, s.targetCurve, s.yourCurve]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-lg leading-relaxed text-fg">{markdown(renderMarkdown, student.prompt)}</p>
      <div className="flex flex-col gap-1.5">
        <label className={label} htmlFor="math-answer">
          {s.label}
        </label>
        <MathField
          id="math-answer"
          ariaLabel={s.label}
          latexLabel={s.latex}
          value={latex}
          onChange={(next) => onChange({ latex: next })}
          locked={locked}
          className="w-full max-w-lg"
        />
        <p className={caption}>{fmt(s.hint, { symbols: student.symbols.join(", ") })}</p>
        <MathEcho
          reading={latex.trim() === "" ? null : reading.ok ? { latex: reading.reading.latex } : { problem: reading.problem }}
          symbols={student.symbols}
          strings={s}
          renderMarkdown={renderMarkdown}
        />
      </div>
      {student.plot !== "none" && axis ? <Plot axis={axis} series={series} title={s.graph} /> : null}
      {answerKey && answerKey.answers.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className={label}>{s.expected}</span>
          <ul className="flex flex-wrap gap-1.5">
            {answerKey.answers.map((expected, i) => (
              <li key={`${expected.value}-${i}`}>
                <Verdict tone="success">{markdown(renderMarkdown, `$${expected.value}$`)}</Verdict>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
