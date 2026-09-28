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
import { useId } from "react";
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
  caption,
  CheckboxField,
  cx,
  FieldCell,
  hint,
  inputClass,
  inputSize,
  IssueList,
  label,
  NumberField,
  PromptField,
  removeAt,
  sectionClass,
  Segmented,
  textareaClass,
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
 * The chrome of a field of an accepted answer (`FieldCell`). The word is
 * visible; the row number is for a screen reader only, so that "Value" of
 * row 2 is announced "Value 2" and never confused with the one of row 1.
 */
const rowCell = (index: number, className?: string) => ({
  labelClassName: "text-xs font-medium text-fg-muted",
  gap: "gap-1",
  srSuffix: index + 1,
  className: cx("min-w-0", className),
});

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
  const narrow = { size: "md", width: "w-full sm:w-28" } as const;

  switch (matcher.kind) {
    /*
     * One field, and nothing else: the question's prefilters decide whether
     * the case and the outer spaces count, once, for every row of the key.
     */
    case "exact":
      return (
        <FieldCell label={s.value} htmlFor={id("value")} {...rowCell(index, wide)}>
          <input
            id={id("value")}
            type="text"
            className={cx(inputClass, inputSize.md, "w-full")}
            value={matcher.value}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, value: e.target.value })}
          />
        </FieldCell>
      );
    case "regex":
      return (
        <>
          <FieldCell label={s.pattern} htmlFor={id("pattern")} {...rowCell(index, wide)}>
            <input
              id={id("pattern")}
              type="text"
              className={cx(inputClass, inputSize.md, "w-full font-mono text-[13px]")}
              value={matcher.pattern}
              disabled={disabled}
              onChange={(e) => onPatch({ ...matcher, pattern: e.target.value })}
            />
          </FieldCell>
          <FieldCell label={s.flags} htmlFor={id("flags")} {...rowCell(index)}>
            <input
              id={id("flags")}
              type="text"
              className={cx(inputClass, inputSize.md, "w-full font-mono text-[13px] sm:w-20")}
              value={matcher.flags}
              disabled={disabled}
              onChange={(e) => onPatch({ ...matcher, flags: e.target.value })}
            />
          </FieldCell>
        </>
      );
    case "number": {
      const relative = matcher.toleranceMode === "rel";
      return (
        <>
          <NumberField
            id={id("value")}
            label={s.value}
            {...rowCell(index)}
            {...narrow}
            step="any"
            value={matcher.value}
            disabled={disabled}
            onChange={(value) => onPatch({ ...matcher, value })}
          />
          <NumberField
            id={id("tolerance")}
            label={relative ? s.tolerancePercent : s.tolerance}
            {...rowCell(index)}
            {...narrow}
            min={0}
            step="any"
            value={relative ? toPercent(matcher.tolerance) : matcher.tolerance}
            disabled={disabled}
            onChange={(typed) =>
              onPatch({ ...matcher, tolerance: relative ? fromPercent(typed) : typed })
            }
          />
          <FieldCell label={s.toleranceMode} htmlFor={id("mode")} {...rowCell(index)}>
            <select
              id={id("mode")}
              className={cx(inputClass, inputSize.md, "w-full sm:w-36")}
              value={matcher.toleranceMode}
              disabled={disabled}
              onChange={(e) =>
                onPatch({ ...matcher, toleranceMode: e.target.value === "rel" ? "rel" : "abs" })
              }
            >
              <option value="abs">{s.toleranceAbs}</option>
              <option value="rel">{s.toleranceRel}</option>
            </select>
          </FieldCell>
          <FieldCell label={s.unit} htmlFor={id("unit")} {...rowCell(index)}>
            <input
              id={id("unit")}
              type="text"
              className={cx(inputClass, inputSize.md, "w-full sm:w-24")}
              value={matcher.unit ?? ""}
              disabled={disabled}
              onChange={(e) => {
                const next = { ...matcher };
                if (e.target.value === "") delete next.unit;
                else next.unit = e.target.value;
                onPatch(next);
              }}
            />
          </FieldCell>
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
          <FieldCell
            label={s.value}
            htmlFor={id("value")}
            {...rowCell(index, "col-span-2 sm:col-span-1")}
          >
            <input
              id={id("value")}
              type="date"
              className={cx(inputClass, inputSize.md, "w-full sm:w-40")}
              value={matcher.value}
              disabled={disabled}
              onChange={(e) => onPatch({ ...matcher, value: e.target.value })}
            />
          </FieldCell>
          <NumberField
            id={id("tolerance")}
            label={s.toleranceDays}
            {...rowCell(index)}
            {...narrow}
            min={0}
            step={1}
            value={matcher.toleranceDays}
            disabled={disabled}
            onChange={(toleranceDays) => onPatch({ ...matcher, toleranceDays })}
          />
        </>
      );
    case "time":
      return (
        <>
          <FieldCell
            label={s.value}
            htmlFor={id("value")}
            {...rowCell(index, "col-span-2 sm:col-span-1")}
          >
            <input
              id={id("value")}
              type="time"
              className={cx(inputClass, inputSize.md, "w-full sm:w-32")}
              value={matcher.value}
              disabled={disabled}
              onChange={(e) => onPatch({ ...matcher, value: e.target.value })}
            />
          </FieldCell>
          <NumberField
            id={id("tolerance")}
            label={s.toleranceMinutes}
            {...rowCell(index)}
            {...narrow}
            min={0}
            step={1}
            value={matcher.toleranceMinutes}
            disabled={disabled}
            onChange={(toleranceMinutes) => onPatch({ ...matcher, toleranceMinutes })}
          />
        </>
      );
    case "llm":
      return (
        <FieldCell label={s.rubric} htmlFor={id("rubric")} {...rowCell(index, wide)}>
          <textarea
            id={id("rubric")}
            rows={2}
            className={cx(textareaClass, "w-full resize-y")}
            value={matcher.rubric}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, rubric: e.target.value })}
          />
          <span className="text-xs text-warning">{s.llmWarning}</span>
        </FieldCell>
      );
  }
}

