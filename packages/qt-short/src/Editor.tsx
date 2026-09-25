/**
 * The `short` editor.
 *
 * Controlled and offline: it reads `config`, emits a whole new config through
 * `onChange` and never fetches. An invalid draft is a normal state (decision
 * D16); the host stores it and hands back `issues`.
 *
 * The order of the matchers is the grading order — the first match wins — so
 * the list is reorderable and numbered.
 */
import { useId, type ReactNode } from "react";
import type { ConfigIssue, EditorProps, MarkdownRenderer, StringOverrides } from "@quiz/core/client";
import { issuesAt, resolveStrings, rootIssues } from "@quiz/core/client";
import {
  defaultShortConstraints,
  defaultShortPrefilters,
  SHORT_MAX_ANSWER_LENGTH,
  SHORT_MAX_MATCHERS,
  type ShortConfig,
  type ShortConstraints,
  type ShortKind,
  type ShortMatcher,
} from "./schema.js";
import { explainMatcher } from "./explain.js";
import { shortEditorStrings, type ShortEditorStringKey } from "./strings.js";
import {
  buttonClass,
  CheckboxField,
  cx,
  FieldCell,
  helpClass,
  inputClass,
  IssueList,
  labelClass,
  PromptField,
  removeAt,
  sectionClass,
  Segmented,
} from "@quiz/ui";

