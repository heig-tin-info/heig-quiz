/**
 * The feedback view of a `logic` answer (docs/spec/04 §4.18).
 *
 * Everyone reads the circuit, the score, the right rows and each output's
 * rate. The expected expressions and the failing rows are the key: the
 * teacher reads them, and a student only under a shown key, when the server
 * sent the solution and left the rows in the details (`studentDetails`).
 * This component renders what it was given and never rebuilds a key.
 */
import { fmt, resolveStrings, showsSection } from "@quiz/core/client";
import type { ReviewProps } from "@quiz/core/client";
import { parseExpression, toLatex } from "@quiz/domain/logic";
import {
  breakdownOf,
  card,
  cx,
  HeadRow,
  hint,
  markdown,
  pointsOrDash,
  ReviewPrompt,
  sectionTitle,
  table,
  Th,
} from "@quiz/ui";

import { logicLibrary, SchematicView, type CanvasStrings } from "./canvas/index.js";
import type { LogicAnswer, LogicDetails, LogicSolution, LogicStudent } from "./logicSchema.js";
import { LOGIC_REVIEW_STRINGS, type LogicReviewStrings } from "./logicStrings.js";

interface LogicReviewProps extends ReviewProps<LogicStudent, LogicAnswer, LogicSolution, LogicDetails> {
  strings?: Partial<LogicReviewStrings> | undefined;
  canvasStrings?: Partial<CanvasStrings> | undefined;
}

/** `m = a·b + …` for KaTeX; the expression as typed when it no longer parses. */
function latexOf(name: string, expression: string): string {
  try {
    return `$${name} = ${toLatex(parseExpression(expression))}$`;
  } catch {
    return `${name} = ${expression}`;
  }
}

const percent = (rate: number): string => String(Math.round(rate * 100));

export function LogicReview({
  student,
  answer,
  solution,
  details,
  points,
  maxPoints,
  audience,
  sections,
  strings,
  canvasStrings,
  renderMarkdown,
}: LogicReviewProps) {
  const s = resolveStrings(LOGIC_REVIEW_STRINGS, strings);
  const breakdown = breakdownOf(details, "outputs");
  const showKey = audience === "teacher" ? showsSection(sections, "solution") : solution !== null;
  const expressions = showKey ? (solution?.outputs ?? []) : [];
  const rows = showKey ? (breakdown?.rows ?? []) : [];
  const reason =
    breakdown?.reason === "ports_mismatch"
      ? s.reasonPortsMismatch
      : breakdown?.reason === "palette_violation"
        ? s.reasonPaletteViolation
        : null;

  return (
    <div className="flex flex-col gap-4">
      <ReviewPrompt preWrap prompt={student.prompt} sections={sections} renderMarkdown={renderMarkdown} />

      <span className={cx(sectionTitle, "tabular-nums")}>
        {fmt(s.score, { points: pointsOrDash(points), max: maxPoints })}
      </span>
      {reason === null ? null : <p className="text-[13px] text-warning">{reason}</p>}

      {answer?.schematic === undefined ? (
        <p className={hint}>{s.noAnswer}</p>
      ) : (
        <section className={cx(card, "flex flex-col gap-2 p-4")}>
          <h3 className={sectionTitle}>{s.yourCircuit}</h3>
          <SchematicView
            schematic={answer.schematic}
            library={logicLibrary(student.symbols)}
            {...(canvasStrings === undefined ? {} : { strings: canvasStrings })}
          />
        </section>
      )}

      {breakdown === null || reason !== null || breakdown.reason === "empty" ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-medium text-fg tabular-nums">
            {fmt(s.rightRows, { right: breakdown.right, total: breakdown.total })}
          </p>
          <div className="overflow-x-auto">
            <table className={table.table}>
              <HeadRow>
                <Th>{s.output}</Th>
                <Th right>{s.rate}</Th>
              </HeadRow>
              <tbody>
                {breakdown.outputs.map((output) => (
                  <tr key={output.name} className={table.row}>
                    <td className={cx(table.td, "font-mono font-medium")}>{output.name}</td>
                    <td className={cx(table.td, "text-right tabular-nums")}>
                      {fmt(s.percent, { percent: percent(output.rate) })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {expressions.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h3 className={sectionTitle}>{s.expressions}</h3>
          {expressions.map((output) => (
            <div key={output.name} className="text-sm text-fg">
              {markdown(renderMarkdown, latexOf(output.name, output.expression))}
            </div>
          ))}
        </section>
      )}

      {rows.length === 0 || breakdown === null ? null : (
        <section className="flex flex-col gap-2">
          <h3 className={sectionTitle}>{s.failing}</h3>
          {breakdown.total - breakdown.right > rows.length ? (
            <p className={hint}>{fmt(s.failingFirst, { n: rows.length })}</p>
          ) : null}
          <div className="overflow-x-auto">
            <table className={table.table}>
              <HeadRow>
                {breakdown.inputs.map((name) => (
                  <Th key={`i-${name}`}>{name}</Th>
                ))}
                {breakdown.outputs.map(({ name }) => (
                  <Th key={`a-${name}`}>{name}</Th>
                ))}
                {breakdown.outputs.map(({ name }) => (
                  <Th key={`e-${name}`}>{fmt(s.expectedOf, { name })}</Th>
                ))}
              </HeadRow>
              <tbody className="font-mono tabular-nums">
                {rows.map((row, i) => (
                  <tr key={i} className={table.row}>
                    {row.inputs.map((bit, k) => (
                      <td key={`i${k}`} className={table.td}>
                        {bit}
                      </td>
                    ))}
                    {row.actual.map((value, k) => (
                      <td key={`a${k}`} className={cx(table.td, value !== row.expected[k] && "font-semibold text-danger")}>
                        {value}
                      </td>
                    ))}
                    {row.expected.map((bit, k) => (
                      <td key={`e${k}`} className={cx(table.td, "text-info")}>
                        {bit}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

export default LogicReview;
