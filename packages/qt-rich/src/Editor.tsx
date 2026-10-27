/**
 * The `rich` editor: the statement, then what the GRADER reads — the
 * criteria (ADR-118), the grading instructions (folded beside criteria, an
 * old barème to convert without them) and an optional model answer
 * — and, in the host's right column, the two settings of the student's
 * field, its format and its limit, and the points the criteria are worth.
 *
 * Controlled and offline, like every editor: it reads `config`, emits a whole
 * new config through `onChange` and never fetches. An invalid draft is a
 * normal state (decision D16).
 */
import { useId } from "react";

import type { EditorProps, StringOverrides } from "@quiz/core/client";
import type { GenerateTarget } from "@quiz/core/generate";
import { fmt, issuesAt, plural, resolveStrings, rootIssues } from "@quiz/core/client";
import { newId } from "@quiz/core/id";
import {
  AdvancedDisclosure,
  AsideSection,
  Button,
  cx,
  FieldCell,
  hint,
  IssueList,
  label,
  NumberField,
  patchAt,
  PromptField,
  removeAt,
  RowHead,
  RowList,
  RowListHeader,
  sectionClass,
  Segmented,
  textareaClass,
  useWandRunner,
  WandIcon,
} from "@quiz/ui";

import {
  CHARS_PER_A4_PAGE,
  criteriaPoints,
  pagesText,
  RICH_MAX_CHARS,
  RICH_MAX_CRITERIA,
  RICH_MAX_CRITERION_PROMPT,
  RICH_MAX_CRITERION_TITLE,
  RICH_MAX_WEIGHT,
  RICH_TARGETS,
  type RichConfig,
  type RichCriterion,
  type RichFormat,
} from "./schema.js";
import { richEditorStrings, type RichEditorStringKey } from "./strings.js";

type RichEditorProps = EditorProps<RichConfig> & {
  strings?: StringOverrides<RichEditorStringKey>;
};

/** A target's own key, for the wand that waits: its kind, and the criterion it is about. */
const targetKey = (target: GenerateTarget) => (target.id === undefined ? target.kind : `${target.kind}:${target.id}`);

const CONVERT: GenerateTarget = { kind: RICH_TARGETS.criteriaFromRubric };

/**
 * A wand of one part of the draft (ADR-059, ADR-118): a secondary button,
 * Save stays the screen's one primary. It pulses while its request runs.
 */
function WandButton({
  label: text,
  ariaLabel,
  running,
  disabled,
  onClick,
}: {
  label: string;
  ariaLabel?: string;
  running: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      className={cx(running && "animate-pulse")}
      aria-busy={running || undefined}
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      disabled={disabled}
      onClick={onClick}
    >
      <WandIcon />
      {text}
    </Button>
  );
}

export function RichEditor({
  config,
  onChange,
  disabled,
  issues = [],
  strings,
  RichText,
  uploadAsset,
  aside,
  onGenerateTarget,
}: RichEditorProps) {
  const s = resolveStrings(richEditorStrings, strings);
  const id = useId();
  const patch = (next: Partial<RichConfig>) => onChange({ ...config, ...next });
  const criteria = Array.isArray(config.criteria) ? config.criteria : [];
  const rubric = config.rubric ?? "";
  /** An essay from before criteria: its whole barème is the rubric, which the wand converts. */
  const legacyRubric = criteria.length === 0 && rubric.trim() !== "";
  /** The target whose wand waits for the model, by its key; one at a time. */
  const { running, run } = useWandRunner<string>();
  const wand =
    onGenerateTarget === undefined || disabled
      ? null
      : (target: GenerateTarget) => run(targetKey(target), () => onGenerateTarget(target));
  /** The props of the wand button of one target. */
  const wandState = (target: GenerateTarget) => ({
    running: running === targetKey(target),
    onClick: () => wand?.(target),
  });
  const setCriteria = (next: RichCriterion[]) => patch({ criteria: next });
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
                <RowHead
                  disabled={disabled}
                  nameId={`${id}-criterion-${i}`}
                  nameLabel={s.criterionTitle}
                  nameAriaLabel={fmt(s.criterionTitleAria, { n })}
                  name={criterion.title}
                  nameMaxLength={RICH_MAX_CRITERION_TITLE}
                  onNameChange={(title) => setCriteria(patchAt(criteria, i, { title }))}
                  pointsId={`${id}-weight-${i}`}
                  pointsLabel={s.criterionWeight}
                  pointsAriaLabel={fmt(s.criterionWeightAria, { n })}
                  points={criterion.weight}
                  pointsMin={1}
                  pointsMax={RICH_MAX_WEIGHT}
                  pointsStep={1}
                  onPointsChange={(weight) => setCriteria(patchAt(criteria, i, { weight }))}
                  removeLabel={fmt(s.removeCriterion, { n })}
                  removeDisabled={disabled}
                  onRemove={() => setCriteria(removeAt(criteria, i))}
                />
                <FieldCell label={s.criterionPrompt} htmlFor={`${id}-criterion-prompt-${i}`}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                    <textarea
                      id={`${id}-criterion-prompt-${i}`}
                      rows={2}
                      aria-label={fmt(s.criterionPromptAria, { n })}
                      placeholder={s.criterionPromptPlaceholder}
                      maxLength={RICH_MAX_CRITERION_PROMPT}
                      className={cx(textareaClass, "w-full sm:flex-1")}
                      disabled={disabled}
                      value={criterion.prompt}
                      onChange={(e) => setCriteria(patchAt(criteria, i, { prompt: e.target.value }))}
                    />
                    {wand ? (
                      <WandButton
                        label={s.generatePrompt}
                        ariaLabel={fmt(s.generatePromptAria, { n })}
                        {...wandState({ kind: RICH_TARGETS.criterionPrompt, id: criterion.id })}
                        disabled={running !== null || criterion.title.trim() === ""}
                      />
                    ) : null}
                  </div>
                </FieldCell>
                <IssueList issues={issuesAt(issues, "criteria", i)} />
              </div>
            );
          }}
        </RowList>
        <IssueList issues={issuesAt(issues, "criteria").filter((issue) => issue.path.length === 1)} />
      </section>

      {/* The rubric, folded unless written at mount (ADR-118): beside
          criteria it is global context; alone, it is an essay's whole grading
          scheme from before criteria, which the wand converts. One fold in
          both cases, so typing in it never remounts the field. */}
      <section className={sectionClass}>
        <AdvancedDisclosure
          plain
          defaultOpen={rubric.trim() !== ""}
          summary={legacyRubric ? s.rubric : s.globalRubric}
          className="flex flex-col gap-2"
        >
          <p className={hint}>{legacyRubric ? s.rubricHint : s.globalRubricHint}</p>
          <PromptField
            id={`${id}-rubric`}
            label={legacyRubric ? s.rubric : s.globalRubricField}
            labelHidden
            value={rubric}
            onChange={(next) => patch({ rubric: next })}
            disabled={disabled}
            RichText={RichText}
          />
          {legacyRubric && wand ? (
            <div>
              <WandButton label={s.convertRubric} {...wandState(CONVERT)} disabled={running !== null} />
            </div>
          ) : null}
        </AdvancedDisclosure>
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
