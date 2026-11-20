/**
 * The `cloze` editor: the authoring text, the two switches and the
 * presentation of the dropdowns (ADR-138), and what the parser understood.
 *
 * Controlled and offline. The blank table is still the spine of the screen:
 * the `{{…}}` grammar is terse, so the teacher must SEE how each hole was read
 * — kind, weight and expected answer — before publishing. It is produced by
 * the same `parseCloze` the grader uses, never by a second reading of the
 * text. The holes themselves are written in the host's rich field, where each
 * one is a chip with an editor of its own; nothing here knows about that.
 */
import type {
  EditorProps,
  RichTextComponent,
  StringOverrides,
} from "@quiz/core/client";
import { issuesAt, resolveStrings, rootIssues } from "@quiz/core/client";
import { clozeLabelGroups, describeBlank, parseCloze } from "@quiz/domain/cloze";
import { isLabels, type ClozeConfig } from "./schema.js";
import { clozeEditorStrings, type ClozeEditorStringKey } from "./strings.js";
import {
  CheckboxField,
  cx,
  hint,
  IssueList,
  label,
  PromptField,
  sectionClass,
  Segmented,
} from "@quiz/ui";

type ClozeEditorProps = EditorProps<ClozeConfig> & {
  strings?: StringOverrides<ClozeEditorStringKey>;
  /** The host's WYSIWYG editor; a textarea when the host has none. */
  RichText?: RichTextComponent;
};

/** The two switches of the text sit in a row of their own, at body size. */
const CHECKBOX = "inline-flex items-center gap-1.5 text-sm text-fg-muted";

export function ClozeEditor({
  config,
  onChange,
  uploadAsset,
  disabled,
  issues = [],
  strings,
  RichText,
}: ClozeEditorProps) {
  const s = resolveStrings(clozeEditorStrings, strings);
  // The same call `toStudent` and the grader make, so the table below shows
  // the blanks the student will actually get.
  const parse = parseCloze(config.text);
  const patch = (next: Partial<ClozeConfig>) => onChange({ ...config, ...next });
  const labels = isLabels(config);
  // Numbered from 1, in order of first appearance: the player's tray rows.
  const groupOf = new Map(
    clozeLabelGroups(parse.blanks).flatMap((group, g) => group.blanks.map((index) => [index, g + 1] as const)),
  );

  return (
    <div className="flex flex-col gap-6">
      <IssueList issues={rootIssues(issues)} />

      <section className={sectionClass}>
        <PromptField
          id="cloze-text"
          label={s.text}
          value={config.text}
          onChange={(text) => patch({ text })}
          disabled={disabled}
          RichText={RichText}
          uploadImage={uploadAsset}
          // The `{{…}}` holes are OBJECTS in the rich field: chips the teacher
          // clicks to edit, written back verbatim. It is what finally replaced
          // the textarea this editor was stuck with — a plain rich field
          // escaped the braces, the `|` and the `*` of a weight on the first
          // save.
          holes
          rows={8}
        />
        <p className={hint}>{s.textHint}</p>
        <IssueList issues={issuesAt(issues, "text")} />
        {parse.errors.length > 0 ? (
          <IssueList issues={parse.errors.map((e) => ({ path: ["text"], message: e.message }))} />
        ) : null}
      </section>

      <section className={cx(sectionClass, "flex-row flex-wrap items-center gap-4")}>
        <CheckboxField
          className={CHECKBOX}
          label={s.caseSensitive}
          checked={config.caseSensitive}
          disabled={disabled}
          onChange={(caseSensitive) => patch({ caseSensitive })}
        />
        <CheckboxField
          className={CHECKBOX}
          label={s.shuffleOptions}
          checked={config.shuffleOptions}
          disabled={disabled}
          onChange={(shuffleOptions) => patch({ shuffleOptions })}
        />
        {/* ADR-138: how the dropdowns are shown. Dropdowns REMOVE the key, so
            a question nobody switched keeps its stored JSON as it was. */}
        <div className="inline-flex flex-wrap items-center gap-2">
          <span id="cloze-presentation-label" className="text-sm text-fg-muted">
            {s.presentation}
          </span>
          <Segmented
            name="cloze-presentation"
            labelledBy="cloze-presentation-label"
            size="sm"
            value={labels ? "labels" : "dropdown"}
            disabled={disabled}
            options={[
              { value: "dropdown", label: s.presentationDropdown },
              { value: "labels", label: s.presentationLabels },
            ]}
            onChange={(presentation) => {
              const { presentation: _dropped, ...rest } = config;
              onChange(presentation === "labels" ? { ...rest, presentation } : rest);
            }}
          />
        </div>
      </section>

      <section className={sectionClass}>
        <h3 className={label}>{s.blanks}</h3>
        <p className={hint}>{s.blanksHint}</p>
        {parse.blanks.length === 0 ? (
          <p className={hint}>{s.noBlank}</p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="text-fg-faint">
              <tr>
                <th className="py-1 pr-3 font-medium">{s.blank}</th>
                <th className="py-1 pr-3 font-medium">{s.kind}</th>
                <th className="py-1 pr-3 text-right font-medium">{s.weight}</th>
                {labels ? <th className="py-1 pr-3 text-right font-medium">{s.group}</th> : null}
                <th className="py-1 font-medium">{s.expected}</th>
              </tr>
            </thead>
            <tbody>
              {parse.blanks.map((blank) => (
                <tr key={blank.index} className="border-t border-line">
                  <td className="py-1 pr-3 tabular-nums text-fg-muted">{blank.index + 1}</td>
                  <td className="py-1 pr-3 text-fg-muted">{blank.kind}</td>
                  <td className="py-1 pr-3 text-right tabular-nums text-fg-muted">{blank.weight}</td>
                  {labels ? (
                    // The group a dropdown's labels fall in: a typo that splits a group shows here.
                    <td className="py-1 pr-3 text-right tabular-nums text-fg-muted">{groupOf.get(blank.index) ?? "—"}</td>
                  ) : null}
                  <td className="py-1 font-mono text-fg">{describeBlank(blank)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