type ShortEditorProps = Omit<EditorProps<ShortConfig>, "uploadAsset"> & {
  uploadAsset?: EditorProps<ShortConfig>["uploadAsset"];
  issues?: readonly ConfigIssue[];
  strings?: StringOverrides<ShortEditorStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

type Strings = Readonly<Record<ShortEditorStringKey, string>>;

/**
 * A matcher of the requested kind, with every default in place.
 *
 * The literals are NOT run through `ShortMatcherSchema.parse`: a freshly added
 * matcher is empty, and an empty `value` is exactly what the schema refuses. A
 * draft is allowed to be invalid (decision D16) — publication is where it is
 * not.
 */
function blankMatcher(kind: ShortMatcher["kind"]): ShortMatcher {
  switch (kind) {
    case "exact":
      return { kind, value: "", points: 1 };
    case "regex":
      return { kind, pattern: "", flags: "i", points: 1 };
    case "number":
      return { kind, value: 0, tolerance: 0, toleranceMode: "abs", unitRequired: false, points: 1 };
    case "date":
      return { kind, value: "", toleranceDays: 0, points: 1 };
    case "time":
      return { kind, value: "", toleranceMinutes: 0, points: 1 };
    case "llm":
      return { kind, rubric: "", points: 1 };
  }
}

const MATCHER_LABEL: Record<ShortMatcher["kind"], ShortEditorStringKey> = {
  exact: "matcherExact",
  regex: "matcherRegex",
  number: "matcherNumber",
  date: "matcherDate",
  time: "matcherTime",
  llm: "matcherLlm",
};

/**
 * The label of a field of an accepted answer. The word is visible; the row
 * number is for a screen reader only, so that "Value" of row 2 is announced
 * "Value 2" and never confused with the one of row 1.
 */
const cellLabelClass = "text-xs font-medium text-fg-muted";

function Cell({
  id,
  label,
  index,
  className,
  children,
}: {
  id: string;
  label: string;
  index: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-1", className)}>
      <label className={cellLabelClass} htmlFor={id}>
        {label}
        <span className="sr-only"> {index + 1}</span>
      </label>
      {children}
    </div>
  );
}

/**
 * A relative tolerance is stored as a FRACTION (0.01, as `@quiz/domain`
 * compares it) but typed in percent, as the mode's label promises: the field
 * shows `tolerance × 100` and stores what it reads divided by 100.
 */
const toPercent = (fraction: number) => Number((fraction * 100).toPrecision(12));
const fromPercent = (percent: number) => Number((percent / 100).toPrecision(12));

/**
 * The fields of one accepted answer, as the cells of the row's labelled
 * grid: two columns on a phone, one wrapping line from `sm` up.
 */
function MatcherFields({
  matcher,
  index,
  idBase,
  disabled,
  s,
  onPatch,
}: {
  matcher: ShortMatcher;
  index: number;
  idBase: string;
  disabled: boolean | undefined;
  s: Strings;
  onPatch: (next: ShortMatcher) => void;
}) {
  const id = (name: string) => `${idBase}-${name}`;
  const wide = "col-span-2 sm:min-w-48 sm:flex-1";
  const narrow = cx(inputClass, "w-full tabular-nums sm:w-28");

  switch (matcher.kind) {
    /*
     * One field, and nothing else: the question's prefilters decide whether
     * the case and the outer spaces count, once, for every row of the key.
     */
    case "exact":
      return (
        <Cell id={id("value")} label={s.value} index={index} className={wide}>
          <input
            id={id("value")}
            type="text"
            className={cx(inputClass, "w-full")}
            value={matcher.value}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, value: e.target.value })}
          />
        </Cell>
      );
    case "regex":
      return (
        <>
          <Cell id={id("pattern")} label={s.pattern} index={index} className={wide}>
            <input
              id={id("pattern")}
              type="text"
              className={cx(inputClass, "w-full font-mono text-[13px]")}
              value={matcher.pattern}
              disabled={disabled}
              onChange={(e) => onPatch({ ...matcher, pattern: e.target.value })}
            />
          </Cell>
          <Cell id={id("flags")} label={s.flags} index={index}>
            <input
              id={id("flags")}
              type="text"
              className={cx(inputClass, "w-full font-mono text-[13px] sm:w-20")}
              value={matcher.flags}
              disabled={disabled}
              onChange={(e) => onPatch({ ...matcher, flags: e.target.value })}
            />
          </Cell>
        </>
      );
    case "number": {
      const relative = matcher.toleranceMode === "rel";
      return (
        <>
          <Cell id={id("value")} label={s.value} index={index}>
            <input
              id={id("value")}
              type="number"
              step="any"
              className={narrow}
              value={matcher.value}
              disabled={disabled}
              onChange={(e) => onPatch({ ...matcher, value: Number(e.target.value) })}
            />
          </Cell>
          <Cell
            id={id("tolerance")}
            label={relative ? s.tolerancePercent : s.tolerance}
            index={index}
          >
            <input
              id={id("tolerance")}
              type="number"
              min={0}
              step="any"
              className={narrow}
              value={relative ? toPercent(matcher.tolerance) : matcher.tolerance}
              disabled={disabled}
              onChange={(e) => {
                const typed = Number(e.target.value);
                onPatch({ ...matcher, tolerance: relative ? fromPercent(typed) : typed });
              }}
            />
          </Cell>
          <Cell id={id("mode")} label={s.toleranceMode} index={index}>
            <select
              id={id("mode")}
              className={cx(inputClass, "w-full sm:w-36")}
              value={matcher.toleranceMode}
              disabled={disabled}
              onChange={(e) =>
                onPatch({ ...matcher, toleranceMode: e.target.value === "rel" ? "rel" : "abs" })
              }
            >
              <option value="abs">{s.toleranceAbs}</option>
              <option value="rel">{s.toleranceRel}</option>
            </select>
          </Cell>
          <Cell id={id("unit")} label={s.unit} index={index}>
            <input
              id={id("unit")}
              type="text"
              className={cx(inputClass, "w-full sm:w-24")}
              value={matcher.unit ?? ""}
              disabled={disabled}
              onChange={(e) => {
                const next = { ...matcher };
                if (e.target.value === "") delete next.unit;
                else next.unit = e.target.value;
                onPatch(next);
              }}
            />
          </Cell>
          <div className="col-span-2 flex items-end sm:col-span-1">
            <CheckboxField
              label={s.unitRequired}
              aria-label={`${s.unitRequired} ${index + 1}`}
              checked={matcher.unitRequired}
              disabled={disabled}
              onChange={(unitRequired) => onPatch({ ...matcher, unitRequired })}
            />
          </div>
        </>
      );
    }
    case "date":
      return (
        <>
          <Cell id={id("value")} label={s.value} index={index} className="col-span-2 sm:col-span-1">
            <input
              id={id("value")}
              type="date"
              className={cx(inputClass, "w-full sm:w-40")}
              value={matcher.value}
              disabled={disabled}
              onChange={(e) => onPatch({ ...matcher, value: e.target.value })}
            />
          </Cell>
          <Cell id={id("tolerance")} label={s.toleranceDays} index={index}>
            <input
              id={id("tolerance")}
              type="number"
              min={0}
              step={1}
              className={narrow}
              value={matcher.toleranceDays}
              disabled={disabled}
              onChange={(e) => onPatch({ ...matcher, toleranceDays: Number(e.target.value) })}
            />
          </Cell>
        </>
      );
    case "time":
      return (
        <>
          <Cell id={id("value")} label={s.value} index={index} className="col-span-2 sm:col-span-1">
            <input
              id={id("value")}
              type="time"
              className={cx(inputClass, "w-full sm:w-32")}
              value={matcher.value}
              disabled={disabled}
              onChange={(e) => onPatch({ ...matcher, value: e.target.value })}
            />
          </Cell>
          <Cell id={id("tolerance")} label={s.toleranceMinutes} index={index}>
            <input
              id={id("tolerance")}
              type="number"
              min={0}
              step={1}
              className={narrow}
              value={matcher.toleranceMinutes}
              disabled={disabled}
              onChange={(e) => onPatch({ ...matcher, toleranceMinutes: Number(e.target.value) })}
            />
          </Cell>
        </>
      );
    case "llm":
      return (
        <Cell id={id("rubric")} label={s.rubric} index={index} className={wide}>
          <textarea
            id={id("rubric")}
            rows={2}
            className={cx(inputClass, "w-full resize-y")}
            value={matcher.rubric}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, rubric: e.target.value })}
          />
          <span className="text-xs text-warning">{s.llmWarning}</span>
        </Cell>
      );
  }
}

