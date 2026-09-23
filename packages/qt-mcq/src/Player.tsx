/**
 * The `mcq` player (mockup `mockups/07-etudiant-zen.html`).
 *
 * Controlled: it renders exactly what `toStudent` sent — an order already
 * shuffled by the server — and reports every change through `onChange`. It
 * holds no state, so a reload or a resumed attempt shows the stored answer and
 * nothing else. The ids it sends back are canonical (decision D3).
 */
import type { MarkdownRenderer, PlayerProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import type { McqAnswer, McqStudent } from "./schema.js";
import { mcqPlayerStrings, type McqPlayerStringKey } from "./strings.js";
import { cx, helpClass, isLocked, markdown } from "@quiz/ui";
import { choiceLetter, Pastille } from "./ui.js";

type McqPlayerProps = PlayerProps<McqStudent, McqAnswer> & {
  /** Alias of `readOnly`, for hosts that speak in disabled controls. */
  disabled?: boolean;
  strings?: StringOverrides<McqPlayerStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

export function McqPlayer({
  student,
  answer,
  onChange,
  readOnly,
  disabled,
  strings,
  renderMarkdown,
}: McqPlayerProps) {
  const s = resolveStrings(mcqPlayerStrings, strings);
  const locked = isLocked(readOnly, disabled);
  const selected = answer?.selected ?? [];
  const multiple = student.mode === "multiple";
  const limit = student.maxSelections;
  const atLimit = multiple && limit !== undefined && selected.length >= limit;

  const toggle = (id: number, checked: boolean) => {
    if (!multiple) {
      onChange({ selected: [id] });
      return;
    }
    const next = checked ? [...selected, id] : selected.filter((x) => x !== id);
    onChange({ selected: [...new Set(next)].sort((a, b) => a - b) });
  };

  const instructions = !multiple ? s.chooseOne : limit === undefined ? s.chooseSeveral : s.chooseUpTo;

  return (
    <fieldset className="flex flex-col gap-4" disabled={locked}>
      <legend className="mb-2 text-lg leading-relaxed text-fg">
        {markdown(renderMarkdown, student.prompt)}
      </legend>
      <p className={helpClass}>{instructions}</p>
      <ul className="flex flex-col gap-2">
        {student.choices.map((choice, index) => {
          const checked = selected.includes(choice.id);
          const frozen = locked || (atLimit && !checked);
          return (
            <li key={choice.id}>
              {/*
               * The WHOLE row is the label: the pastille, the text and the
               * space between them all answer a click, and the accessible name
               * is the text of the choice — the letter is the teacher's index
               * of the list, not a word the reader needs.
               */}
              <label
                className={cx(
                  "relative flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors",
                  checked
                    ? "border-accent bg-accent-soft text-fg"
                    : "border-line-strong bg-surface text-fg hover:bg-surface-2",
                  locked && "cursor-default opacity-80",
                  !frozen && "group/opt",
                )}
              >
                <Pastille
                  letter={choiceLetter(index)}
                  size="md"
                  type={multiple ? "checkbox" : "radio"}
                  name="mcq-answer"
                  checked={checked}
                  disabled={frozen}
                  onChange={(next) => toggle(choice.id, next)}
                />
                {/*
                 * The first line of the text, and not the block, is what the
                 * 40 px disc lines up with: half of what it is taller than one
                 * line of `.md-body` at this size (40 − 22).
                 */}
                <span className="mt-2.25 min-w-0">
                  {markdown(renderMarkdown, choice.text)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {atLimit ? (
        <p className={helpClass} role="status">
          {s.limitReached}
        </p>
      ) : null}
    </fieldset>
  );
}
