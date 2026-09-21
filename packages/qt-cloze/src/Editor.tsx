/**
 * The `cloze` editor: the authoring text, the two switches, the predefined
 * choice sets, and what the parser understood.
 *
 * Controlled and offline. The blank table is still the spine of the screen:
 * the `{{…}}` grammar is terse, so the teacher must SEE how each hole was read
 * — kind, weight and key — before publishing. It is produced by the same
 * `parseCloze` the grader uses, never by a second reading of the text.
 */
import { useRef, type ReactNode } from "react";
import type {
  ConfigIssue,
  EditorProps,
  RichTextApi,
  RichTextComponent,
  StringOverrides,
} from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { describeBlank, parseCloze } from "@quiz/domain";
import { CLOZE_MAX_CHOICE_SETS, CLOZE_MAX_SET_OPTIONS, type ClozeChoiceSet, type ClozeConfig } from "./schema.js";
import { clozeEditorStrings, type ClozeEditorStringKey } from "./strings.js";
import {
  buttonClass,
  cardClass,
  cx,
  helpClass,
  iconButtonClass,
  inputClass,
  IssueList,
  issuesAt,
  labelClass,
  rootIssues,
  sectionClass,
  TrashIcon,
} from "./ui.js";

export type ClozeEditorProps = Omit<EditorProps<ClozeConfig>, "uploadAsset"> & {
  uploadAsset?: EditorProps<ClozeConfig>["uploadAsset"];
  issues?: readonly ConfigIssue[];
  strings?: StringOverrides<ClozeEditorStringKey>;
  /** The host's WYSIWYG editor; a textarea when the host has none. */
  RichText?: RichTextComponent;
};

/** The next free default key: "1", "2", … whatever the teacher renamed. */
function nextKey(sets: readonly ClozeChoiceSet[]): string {
  for (let n = 1; n <= CLOZE_MAX_CHOICE_SETS + 1; n += 1) {
    const key = String(n);
    if (!sets.some((set) => set.key === key)) return key;
  }
  return String(sets.length + 1);
}

