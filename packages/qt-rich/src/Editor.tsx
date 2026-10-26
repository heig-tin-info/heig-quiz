/**
 * The `rich` editor: the statement, then what the GRADER reads — the
 * criteria (ADR-118), the grading instructions and an optional model answer
 * — and, in the host's right column, the two settings of the student's
 * field, its format and its limit, and the points the criteria are worth.
 *
 * Controlled and offline, like every editor: it reads `config`, emits a whole
 * new config through `onChange` and never fetches. An invalid draft is a
 * normal state (decision D16).
 */
import { useId } from "react";

import type { EditorProps, StringOverrides } from "@quiz/core/client";
import { fmt, issuesAt, plural, resolveStrings, rootIssues } from "@quiz/core/client";
import { newId } from "@quiz/core/id";
import {
  AsideSection,
  cx,
  FieldCell,
  hint,
  IconButton,
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
  StrokeIcon,
  TextInput,
  textareaClass,
} from "@quiz/ui";

import {
  CHARS_PER_A4_PAGE,
  criteriaPoints,
  pagesText,
  RICH_MAX_CHARS,
  RICH_MAX_CRITERIA,
  RICH_MAX_WEIGHT,
  type RichConfig,
  type RichCriterion,
  type RichFormat,
} from "./schema.js";
import { richEditorStrings, type RichEditorStringKey } from "./strings.js";

type RichEditorProps = EditorProps<RichConfig> & {
  strings?: StringOverrides<RichEditorStringKey>;
};

export function RichEditor({
  config,
  onChange,
  disabled,
  issues = [],
  strings,
  RichText,
  uploadAsset,
  aside,
}: RichEditorProps) {
  const s = resolveStrings(richEditorStrings, strings);
  const id = useId();
  const patch = (next: Partial<RichConfig>) => onChange({ ...config, ...next });
  const criteria = config.criteria ?? [];
  const setCriteria = (next: RichCriterion[]) => patch({ criteria: next });
  /** The criterion at `i` swapped with the one above it: the one reorder, enough for a dozen rows. */
  const moveUp = (i: number) => {
    const next = [...criteria];
    [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
    setCriteria(next);
  };
  /** Optional fields are ABSENT when empty, never `""` or `0`: the schema reads absence. */
  const withOptional = <K extends "reference" | "maxChars">(key: K, value: RichConfig[K] | undefined) => {
    const next = { ...config };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };

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
          title={s.criteria}
          count={plural(s, "criteriaCount", criteria.length)}
          addLabel={s.addCriterion}
          addDisabled={disabled || criteria.length >= RICH_MAX_CRITERIA}
          onAdd={() => setCriteria([...criteria, { id: newId(), title: "", weight: 1, prompt: "" }])}
        />
        <p className={hint}>{s.criteriaHint}</p>
        <RowList items={criteria}>
          {(criterion, i) => {
            const n = i + 1;
            return (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-end gap-3">
                  <FieldCell label={s.criterionTitle} htmlFor={`${id}-criterion-${i}`} className="min-w-40 flex-1">
                    <TextInput
                      id={`${id}-criterion-${i}`}
                      size="sm"
                      className="w-full font-medium"
                      aria-label={fmt(s.criterionTitleAria, { n })}
                      maxLength={120}
                      disabled={disabled}
                      value={criterion.title}
                      onChange={(e) => setCriteria(patchAt(criteria, i, { title: e.target.value }))}
                    />
                  </FieldCell>
                  <NumberField
                    id={`${id}-weight-${i}`}
                    label={s.criterionWeight}
                    aria-label={fmt(s.criterionWeightAria, { n })}
                    value={criterion.weight}
                    min={1}
                    max={RICH_MAX_WEIGHT}
                    step={1}
                    width="w-20"
                    disabled={disabled}
                    onChange={(weight) => setCriteria(patchAt(criteria, i, { weight }))}
                  />
                  <IconButton
                    label={fmt(s.moveCriterionUp, { n })}
                    disabled={disabled || i === 0}
                    onClick={() => moveUp(i)}
                  >
                    <StrokeIcon strokeWidth={1.7}>
                      <path d="M12 19V5M6 11l6-6 6 6" />
                    </StrokeIcon>
                  </IconButton>
                  <RemoveRowButton
                    label={fmt(s.removeCriterion, { n })}
                    disabled={disabled}
                    onClick={() => setCriteria(removeAt(criteria, i))}
                  />
                </div>
                <FieldCell label={s.criterionPrompt} htmlFor={`${id}-criterion-prompt-${i}`}>
                  <textarea
                    id={`${id}-criterion-prompt-${i}`}
                    rows={2}
                    aria-label={fmt(s.criterionPromptAria, { n })}
                    maxLength={2_000}
                    className={cx(textareaClass, "w-full")}
                    disabled={disabled}
                    value={criterion.prompt}
                    onChange={(e) => setCriteria(patchAt(criteria, i, { prompt: e.target.value }))}
                  />
                </FieldCell>
                <IssueList issues={issuesAt(issues, "criteria", i)} />
              </div>
            );
          }}
        </RowList>
        <IssueList issues={issuesAt(issues, "criteria").filter((issue) => issue.path.length === 1)} />
      </section>

      <section className={sectionClass}>
        <PromptField
          id={`${id}-rubric`}
          label={s.rubric}
          value={config.rubric ?? ""}
          onChange={(rubric) => patch({ rubric })}
          disabled={disabled}
          RichText={RichText}
        />
        <p className={hint}>{s.rubricHint}</p>
        <IssueList issues={issuesAt(issues, "rubric")} />
      </section>

      <section className={sectionClass}>
        <PromptField
          id={`${id}-reference`}
          label={s.reference}
          value={config.reference ?? ""}
          onChange={(reference) => withOptional("reference", reference === "" ? undefined : reference)}
          disabled={disabled}
          RichText={RichText}
        />
        <p className={hint}>{s.referenceHint}</p>
        <IssueList issues={issuesAt(issues, "reference")} />
      </section>

      <AsideSection aside={aside}>
        <div className="flex flex-col gap-1.5">
          <span className={label} id={`${id}-format`}>
            {s.format}
          </span>
          <Segmented<RichFormat>
            name={`${id}-format`}
            labelledBy={`${id}-format`}
            value={config.format ?? "markdown"}
            disabled={disabled}
            onChange={(format) => patch({ format })}
            options={[
              { value: "markdown", label: s.formatMarkdown },
              { value: "plain", label: s.formatPlain },
            ]}
          />
          <p className={hint}>{s.formatHint}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <NumberField
            id={`${id}-max`}
            label={s.maxChars}
            size="md"
            min={1}
            max={RICH_MAX_CHARS}
            step={1}
            value={config.maxChars ?? null}
            disabled={disabled}
            onChange={(maxChars) => withOptional("maxChars", maxChars)}
            onClear={() => withOptional("maxChars", undefined)}
          />
          <p className={hint}>
            {config.maxChars === undefined
              ? fmt(s.maxCharsHint, { cap: RICH_MAX_CHARS, perPage: CHARS_PER_A4_PAGE })
              : fmt(s.maxCharsPages, { pages: pagesText(config.maxChars, s.decimal) })}
          </p>
          <IssueList issues={issuesAt(issues, "maxChars")} />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className={label}>{fmt(s.defaultPoints, { n: criteriaPoints(criteria) })}</span>
          <p className={hint}>{s.defaultPointsHint}</p>
        </div>

        <p className={hint}>{s.manualGrading}</p>
      </AsideSection>
    </div>
  );
}
