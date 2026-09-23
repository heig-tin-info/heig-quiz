/**
 * The `short` player: one prompt, one field.
 *
 * Controlled — the host owns the answer and autosaves it. The input type
 * follows `kind`, which is the only thing the student learns about the key: a
 * date question asks for a date, it never says which one.
 *
 * The CONSTRAINTS are enforced here, in the field itself: a length, a numeric
 * range, a window of dates. They are not part of the key either — knowing that
 * the answer is a whole number between 1 and 100 is knowing what the field
 * takes, not which number it wants — and the grader re-derives nothing from
 * them except the integer rule.
 */
import type { MarkdownRenderer, PlayerProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import {
  defaultShortConstraints,
  SHORT_MAX_ANSWER_LENGTH,
  type ShortAnswer,
  type ShortConstraints,
  type ShortKind,
  type ShortStudent,
} from "./schema.js";
import { shortPlayerStrings, type ShortPlayerStringKey } from "./strings.js";
import { cx, markdown } from "@quiz/ui";
import { helpClass, inputClass, labelClass } from "./ui.js";

type ShortPlayerProps = PlayerProps<ShortStudent, ShortAnswer> & {
  /** Alias of `readOnly`, for hosts that speak in disabled controls. */
  disabled?: boolean;
  strings?: StringOverrides<ShortPlayerStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

/**
 * The native attributes that carry the constraints. A browser enforces them
 * for free, which is the whole point of storing them: the student is stopped
 * while typing rather than told afterwards.
 *
 * `number` is a real `type="number"` since v2 — it is what makes `min`, `max`
 * and the whole-number step mean anything. A browser whose locale uses the
 * comma still accepts "3,14" there and hands the dot back, and the grader
 * (`parseNumericInput`) takes either.
 */
function fieldAttributes(
  kind: ShortKind,
  constraints: ShortConstraints,
): Record<string, string | number | undefined> {
  switch (kind) {
    case "number":
      return {
        type: "number",
        inputMode: constraints.integer ? "numeric" : "decimal",
        ...(constraints.min === undefined ? {} : { min: constraints.min }),
        ...(constraints.max === undefined ? {} : { max: constraints.max }),
        step: constraints.integer ? 1 : "any",
      };
    case "date":
      return {
        type: "date",
        ...(constraints.from === undefined ? {} : { min: constraints.from }),
        ...(constraints.to === undefined ? {} : { max: constraints.to }),
      };
    case "time":
      return { type: "time" };
    case "text":
      return {
        type: "text",
        maxLength: Math.min(constraints.maxLength, SHORT_MAX_ANSWER_LENGTH),
        ...(constraints.minLength > 0 ? { minLength: constraints.minLength } : {}),
      };
  }
}

export function ShortPlayer({
  student,
  answer,
  onChange,
  readOnly,
  disabled,
  strings,
  renderMarkdown,
}: ShortPlayerProps) {
  const s = resolveStrings(shortPlayerStrings, strings);
  const locked = readOnly || disabled === true;
  /*
   * A payload minted before v2 carries no constraints. The types say it
   * cannot happen; a student sitting an exam behind a white screen because it
   * did is not a trade this component makes.
   */
  const constraints = student.constraints ?? defaultShortConstraints();
  const hint =
    student.kind === "number"
      ? s.hintNumber
      : student.kind === "date"
        ? s.hintDate
        : student.kind === "time"
          ? s.hintTime
          : s.hintText;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-lg leading-relaxed text-fg">
        {markdown(renderMarkdown, student.prompt)}
      </p>
      <div className="flex flex-col gap-1.5">
        <label className={labelClass} htmlFor="short-answer">
          {s.label}
        </label>
        <input
          id="short-answer"
          {...fieldAttributes(student.kind, constraints)}
          autoComplete="off"
          spellCheck={false}
          className={cx(inputClass, "w-full max-w-md")}
          placeholder={student.placeholder ?? ""}
          value={answer?.text ?? ""}
          disabled={locked}
          onChange={(e) => onChange({ text: e.target.value })}
        />
        <p className={helpClass}>{hint}</p>
      </div>
    </div>
  );
}
