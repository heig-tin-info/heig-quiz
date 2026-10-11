/**
 * The `math` editor: the statement, the VARIABLES the answer may use (each
 * with the interval it is sampled in), the ACCEPTED ANSWERS typed in the
 * same math field the student gets, each echoed as the parser read it, and
 * in the host's right column the comparison's two knobs, the field's
 * forbidden functions and the graph.
 *
 * Controlled and offline, like every editor: it reads `config`, emits a
 * whole new config through `onChange` and never fetches. An invalid draft
 * is a normal state (D16).
 */
import { useId } from "react";

import type { EditorProps, StringOverrides } from "@quiz/core/client";
import { fmt, issuesAt, plural, resolveStrings, rootIssues } from "@quiz/core/client";
import { MATH_FUNCTIONS, type MathFunction } from "@quiz/domain/math";
import {
  AsideSection,
  cx,
  FieldCell,
  hint,
  IssueList,
  label,
  NumberField,
  patchAt,
  PromptField,
  removeAt,
  RemoveRowButton,
  RowList,
  RowListHeader,
  sectionClass,
  Segmented,
  TextInput,
} from "@quiz/ui";

import { MathEcho } from "./MathEcho.js";
import { MathField } from "./MathField.js";
import { useMathReading } from "./reading.js";
import {
  defaultMathSymbol,
  MATH_MAX_ANSWERS,
  MATH_MAX_LATEX,
  MATH_MAX_SAMPLES,
  MATH_MAX_SYMBOLS,
  type MathAnswerKey,
  type MathConfig,
  type MathPlot,
} from "./schema.js";
import { mathEditorStrings, type MathEditorStringKey } from "./strings.js";

type MathEditorProps = EditorProps<MathConfig> & {
  strings?: StringOverrides<MathEditorStringKey>;
};

type Strings = Readonly<Record<MathEditorStringKey, string>>;

/** One accepted answer: the field, its points, and the echo or the problem under it. */
function AnswerRow({
  id,
  index,
  answer,
  symbols,
  disabled,
  s,
  renderMarkdown,
  onChange,
  onRemove,
  removeDisabled,
}: {
  id: string;
  index: number;
  answer: MathAnswerKey;
  symbols: string[];
  disabled: boolean | undefined;
  s: Strings;
  renderMarkdown: EditorProps<MathConfig>["renderMarkdown"];
  onChange: (patch: Partial<MathAnswerKey>) => void;
  onRemove: () => void;
  removeDisabled: boolean;
}) {
  const reading = useMathReading(answer.value, { symbols });
  const n = index + 1;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <FieldCell label={s.answer} htmlFor={`${id}-answer-${index}`} className="min-w-60 flex-1" srSuffix={n}>
          <MathField
            id={`${id}-answer-${index}`}
            ariaLabel={`${s.answer} ${n}`}
            latexLabel={s.latex}
            value={answer.value}
            onChange={(value) => onChange({ value })}
            locked={disabled}
          />
        </FieldCell>
        <NumberField
          id={`${id}-points-${index}`}
          label={s.points}
          aria-label={`${s.points} ${n}`}
          value={answer.points}
          min={0}
          max={1}
          step={0.05}
          disabled={disabled}
          onChange={(points) => onChange({ points })}
        />
        <RemoveRowButton label={fmt(s.removeAnswer, { n })} disabled={disabled || removeDisabled} onClick={onRemove} />
      </div>
      <MathEcho
        reading={answer.value.trim() === "" ? null : reading.ok ? { latex: reading.reading.latex } : { problem: reading.problem }}
        symbols={symbols}
        strings={s}
        renderMarkdown={renderMarkdown}
      />
    </div>
  );
}

