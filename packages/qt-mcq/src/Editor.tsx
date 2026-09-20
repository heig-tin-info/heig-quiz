/**
 * The `mcq` editor (mockup `mockups/01-editeur-qcm.html`).
 *
 * Controlled and offline: it reads `config`, emits a whole new config through
 * `onChange`, and never fetches anything — the host autosaves the draft and
 * hands back the validation `issues` (decision D16). An invalid draft is a
 * normal state here: a teacher must be able to leave a question half-written.
 */
import type { ConfigIssue, EditorProps, MarkdownRenderer, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { MCQ_MAX_CHOICES, MCQ_MIN_CHOICES, type McqChoice, type McqConfig } from "./schema.js";
import { mcqEditorStrings, type McqEditorStringKey } from "./strings.js";
import {
  buttonClass,
  choiceLetter,
  cx,
  helpClass,
  inputClass,
  IssueList,
  issuesAt,
  labelClass,
  legendClass,
  rootIssues,
  sectionClass,
} from "./ui.js";

export type McqEditorProps = Omit<EditorProps<McqConfig>, "uploadAsset"> & {
  /** Unused by the MVP markdown textarea; kept so the host may pass it. */
  uploadAsset?: EditorProps<McqConfig>["uploadAsset"];
  /** What the last save reported, as zod paths (decision D16). */
  issues?: readonly ConfigIssue[];
  strings?: StringOverrides<McqEditorStringKey>;
  /** The host's sanitised markdown view; plain text when absent. */
  renderMarkdown?: MarkdownRenderer;
};

export function McqEditor({
  config,
  onChange,
  disabled,
  issues = [],
  strings,
  renderMarkdown,
}: McqEditorProps) {
  const s = resolveStrings(mcqEditorStrings, strings);
  const multiple = config.mode === "multiple";

  const patch = (next: Partial<McqConfig>) => onChange({ ...config, ...next });
  const setChoices = (choices: McqChoice[]) => patch({ choices });

  /**
   * `single` means exactly one key scored all or nothing (the two refinements
   * of the schema), so switching the mode normalises instead of producing a
   * draft the teacher cannot publish and was never told about.
   */
  const setMode = (mode: McqConfig["mode"]) => {
    if (mode === "multiple") {
      patch({ mode });
      return;
    }
    const first = config.choices.findIndex((c) => c.correct);
    const next = { ...config };
    next.mode = "single";
    next.policy = "all_or_nothing";
    next.choices = config.choices.map((c, i) => ({ ...c, correct: i === first }));
    delete next.maxSelections;
    onChange(next);
  };

  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= config.choices.length) return;
    const choices = config.choices.slice();
    const [moved] = choices.splice(index, 1);
    if (moved === undefined) return;
    choices.splice(target, 0, moved);
    setChoices(choices);
  };

  return (
    <div className="flex flex-col gap-6">
      <IssueList issues={rootIssues(issues)} />

      <section className={sectionClass}>
        <label className={labelClass} htmlFor="mcq-prompt">
          {s.prompt}
        </label>
        <textarea
          id="mcq-prompt"
          rows={4}
          className={cx(inputClass, "w-full resize-y font-mono text-[13px]")}
          value={config.prompt}
          disabled={disabled}
          onChange={(e) => patch({ prompt: e.target.value })}
        />
        <p className={helpClass}>{s.promptHint}</p>
        <IssueList issues={issuesAt(issues, "prompt")} />
        {renderMarkdown ? (
          <div className="border-t border-line pt-2 text-sm text-fg">
            <p className={cx(helpClass, "mb-1")}>{s.preview}</p>
            {renderMarkdown(config.prompt)}
          </div>
        ) : null}
      </section>

      <section className={sectionClass}>
        <h3 className={labelClass}>{s.choices}</h3>
        <p className={helpClass}>{s.choicesHint}</p>
        <ul className="flex flex-col gap-2">
          {config.choices.map((choice, index) => (
            <li key={index} className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-center text-[13px] font-medium text-fg-faint">
                {choiceLetter(index)}
              </span>
              <input
                type="text"
                className={cx(inputClass, "min-w-0 flex-1")}
                aria-label={`${s.choiceText} ${choiceLetter(index)}`}
                value={choice.text}
                disabled={disabled}
                onChange={(e) =>
                  setChoices(
                    config.choices.map((c, i) => (i === index ? { ...c, text: e.target.value } : c)),
                  )
                }
              />
              <label className="inline-flex shrink-0 items-center gap-1.5 text-[13px] text-fg-muted">
                <input
                  type={multiple ? "checkbox" : "radio"}
                  name="mcq-correct"
                  className="size-4 accent-accent"
                  checked={choice.correct}
                  disabled={disabled}
                  onChange={(e) =>
                    setChoices(
                      config.choices.map((c, i) =>
                        i === index
                          ? { ...c, correct: e.target.checked }
                          : multiple
                            ? c
                            : { ...c, correct: false },
                      ),
                    )
                  }
                />
                {s.correct}
              </label>
              <button
                type="button"
                className={cx(buttonClass, "w-7 px-0")}
                aria-label={`${s.moveUp} ${choiceLetter(index)}`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className={cx(buttonClass, "w-7 px-0")}
                aria-label={`${s.moveDown} ${choiceLetter(index)}`}
                disabled={disabled || index === config.choices.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className={cx(buttonClass, "w-7 px-0 text-fg-muted hover:text-danger")}
                aria-label={`${s.removeChoice} ${choiceLetter(index)}`}
                disabled={disabled || config.choices.length <= MCQ_MIN_CHOICES}
                onClick={() => setChoices(config.choices.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <IssueList issues={issuesAt(issues, "choices")} />
        <div>
          <button
            type="button"
            className={buttonClass}
            disabled={disabled || config.choices.length >= MCQ_MAX_CHOICES}
            onClick={() => setChoices([...config.choices, { text: "", correct: false }])}
          >
            {s.addChoice}
          </button>
        </div>
      </section>

      <section className={sectionClass}>
        <h3 className={labelClass}>{s.scoring}</h3>

        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className={cx(legendClass, "float-none mb-1")}>{s.mode}</legend>
          {(["single", "multiple"] as const).map((mode) => (
            <label key={mode} className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
              <input
                type="radio"
                name="mcq-mode"
                className="size-4 accent-accent"
                checked={config.mode === mode}
                disabled={disabled}
                onChange={() => setMode(mode)}
              />
              {mode === "single" ? s.modeSingle : s.modeMultiple}
            </label>
          ))}
        </fieldset>

        <label className={labelClass} htmlFor="mcq-policy">
          {s.policy}
        </label>
        <select
          id="mcq-policy"
          className={cx(inputClass, "w-56")}
          value={config.policy}
          disabled={disabled || !multiple}
          onChange={(e) => patch({ policy: e.target.value as McqConfig["policy"] })}
        >
          <option value="all_or_nothing">{s.policyAllOrNothing}</option>
          <option value="partial">{s.policyPartial}</option>
          <option value="penalized">{s.policyPenalized}</option>
        </select>

        {config.policy === "penalized" ? (
          <>
            <label className={labelClass} htmlFor="mcq-penalty">
              {s.penalty}
            </label>
            <input
              id="mcq-penalty"
              type="number"
              min={0}
              max={1}
              step={0.1}
              className={cx(inputClass, "w-28 tabular-nums")}
              value={config.penalty}
              disabled={disabled}
              onChange={(e) => patch({ penalty: Number(e.target.value) })}
            />
            <p className={helpClass}>{s.penaltyHint}</p>
          </>
        ) : null}

        {config.policy !== "all_or_nothing" ? (
          <label className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={config.allowNegative}
              disabled={disabled}
              onChange={(e) => patch({ allowNegative: e.target.checked })}
            />
            {s.allowNegative}
          </label>
        ) : null}

        {multiple ? (
          <>
            <label className={labelClass} htmlFor="mcq-max">
              {s.maxSelections}
            </label>
            <input
              id="mcq-max"
              type="number"
              min={1}
              max={MCQ_MAX_CHOICES}
              className={cx(inputClass, "w-28 tabular-nums")}
              value={config.maxSelections ?? ""}
              disabled={disabled}
              onChange={(e) => {
                const next = { ...config };
                if (e.target.value === "") delete next.maxSelections;
                else next.maxSelections = Number(e.target.value);
                onChange(next);
              }}
            />
            <p className={helpClass}>{s.maxSelectionsHint}</p>
          </>
        ) : null}

        <label className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={config.shuffleChoices}
            disabled={disabled}
            onChange={(e) => patch({ shuffleChoices: e.target.checked })}
          />
          {s.shuffleChoices}
        </label>
      </section>
    </div>
  );
}
