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

function MatcherFields({
  matcher,
  index,
  disabled,
  s,
  onPatch,
}: {
  matcher: ShortMatcher;
  index: number;
  disabled: boolean | undefined;
  s: Strings;
  onPatch: (next: ShortMatcher) => void;
}) {
  const at = (label: string) => `${label} ${index + 1}`;
  const field = cx(inputClass, "w-full");

  switch (matcher.kind) {
    /*
     * One field, and nothing else: the question's prefilters decide whether
     * the case and the outer spaces count, once, for every row of the key.
     */
    case "exact":
      return (
        <input
          type="text"
          className={field}
          aria-label={at(s.value)}
          value={matcher.value}
          disabled={disabled}
          onChange={(e) => onPatch({ ...matcher, value: e.target.value })}
        />
      );
    case "regex":
      return (
        <>
          <input
            type="text"
            className={cx(field, "font-mono text-[13px]")}
            aria-label={at(s.pattern)}
            value={matcher.pattern}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, pattern: e.target.value })}
          />
          <input
            type="text"
            className={cx(inputClass, "w-20 font-mono text-[13px]")}
            aria-label={at(s.flags)}
            value={matcher.flags}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, flags: e.target.value })}
          />
        </>
      );
    case "number":
      return (
        <>
          <input
            type="number"
            className={cx(inputClass, "w-28 tabular-nums")}
            aria-label={at(s.value)}
            value={matcher.value}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, value: Number(e.target.value) })}
          />
          <input
            type="number"
            min={0}
            step="any"
            className={cx(inputClass, "w-24 tabular-nums")}
            aria-label={at(s.tolerance)}
            value={matcher.tolerance}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, tolerance: Number(e.target.value) })}
          />
          <select
            className={cx(inputClass, "w-32")}
            aria-label={at(s.tolerance)}
            value={matcher.toleranceMode}
            disabled={disabled}
            onChange={(e) =>
              onPatch({ ...matcher, toleranceMode: e.target.value === "rel" ? "rel" : "abs" })
            }
          >
            <option value="abs">{s.toleranceAbs}</option>
            <option value="rel">{s.toleranceRel}</option>
          </select>
          <input
            type="text"
            className={cx(inputClass, "w-24")}
            aria-label={at(s.unit)}
            value={matcher.unit ?? ""}
            disabled={disabled}
            onChange={(e) => {
              const next = { ...matcher };
              if (e.target.value === "") delete next.unit;
              else next.unit = e.target.value;
              onPatch(next);
            }}
          />
          <CheckboxField
            className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted"
            label={s.unitRequired}
            checked={matcher.unitRequired}
            disabled={disabled}
            onChange={(unitRequired) => onPatch({ ...matcher, unitRequired })}
          />
        </>
      );
    case "date":
      return (
        <>
          <input
            type="date"
            className={cx(inputClass, "w-40")}
            aria-label={at(s.value)}
            value={matcher.value}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, value: e.target.value })}
          />
          <input
            type="number"
            min={0}
            className={cx(inputClass, "w-24 tabular-nums")}
            aria-label={at(s.toleranceDays)}
            value={matcher.toleranceDays}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, toleranceDays: Number(e.target.value) })}
          />
        </>
      );
    case "time":
      return (
        <>
          <input
            type="time"
            className={cx(inputClass, "w-32")}
            aria-label={at(s.value)}
            value={matcher.value}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, value: e.target.value })}
          />
          <input
            type="number"
            min={0}
            className={cx(inputClass, "w-24 tabular-nums")}
            aria-label={at(s.toleranceMinutes)}
            value={matcher.toleranceMinutes}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, toleranceMinutes: Number(e.target.value) })}
          />
        </>
      );
    case "llm":
      return (
        <>
          <textarea
            rows={2}
            className={cx(field, "resize-y")}
            aria-label={at(s.rubric)}
            value={matcher.rubric}
            disabled={disabled}
            onChange={(e) => onPatch({ ...matcher, rubric: e.target.value })}
          />
          <span className="text-xs text-warning">{s.llmWarning}</span>
        </>
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
          {config.matchers.map((matcher, index) => (
            <li
              key={index}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2"
            >
              <span className="w-4 shrink-0 text-center text-[13px] tabular-nums text-fg-faint">
                {index + 1}
              </span>
              <select
                className={cx(inputClass, "w-44")}
                aria-label={`${s.matcherKind} ${index + 1}`}
                value={matcher.kind}
                disabled={disabled}
                onChange={(e) => replace(index, blankMatcher(e.target.value as ShortMatcher["kind"]))}
              >
                {(Object.keys(MATCHER_LABEL) as ShortMatcher["kind"][]).map((kind) => (
                  <option key={kind} value={kind}>
                    {s[MATCHER_LABEL[kind]]}
                  </option>
                ))}
              </select>
              <MatcherFields
                matcher={matcher}
                index={index}
                disabled={disabled}
                s={s}
                onPatch={(next) => replace(index, next)}
              />
              {ungraded ? null : (
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.25}
                  className={cx(inputClass, "w-20 tabular-nums")}
                  aria-label={`${s.points} ${index + 1}`}
                  value={matcher.points}
                  disabled={disabled}
                  onChange={(e) => replace(index, { ...matcher, points: Number(e.target.value) })}
                />
              )}
              <button
                type="button"
                className={cx(buttonClass, "ml-auto w-7 px-0 text-fg-muted hover:text-danger")}
                aria-label={`${s.removeMatcher} ${index + 1}`}
                // A graded question keeps one accepted answer; a poll may
                // have none (an opinion poll, `keylessConfigSchema`).
                disabled={disabled || config.matchers.length <= (ungraded ? 0 : 1)}
                onClick={() => setMatchers(removeAt(config.matchers, index))}
              >
                ×
              </button>
              <div className="w-full">
                <IssueList issues={issuesAt(issues, "matchers", index)} />
              </div>
            </li>
          ))}
        </ol>
        <IssueList issues={issuesAt(issues, "matchers").filter((i) => i.path.length === 1)} />
        {ungraded ? null : <p className={helpClass}>{s.pointsHint}</p>}
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