/**
 * The constraints of the current kind, as the cells of the row the segmented
 * control opens. An empty number or date field means UNBOUNDED, which is why
 * the key is deleted rather than set to 0 or to "".
 */
function withOptionalNumber(
  constraints: ShortConstraints,
  key: "min" | "max",
  raw: string,
): ShortConstraints {
  const next = { ...constraints };
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) delete next[key];
  else next[key] = value;
  return next;
}

function withOptionalDate(
  constraints: ShortConstraints,
  key: "from" | "to",
  raw: string,
): ShortConstraints {
  const next = { ...constraints };
  if (raw === "") delete next[key];
  else next[key] = raw;
  return next;
}

function ConstraintFields({
  kind,
  constraints,
  disabled,
  s,
  onPatch,
}: {
  kind: ShortKind;
  constraints: ShortConstraints;
  disabled: boolean | undefined;
  s: Strings;
  onPatch: (next: ShortConstraints) => void;
}) {
  const numberField = cx(inputClass, "w-28 tabular-nums");

  switch (kind) {
    case "text":
      return (
        <>
          <FieldCell labelClassName={labelClass} label={s.minLength} htmlFor="short-min-length">
            <input
              id="short-min-length"
              type="number"
              min={0}
              max={SHORT_MAX_ANSWER_LENGTH}
              className={numberField}
              value={constraints.minLength}
              disabled={disabled}
              onChange={(e) => onPatch({ ...constraints, minLength: Number(e.target.value) })}
            />
          </FieldCell>
          <FieldCell labelClassName={labelClass} label={s.maxLength} htmlFor="short-max-length">
            <input
              id="short-max-length"
              type="number"
              min={1}
              max={SHORT_MAX_ANSWER_LENGTH}
              className={numberField}
              value={constraints.maxLength}
              disabled={disabled}
              onChange={(e) => onPatch({ ...constraints, maxLength: Number(e.target.value) })}
            />
          </FieldCell>
        </>
      );
    case "number":
      return (
        <>
          <FieldCell labelClassName={labelClass} label={s.min} htmlFor="short-min">
            <input
              id="short-min"
              type="number"
              step="any"
              className={numberField}
              value={constraints.min ?? ""}
              disabled={disabled}
              onChange={(e) => onPatch(withOptionalNumber(constraints, "min", e.target.value))}
            />
          </FieldCell>
          <FieldCell labelClassName={labelClass} label={s.max} htmlFor="short-max">
            <input
              id="short-max"
              type="number"
              step="any"
              className={numberField}
              value={constraints.max ?? ""}
              disabled={disabled}
              onChange={(e) => onPatch(withOptionalNumber(constraints, "max", e.target.value))}
            />
          </FieldCell>
          <CheckboxField
            label={s.integer}
            checked={constraints.integer}
            disabled={disabled}
            onChange={(integer) => onPatch({ ...constraints, integer })}
          />
        </>
      );
    case "date":
      return (
        <>
          <FieldCell labelClassName={labelClass} label={s.from} htmlFor="short-from">
            <input
              id="short-from"
              type="date"
              className={cx(inputClass, "w-40")}
              value={constraints.from ?? ""}
              disabled={disabled}
              onChange={(e) => onPatch(withOptionalDate(constraints, "from", e.target.value))}
            />
          </FieldCell>
          <FieldCell labelClassName={labelClass} label={s.to} htmlFor="short-to">
            <input
              id="short-to"
              type="date"
              className={cx(inputClass, "w-40")}
              value={constraints.to ?? ""}
              disabled={disabled}
              onChange={(e) => onPatch(withOptionalDate(constraints, "to", e.target.value))}
            />
          </FieldCell>
        </>
      );
    /* A time field takes a time. There is nothing to narrow. */
    case "time":
      return null;
  }
}

