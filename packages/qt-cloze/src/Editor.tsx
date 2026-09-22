/**
 * The `cloze` editor: the authoring text, the two switches, and what the
 * parser understood.
 *
 * Controlled and offline. The blank table is still the spine of the screen:
 * the `{{…}}` grammar is terse, so the teacher must SEE how each hole was read
 * — kind, weight and expected answer — before publishing. It is produced by
 * the same `parseCloze` the grader uses, never by a second reading of the
 * text. The holes themselves are written in the host's rich field, where each
 * one is a chip with an editor of its own; nothing here knows about that.
 */
import type {
  ConfigIssue,
  EditorProps,
  RichTextComponent,
  StringOverrides,
} from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { describeBlank, parseCloze } from "@quiz/domain";
import { type ClozeConfig } from "./schema.js";
import { clozeEditorStrings, type ClozeEditorStringKey } from "./strings.js";
import {
  cx,
  helpClass,
  inputClass,
  IssueList,
  issuesAt,
  labelClass,
  rootIssues,
  sectionClass,
} from "./ui.js";

type ClozeEditorProps = Omit<EditorProps<ClozeConfig>, "uploadAsset"> & {
  uploadAsset?: EditorProps<ClozeConfig>["uploadAsset"];
  issues?: readonly ConfigIssue[];
  strings?: StringOverrides<ClozeEditorStringKey>;
  /** The host's WYSIWYG editor; a textarea when the host has none. */
  RichText?: RichTextComponent;
};

export function ClozeEditor({
  config,
  onChange,
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

  const textField = RichText ? (
    <RichText
      id="cloze-text"
      aria-label={s.text}
      value={config.text}
      onChange={(text) => patch({ text })}
      // The `{{…}}` holes are OBJECTS in this field: chips the teacher clicks
      // to edit, written back verbatim. It is what finally replaced the
      // textarea this editor was stuck with — a plain rich field escaped the
      // braces, the `|` and the `*` of a weight on the first save.
      holes
      {...(disabled === undefined ? {} : { disabled })}
    />
  ) : (
    <textarea
      id="cloze-text"
      rows={8}
      className={cx(inputClass, "w-full resize-y font-mono text-[13px]")}
      aria-label={s.text}
      value={config.text}
      disabled={disabled}
      onChange={(e) => patch({ text: e.target.value })}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <IssueList issues={rootIssues(issues)} />

      <section className={sectionClass}>
        {/*
         * A caption and not a `<label for>` when the host lent its rich
         * editor: its surface is a contenteditable, which is not a labelable
         * element — the browser reports such a `for` as matching no control,
         * and the field takes its name from `aria-label` instead. The
         * textarea fallback is a real control and keeps its label.
         */}
        {RichText ? (
          <span className={labelClass}>{s.text}</span>
        ) : (
          <label className={labelClass} htmlFor="cloze-text">
            {s.text}
          </label>
        )}
        {textField}
        <p className={helpClass}>{s.textHint}</p>
        <IssueList issues={issuesAt(issues, "text")} />
        {parse.errors.length > 0 ? (
          <IssueList issues={parse.errors.map((e) => ({ path: ["text"], message: e.message }))} />
        ) : null}
      </section>

      <section className={cx(sectionClass, "flex-row flex-wrap gap-4")}>
        <label className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={config.caseSensitive}
            disabled={disabled}
            onChange={(e) => patch({ caseSensitive: e.target.checked })}
          />
          {s.caseSensitive}
        </label>
        <label className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={config.shuffleOptions}
            disabled={disabled}
            onChange={(e) => patch({ shuffleOptions: e.target.checked })}
          />
          {s.shuffleOptions}
        </label>
      </section>

      <section className={sectionClass}>
        <h3 className={labelClass}>{s.blanks}</h3>
        <p className={helpClass}>{s.blanksHint}</p>
        {parse.blanks.length === 0 ? (
          <p className={helpClass}>{s.noBlank}</p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="text-fg-faint">
              <tr>
                <th className="py-1 pr-3 font-medium">{s.blank}</th>
                <th className="py-1 pr-3 font-medium">{s.kind}</th>
                <th className="py-1 pr-3 text-right font-medium">{s.weight}</th>
                <th className="py-1 font-medium">{s.expected}</th>
              </tr>
            </thead>
            <tbody>
              {parse.blanks.map((blank) => (
                <tr key={blank.index} className="border-t border-line">
                  <td className="py-1 pr-3 tabular-nums text-fg-muted">{blank.index + 1}</td>
                  <td className="py-1 pr-3 text-fg-muted">{blank.kind}</td>
                  <td className="py-1 pr-3 text-right tabular-nums text-fg-muted">{blank.weight}</td>
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