/**
 * The constraints of the current kind, as the cells of the row the segmented
 * control opens. An empty number or date field means UNBOUNDED, which is why
 * the key is deleted rather than set to 0 or to "".
 */
function withBound<K extends "min" | "max" | "from" | "to">(
  constraints: ShortConstraints,
  key: K,
  value: ShortConstraints[K] | undefined,
): ShortConstraints {
  const next = { ...constraints };
  if (value === undefined) delete next[key];
  else next[key] = value;
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
  const field = { size: "md" } as const;

  switch (kind) {
    case "text":
      return (
        <>
          <NumberField
            id="short-min-length"
            label={s.minLength}
            {...field}
            min={0}
            max={SHORT_MAX_ANSWER_LENGTH}
            value={constraints.minLength}
            disabled={disabled}
            onChange={(minLength) => onPatch({ ...constraints, minLength })}
          />
          <NumberField
            id="short-max-length"
            label={s.maxLength}
            {...field}
            min={1}
            max={SHORT_MAX_ANSWER_LENGTH}
            value={constraints.maxLength}
            disabled={disabled}
            onChange={(maxLength) => onPatch({ ...constraints, maxLength })}
          />
        </>
      );
    case "number":
      return (
        <>
          <NumberField
            id="short-min"
            label={s.min}
            {...field}
            step="any"
            value={constraints.min ?? null}
            disabled={disabled}
            onChange={(min) => onPatch(withBound(constraints, "min", min))}
            onClear={() => onPatch(withBound(constraints, "min", undefined))}
          />
          <NumberField
            id="short-max"
            label={s.max}
            {...field}
            step="any"
            value={constraints.max ?? null}
            disabled={disabled}
            onChange={(max) => onPatch(withBound(constraints, "max", max))}
            onClear={() => onPatch(withBound(constraints, "max", undefined))}
          />
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
          <FieldCell label={s.from} htmlFor="short-from">
            <input
              id="short-from"
              type="date"
              className={cx(inputClass, inputSize.md, "w-40")}
              value={constraints.from ?? ""}
              disabled={disabled}
              onChange={(e) => onPatch(withBound(constraints, "from", e.target.value || undefined))}
            />
          </FieldCell>
          <FieldCell label={s.to} htmlFor="short-to">
            <input
              id="short-to"
              type="date"
              className={cx(inputClass, inputSize.md, "w-40")}
              value={constraints.to ?? ""}
              disabled={disabled}
              onChange={(e) => onPatch(withBound(constraints, "to", e.target.value || undefined))}
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
            <span className={label} id="short-kind-label">
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
          <label className={label} htmlFor="short-placeholder">
            {s.placeholder}
          </label>
          <input
            id="short-placeholder"
            type="text"
            className={cx(inputClass, inputSize.md, "w-full")}
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
          <h3 className={label}>{s.prefilters}</h3>
          <p className={hint}>{s.prefiltersHint}</p>
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
        <h3 className={label}>{s.matchers}</h3>
        <p className={hint}>{s.matchersHint}</p>
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
                    <FieldCell
                      label={s.matcherKind}
                      htmlFor={`${rowId}-kind`}
                      {...rowCell(index, "col-span-2 sm:col-span-1")}
                    >
                      <select
                        id={`${rowId}-kind`}
                        className={cx(inputClass, inputSize.md, "w-full sm:w-44")}
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
                    </FieldCell>
                    <MatcherFields
                      matcher={matcher}
                      index={index}
                      idBase={rowId}
                      disabled={disabled}
                      s={s}
                      onPatch={(next) => replace(index, next)}
                    />
                    {ungraded ? null : (
                      <FieldCell
                        label={s.points}
                        htmlFor={`${rowId}-points`}
                        {...rowCell(index, "col-span-2 sm:col-span-1")}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            id={`${rowId}-points`}
                            type="number"
                            min={0}
                            max={1}
                            step={0.25}
                            className={cx(inputClass, inputSize.md, "w-20 tabular-nums")}
                            aria-describedby={`${rowId}-points-hint`}
                            value={matcher.points}
                            disabled={disabled}
                            onChange={(e) =>
                              replace(index, { ...matcher, points: Number(e.target.value) })
                            }
                          />
                          {/* An aside in a dense row whose labels are 12 px:
                              a caption, not a 13 px hint. */}
                          <span id={`${rowId}-points-hint`} className={caption}>
                            {s.pointsHint}
                          </span>
                        </div>
                      </FieldCell>
                    )}
                  </div>
                  {explanation === null ? null : (
                    <p className="text-[13px] tabular-nums text-fg-muted">{explanation}</p>
                  )}
                  <IssueList issues={issuesAt(issues, "matchers", index)} />
                </div>
                <button
                  type="button"
                  className={buttonClass("secondary", "sm", "mt-6 w-7 px-0 text-fg-muted hover:text-danger")}
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
            className={buttonClass("secondary", "sm")}
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