export function ShortEditor({
  config,
  onChange,
  disabled,
  issues = [],
  strings,
  RichText,
  uploadAsset,
  ungraded = false,
}: ShortEditorProps) {
  const s = resolveStrings(shortEditorStrings, strings);
  const idBase = useId();
  const patch = (next: Partial<ShortConfig>) => onChange({ ...config, ...next });
  /*
   * A draft is stored exactly as it was typed (D16) and a config written by
   * hand, imported, or migrated from v1 may carry a PARTIAL `constraints` —
   * the schema fills the defaults when it parses, the editor never sees that
   * parse. Reading a `value` off an absent key is what turns a controlled
   * input into an uncontrolled one, so the defaults are filled in here.
   */
  const constraints = { ...defaultShortConstraints(), ...config.constraints };
  const prefilters = { ...defaultShortPrefilters(), ...config.prefilters };
  const setMatchers = (matchers: ShortMatcher[]) => patch({ matchers });
  const replace = (index: number, next: ShortMatcher) =>
    setMatchers(config.matchers.map((m, i) => (i === index ? next : m)));

  return (
    <div className="flex flex-col gap-6">
      <IssueList issues={rootIssues(issues)} />

      <section className={sectionClass}>
        <PromptField
          id="short-prompt"
          label={s.prompt}
          value={config.prompt}
          onChange={(prompt) => patch({ prompt })}
          disabled={disabled}
          RichText={RichText}
          uploadImage={uploadAsset}
          labelClassName={labelClass}
          textareaClassName={cx(inputClass, "w-full resize-y font-mono text-[13px]")}
        />
        <IssueList issues={issuesAt(issues, "prompt")} />
      </section>

      {/*
        * The kind and the constraints of that kind, on ONE row: they are one
        * decision ("what does this field take?"), and the constraints are
        * meaningless without the kind beside them. `items-end` plus a 34 px
        * segmented track puts every control of the row on one baseline.
        */}
      <section className={sectionClass}>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="flex flex-col gap-1.5">
            <span className={labelClass} id="short-kind-label">
              {s.kind}
            </span>
            <Segmented
              name="short-kind"
              labelledBy="short-kind-label"
              value={config.kind ?? "text"}
              disabled={disabled}
              onChange={(kind) => patch({ kind })}
              options={[
                { value: "text", label: s.kindText },
                { value: "number", label: s.kindNumber },
                { value: "date", label: s.kindDate },
                { value: "time", label: s.kindTime },
              ]}
            />
          </div>
          <ConstraintFields
            kind={config.kind}
            constraints={constraints}
            disabled={disabled}
            s={s}
            onPatch={(constraints) => patch({ constraints })}
          />
        </div>
        <IssueList issues={issuesAt(issues, "constraints")} />

        <div className="flex flex-col gap-1.5">
          <label className={labelClass} htmlFor="short-placeholder">
            {s.placeholder}
          </label>
          <input
            id="short-placeholder"
            type="text"
            className={cx(inputClass, "w-full")}
            value={config.placeholder ?? ""}
            disabled={disabled}
            onChange={(e) => {
              const next = { ...config };
              if (e.target.value === "") delete next.placeholder;
              else next.placeholder = e.target.value;
              onChange(next);
            }}
          />
        </div>
      </section>

      {/* How the comparison is normalised decides a mark, and a poll gives
          none (`EditorProps.ungraded`): its tally folds spellings by itself. */}
      {ungraded ? null : (
        <section className={sectionClass}>
          <h3 className={labelClass}>{s.prefilters}</h3>
          <p className={helpClass}>{s.prefiltersHint}</p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <CheckboxField
              label={s.prefilterTrim}
              checked={prefilters.trim}
              disabled={disabled}
              onChange={(trim) => patch({ prefilters: { ...prefilters, trim } })}
            />
            <CheckboxField
              label={s.prefilterLowercase}
              checked={prefilters.lowercase}
              disabled={disabled}
              onChange={(lowercase) => patch({ prefilters: { ...prefilters, lowercase } })}
            />
          </div>
        </section>
      )}

      <section className={sectionClass}>
        <h3 className={labelClass}>{s.matchers}</h3>
        <p className={helpClass}>{s.matchersHint}</p>
        <ol className="flex flex-col gap-2">
          {config.matchers.map((matcher, index) => {
            const rowId = `${idBase}-m${index}`;
            const explanation = explainMatcher(matcher, s);
            return (
              <li
                key={index}
                className="flex gap-2 rounded-card border border-line bg-surface-2 px-3 py-2.5"
              >
                {/* On the baseline of the first line of fields, under its labels. */}
                <span className="mt-5 flex h-8.5 w-4 shrink-0 items-center justify-center text-[13px] tabular-nums text-fg-faint">
                  {index + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:flex sm:flex-wrap sm:items-end">
                    <Cell
                      id={`${rowId}-kind`}
                      label={s.matcherKind}
                      index={index}
                      className="col-span-2 sm:col-span-1"
                    >
                      <select
                        id={`${rowId}-kind`}
                        className={cx(inputClass, "w-full sm:w-44")}
                        value={matcher.kind}
                        disabled={disabled}
                        onChange={(e) =>
                          replace(index, blankMatcher(e.target.value as ShortMatcher["kind"]))
                        }
                      >
                        {(Object.keys(MATCHER_LABEL) as ShortMatcher["kind"][]).map((kind) => (
                          <option key={kind} value={kind}>
                            {s[MATCHER_LABEL[kind]]}
                          </option>
                        ))}
                      </select>
                    </Cell>
                    <MatcherFields
                      matcher={matcher}
                      index={index}
                      idBase={rowId}
                      disabled={disabled}
                      s={s}
                      onPatch={(next) => replace(index, next)}
                    />
                    {ungraded ? null : (
                      <Cell
                        id={`${rowId}-points`}
                        label={s.points}
                        index={index}
                        className="col-span-2 sm:col-span-1"
                      >
                        <div className="flex items-center gap-2">
                          <input
                            id={`${rowId}-points`}
                            type="number"
                            min={0}
                            max={1}
                            step={0.25}
                            className={cx(inputClass, "w-20 tabular-nums")}
                            aria-describedby={`${rowId}-points-hint`}
                            value={matcher.points}
                            disabled={disabled}
                            onChange={(e) =>
                              replace(index, { ...matcher, points: Number(e.target.value) })
                            }
                          />
                          <span id={`${rowId}-points-hint`} className={helpClass}>
                            {s.pointsHint}
                          </span>
                        </div>
                      </Cell>
                    )}
                  </div>
                  {explanation === null ? null : (
                    <p className="text-[13px] tabular-nums text-fg-muted">{explanation}</p>
                  )}
                  <IssueList issues={issuesAt(issues, "matchers", index)} />
                </div>
                <button
                  type="button"
                  className={cx(buttonClass, "mt-6 w-7 px-0 text-fg-muted hover:text-danger")}
                  aria-label={`${s.removeMatcher} ${index + 1}`}
                  // A graded question keeps one accepted answer; a poll may
                  // have none (an opinion poll, `keylessConfigSchema`).
                  disabled={disabled || config.matchers.length <= (ungraded ? 0 : 1)}
                  onClick={() => setMatchers(removeAt(config.matchers, index))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ol>
        <IssueList issues={issuesAt(issues, "matchers").filter((i) => i.path.length === 1)} />
        <div>
          <button
            type="button"
            className={buttonClass}
            disabled={disabled || config.matchers.length >= SHORT_MAX_MATCHERS}
            onClick={() => setMatchers([...config.matchers, blankMatcher("exact")])}
          >
            {s.addMatcher}
          </button>
        </div>
      </section>
    </div>
  );
}