export function ClozeEditor({
  config,
  onChange,
  disabled,
  issues = [],
  strings,
  RichText,
}: ClozeEditorProps) {
  const s = resolveStrings(clozeEditorStrings, strings);
  const sets = config.choiceSets ?? [];
  /*
   * The sets are handed to the parser, so the table below reads `{{1}}` as the
   * dropdown the student will get and not as a text blank whose answer is "1".
   * It is the same call `toStudent` and the grader make (`parse.ts`).
   */
  const parse = parseCloze(config.text, sets);
  const patch = (next: Partial<ClozeConfig>) => onChange({ ...config, ...next });
  const patchSets = (next: ClozeChoiceSet[]) => patch({ choiceSets: next });

  /**
   * The rich field's imperative handle, so "Insert in the text" lands WHERE
   * THE CARET IS. Without a rich editor there is none, and the button says so
   * by not being drawn.
   */
  const api = useRef<RichTextApi | null>(null);

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
      onReady={(handle) => {
        api.current = handle;
      }}
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
        <label className={labelClass} htmlFor="cloze-text">
          {s.text}
        </label>
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

      <ChoiceSets
        s={s}
        sets={sets}
        text={config.text}
        issues={issues}
        {...(disabled === undefined ? {} : { disabled })}
        onChange={patchSets}
        {...(RichText ? { insert: (body: string) => api.current?.insertHole(body) } : {})}
      />

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

/**
 * The PREDEFINED CHOICES section: dropdowns written once and dropped into the
 * text by key.
 *
 * It exists for two reasons a teacher gave. A table whose cells hold a
 * dropdown is impossible with `{{=a|b|c}}` — every unescaped `|` in a markdown
 * row is a column separator — and the same four options repeated in eight
 * holes were eight places to fix one typo. The key is what the text names
 * ("1", "2", … by default, renameable), and `@quiz/domain` resolves it back to
 * the ordinary `select` blank the player already draws.
 */
function ChoiceSets({
  s,
  sets,
  text,
  issues,
  disabled,
  onChange,
  insert,
}: {
  s: Readonly<Record<ClozeEditorStringKey, string>>;
  sets: readonly ClozeChoiceSet[];
  text: string;
  issues: readonly ConfigIssue[];
  disabled?: boolean;
  onChange: (next: ClozeChoiceSet[]) => void;
  /** Absent when the host lends no rich editor: there is no caret to insert at. */
  insert?: (body: string) => void;
}): ReactNode {
  const replace = (index: number, set: ClozeChoiceSet) =>
    onChange(sets.map((current, i) => (i === index ? set : current)));

  return (
    <section className={sectionClass}>
      <h3 className={labelClass}>{s.choiceSets}</h3>
      <p className={helpClass}>{s.choiceSetsHint}</p>
      {sets.length === 0 ? <p className={helpClass}>{s.noChoiceSet}</p> : null}

      <div className="flex flex-col gap-2">
        {sets.map((set, index) => {
          const used = text.includes(`{{${set.key}}}`);
          return (
            <div key={index} className={cx(cardClass, "flex flex-col gap-2")}>
              <div className="flex flex-wrap items-center gap-2">
                <label className={helpClass} htmlFor={`cloze-set-${index}`}>
                  {s.setKey}
                </label>
                <input
                  id={`cloze-set-${index}`}
                  className={cx(inputClass, "h-7 w-24 py-0 font-mono text-[13px]")}
                  value={set.key}
                  disabled={disabled}
                  onChange={(e) => replace(index, { ...set, key: e.target.value })}
                />
                {insert ? (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={disabled === true || set.key === ""}
                    onClick={() => insert(set.key)}
                  >
                    {s.insertSet}
                  </button>
                ) : null}
                <span className="grow" />
                <button
                  type="button"
                  className={iconButtonClass}
                  aria-label={s.removeSet}
                  disabled={disabled}
                  onClick={() => onChange(sets.filter((_, i) => i !== index))}
                >
                  <TrashIcon />
                </button>
              </div>

              <ul className="flex flex-col gap-1">
                {set.options.map((option, oi) => (
                  <li key={oi} className="flex items-center gap-2">
                    <label className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted">
                      <input
                        type="checkbox"
                        className="size-4 accent-accent"
                        checked={option.correct}
                        disabled={disabled}
                        onChange={(e) =>
                          replace(index, {
                            ...set,
                            options: set.options.map((o, i) =>
                              i === oi ? { ...o, correct: e.target.checked } : o,
                            ),
                          })
                        }
                      />
                      {s.optionCorrect}
                    </label>
                    <input
                      className={cx(inputClass, "h-7 min-w-0 grow py-0 text-[13px]")}
                      aria-label={`${s.optionLabel} ${oi + 1}`}
                      value={option.label}
                      disabled={disabled}
                      onChange={(e) =>
                        replace(index, {
                          ...set,
                          options: set.options.map((o, i) =>
                            i === oi ? { ...o, label: e.target.value } : o,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      className={iconButtonClass}
                      aria-label={s.removeOption}
                      disabled={disabled}
                      onClick={() =>
                        replace(index, { ...set, options: set.options.filter((_, i) => i !== oi) })
                      }
                    >
                      <TrashIcon />
                    </button>
                  </li>
                ))}
              </ul>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={disabled === true || set.options.length >= CLOZE_MAX_SET_OPTIONS}
                  onClick={() =>
                    replace(index, { ...set, options: [...set.options, { label: "", correct: false }] })
                  }
                >
                  {s.addOption}
                </button>
                {used ? null : <span className={helpClass}>{s.setUnused}</span>}
              </div>

              <IssueList issues={issuesAt(issues, "choiceSets", index)} />
            </div>
          );
        })}
      </div>

      <div>
        <button
          type="button"
          className={buttonClass}
          disabled={disabled === true || sets.length >= CLOZE_MAX_CHOICE_SETS}
          onClick={() =>
            onChange([
              ...sets,
              {
                key: nextKey(sets),
                // Two empty options, because two is the minimum a dropdown can
                // have and an empty card teaches nothing about the shape.
                options: [
                  { label: "", correct: true },
                  { label: "", correct: false },
                ],
              },
            ])
          }
        >
          {s.addSet}
        </button>
      </div>
    </section>
  );
}
