/**
 * The `short` player: one prompt, one field.
 *
 * Controlled — the host owns the answer and autosaves it. The input type
 * follows `kind`, which is the only thing the student learns about the key: a
 * date question asks for a date, it never says which one.
 */
import type { MarkdownRenderer, PlayerProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { SHORT_MAX_ANSWER_LENGTH, type ShortAnswer, type ShortStudent } from "./schema.js";
import { shortPlayerStrings, type ShortPlayerStringKey } from "./strings.js";
import { cx, helpClass, inputClass, labelClass } from "./ui.js";

export type ShortPlayerProps = PlayerProps<ShortStudent, ShortAnswer> & {
  /** Alias of `readOnly`, for hosts that speak in disabled controls. */
  disabled?: boolean;
  strings?: StringOverrides<ShortPlayerStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

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
        {renderMarkdown ? renderMarkdown(student.prompt) : student.prompt}
      </p>
      <div className="flex flex-col gap-1.5">
        <label className={labelClass} htmlFor="short-answer">
          {s.label}
        </label>
        <input
          id="short-answer"
          /*
           * `number` stays a text input: `type="number"` refuses a comma, and a
           * French-speaking student types "3,14". The parsing is the grader's
           * job (`parseNumericInput`), which accepts both.
           */
          type={student.kind === "date" ? "date" : student.kind === "time" ? "time" : "text"}
          inputMode={student.kind === "number" ? "decimal" : undefined}
          maxLength={SHORT_MAX_ANSWER_LENGTH}
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
