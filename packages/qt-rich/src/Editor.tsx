/**
 * The `rich` editor: the statement, then what the GRADER reads — the rubric
 * and an optional model answer — and, in the host's right column, the two
 * settings of the student's field: its format and its limit.
 *
 * Controlled and offline, like every editor: it reads `config`, emits a whole
 * new config through `onChange` and never fetches. An invalid draft is a
 * normal state (decision D16).
 */
import { useId } from "react";

import type { ConfigIssue, EditorProps, MarkdownRenderer, StringOverrides } from "@quiz/core/client";
import { fmt, issuesAt, resolveStrings, rootIssues } from "@quiz/core/client";
import { AsideSection, hint, IssueList, label, NumberField, PromptField, sectionClass, Segmented } from "@quiz/ui";

import { CHARS_PER_A4_PAGE, pagesText, RICH_MAX_CHARS, type RichConfig, type RichFormat } from "./schema.js";
import { richEditorStrings, type RichEditorStringKey } from "./strings.js";

type RichEditorProps = Omit<EditorProps<RichConfig>, "uploadAsset"> & {
  uploadAsset?: EditorProps<RichConfig>["uploadAsset"];
  issues?: readonly ConfigIssue[];
  strings?: StringOverrides<RichEditorStringKey>;
  renderMarkdown?: MarkdownRenderer;
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

        <p className={hint}>{s.manualGrading}</p>
      </AsideSection>
    </div>
  );
}