/** The function names as toggle chips: a wall of fifteen checkboxes would be the alternative. */
function FunctionChips({
  id,
  label: text,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: readonly MathFunction[];
  onChange: (next: MathFunction[]) => void;
  disabled: boolean | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-labelledby={id}>
      <span className={label} id={id}>
        {text}
      </span>
      <div className="flex flex-wrap gap-1">
        {MATH_FUNCTIONS.map((name) => {
          const on = value.includes(name);
          return (
            <button
              key={name}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onChange(on ? value.filter((f) => f !== name) : [...value, name])}
              className={cx(
                "rounded-full border px-2 py-0.5 font-mono text-xs transition-colors disabled:opacity-40",
                on ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-fg-muted hover:text-fg",
              )}
            >
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function MathEditor({ config, onChange, disabled, issues = [], strings, RichText, uploadAsset, renderMarkdown, aside }: MathEditorProps) {
  const s = resolveStrings(mathEditorStrings, strings);
  const id = useId();
  const patch = (next: Partial<MathConfig>) => onChange({ ...config, ...next });
  const symbols = config.symbols.map((symbol) => symbol.name);

  return (
    <div className="flex flex-col gap-6">
      <IssueList issues={rootIssues(issues)} />

      <section className={sectionClass}>
        <PromptField
          id={`${id}-prompt`}
          label={s.prompt}
          value={config.prompt}
          onChange={(prompt) => patch({ prompt })}
          disabled={disabled}
          RichText={RichText}
          uploadImage={uploadAsset}
        />
        <IssueList issues={issuesAt(issues, "prompt")} />
      </section>

      <section className={sectionClass}>
        <RowListHeader
          title={s.symbols}
          count={plural(s, "symbolsCount", config.symbols.length)}
          addLabel={s.addSymbol}
          addDisabled={disabled || config.symbols.length >= MATH_MAX_SYMBOLS}
          onAdd={() => patch({ symbols: [...config.symbols, defaultMathSymbol(config.symbols.length === 0 ? "x" : "")] })}
        />
        <p className={hint}>{s.symbolsHint}</p>
        <RowList items={config.symbols}>
          {(symbol, i) => (
            <div className="flex flex-wrap items-end gap-3">
              <FieldCell label={s.symbolName} htmlFor={`${id}-symbol-${i}`} srSuffix={i + 1}>
                <TextInput
                  id={`${id}-symbol-${i}`}
                  size="sm"
                  className="w-28 font-mono"
                  aria-label={`${s.symbolName} ${i + 1}`}
                  autoComplete="off"
                  spellCheck={false}
                  value={symbol.name}
                  disabled={disabled}
                  onChange={(e) => patch({ symbols: patchAt(config.symbols, i, { name: e.target.value }) })}
                />
              </FieldCell>
              <NumberField
                id={`${id}-min-${i}`}
                label={s.symbolMin}
                aria-label={`${s.symbolMin} ${i + 1}`}
                value={symbol.min}
                step="any"
                disabled={disabled}
                onChange={(min) => patch({ symbols: patchAt(config.symbols, i, { min }) })}
              />
              <NumberField
                id={`${id}-max-${i}`}
                label={s.symbolMax}
                aria-label={`${s.symbolMax} ${i + 1}`}
                value={symbol.max}
                step="any"
                disabled={disabled}
                onChange={(max) => patch({ symbols: patchAt(config.symbols, i, { max }) })}
              />
              <RemoveRowButton
                label={fmt(s.removeSymbol, { name: symbol.name || String(i + 1) })}
                disabled={disabled || config.symbols.length <= 1}
                onClick={() => patch({ symbols: removeAt(config.symbols, i) })}
              />
              <IssueList issues={issuesAt(issues, "symbols", i)} />
            </div>
          )}
        </RowList>
        <IssueList issues={issuesAt(issues, "symbols").filter((issue) => issue.path.length === 1)} />
      </section>

      <section className={sectionClass}>
        <RowListHeader
          title={s.answers}
          count={plural(s, "answersCount", config.answers.length)}
          addLabel={s.addAnswer}
          addDisabled={disabled || config.answers.length >= MATH_MAX_ANSWERS}
          onAdd={() => patch({ answers: [...config.answers, { value: "", points: 1 }] })}
        />
        <p className={hint}>{s.answersHint}</p>
        <RowList items={config.answers}>
          {(answer, i) => (
            <>
              <AnswerRow
                id={id}
                index={i}
                answer={answer}
                symbols={symbols}
                disabled={disabled}
                s={s}
                renderMarkdown={renderMarkdown}
                onChange={(next) => patch({ answers: patchAt(config.answers, i, next) })}
                onRemove={() => patch({ answers: removeAt(config.answers, i) })}
                removeDisabled={config.answers.length <= 1}
              />
              <IssueList issues={issuesAt(issues, "answers", i)} />
            </>
          )}
        </RowList>
      </section>

      <AsideSection aside={aside}>
        <div className="flex flex-wrap gap-3">
          <NumberField
            id={`${id}-tolerance`}
            label={s.tolerance}
            size="md"
            value={config.tolerance}
            min={0}
            max={0.5}
            step="any"
            disabled={disabled}
            onChange={(tolerance) => patch({ tolerance })}
          />
          <NumberField
            id={`${id}-samples`}
            label={s.samples}
            size="md"
            value={config.samples}
            min={3}
            max={MATH_MAX_SAMPLES}
            step={1}
            disabled={disabled}
            onChange={(samples) => patch({ samples })}
          />
        </div>
        <p className={hint}>{s.toleranceHint}</p>
        <IssueList issues={[...issuesAt(issues, "tolerance"), ...issuesAt(issues, "samples")]} />

        <FunctionChips id={`${id}-forbidden`} label={s.forbidden} value={config.forbidden} disabled={disabled} onChange={(forbidden) => patch({ forbidden })} />
        <p className={hint}>{s.forbiddenHint}</p>
        <IssueList issues={issuesAt(issues, "forbidden")} />

        <NumberField
          id={`${id}-maxLength`}
          label={s.maxLength}
          size="md"
          value={config.maxLength}
          min={10}
          max={MATH_MAX_LATEX}
          step={1}
          disabled={disabled}
          onChange={(maxLength) => patch({ maxLength })}
        />
        <IssueList issues={issuesAt(issues, "maxLength")} />

        <div className="flex flex-col gap-1.5">
          <span className={label} id={`${id}-plot`}>
            {s.plot}
          </span>
          <Segmented<MathPlot>
            name={`${id}-plot`}
            labelledBy={`${id}-plot`}
            value={config.plot}
            wrap
            disabled={disabled || config.symbols.length !== 1}
            onChange={(plot) => patch({ plot })}
            options={[
              { value: "none", label: s.plotNone },
              { value: "answer", label: s.plotAnswer },
              { value: "target", label: s.plotTarget },
            ]}
          />
          <p className={hint}>{s.plotHint}</p>
          <IssueList issues={issuesAt(issues, "plot")} />
        </div>
      </AsideSection>
    </div>
  );
}
