/**
 * The `mcq` player (in the zen player, `apps/web/src/student/Player.tsx`).
 *
 * Controlled: it renders exactly what `toStudent` sent — an order already
 * shuffled by the server — and reports every change through `onChange`. It
 * holds no state, so a reload or a resumed attempt shows the stored answer and
 * nothing else. The ids it sends back are canonical (decision D3).
 *
 * With an `answerKey` (a teacher's preview, "Show answers", #554) the right
 * choices are marked in place, a success tint and their verdict in words, so
 * the question keeps the layout it has without the key.
 */
import type { PlayerProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import type { McqAnswer, McqSolution, McqStudent } from "./schema.js";
import { mcqPlayerStrings, type McqPlayerStringKey } from "./strings.js";
import { caption, cx, isLocked, markdown, Verdict } from "@quiz/ui";
import { choiceLetter, Pastille } from "./ui.js";

type McqPlayerProps = PlayerProps<McqStudent, McqAnswer, McqSolution> & {
  /** Alias of `readOnly`, for hosts that speak in disabled controls. */
  disabled?: boolean;
  strings?: StringOverrides<McqPlayerStringKey>;
};

export function McqPlayer({
  student,
  answer,
  onChange,
  readOnly,
  answerKey,
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
  const correct = new Set(answerKey?.correct ?? []);

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
      <p className={caption}>{instructions}</p>
      {/*
       * Negative marking (ADR-026): said on the question itself, where the
       * decision to guess is taken — the waiting room said it once already,
       * but an exercise without one has no other place to say it.
       */}
      {student.negativeMarking ? (
        <p
          className="-mt-2 rounded-lg bg-warning-soft px-3 py-1.5 text-[13px] font-medium text-warning"
          role="note"
        >
          {s.negativeMarking}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {student.choices.map((choice, index) => {
          const checked = selected.includes(choice.id);
          const right = correct.has(choice.id);
          const frozen = locked || (atLimit && !checked);
          return (
            <li key={choice.id}>
              {/*
               * The WHOLE row is the label: the pastille, the text and the
               * space between them all answer a click, and the accessible name
               * is the text of the choice — the letter is the teacher's index
               * of the list, not a word the reader needs. No frame: the
               * pastille already says "this is a control", the fill on hover
               * shows the area it answers, and a frame around each of six
               * choices inside the question's card was a wall of lines.
               */}
              <label
                className={cx(
                  "relative flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 text-sm text-fg transition-colors",
                  checked ? "bg-accent-soft" : right ? "bg-success-soft" : "hover:bg-surface-2",
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
                 * line of `.md-body` at this size (40 − 22). `flex-1`, so a code
                 * block runs to the end of the row whatever its longest line:
                 * blocks of six widths made a ragged column.
                 */}
                <span className="mt-2.25 min-w-0 flex-1">
                  {markdown(renderMarkdown, choice.text)}
                </span>
                {/* The space keeps the verdict a word of its own in the row's name. */}
                {right ? (
                  <>
                    {" "}
                    <Verdict tone="success" className="mt-2.25 shrink-0">
                      {s.correctAnswer}
                    </Verdict>
                  </>
                ) : null}
              </label>
            </li>
          );
        })}
      </ul>
      {atLimit ? (
        <p className={caption} role="status">
          {s.limitReached}
        </p>
      ) : null}
    </fieldset>
  );
}
