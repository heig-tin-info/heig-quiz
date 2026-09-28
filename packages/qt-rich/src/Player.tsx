/**
 * The `rich` player: a statement and one long field.
 *
 * `format: "markdown"` lends the student the host's formatted editor
 * (`PlayerProps.RichText`, without an image upload: no images in v1);
 * `plain`, or a host that lent none, is a textarea. The answer is the field's
 * text either way — markdown for the first, the characters typed for the
 * second.
 *
 * THE LIMIT. The autosave sends the whole answer every 300 ms and the server
 * refuses a longer one (`answerMisfit`), so the player never sends one: a
 * textarea stops at `maxLength` like any field, and the formatted editor —
 * which has no such attribute — keeps what the student typed beyond the limit
 * HERE, shown and counted in red, and sends nothing until the answer fits
 * again. Cutting the text instead would delete the END of an essay whenever
 * the student typed in its middle.
 */
import { useId, useState } from "react";

import type { MarkdownRenderer, PlayerProps, StringOverrides } from "@quiz/core/client";
import { fmt, resolveStrings } from "@quiz/core/client";
import { caption, cx, isLocked, label, markdown, textareaClass } from "@quiz/ui";

import { charLimit, countChars, pagesText, type RichAnswer, type RichStudent } from "./schema.js";
import { richPlayerStrings, type RichPlayerStringKey } from "./strings.js";

type RichPlayerProps = PlayerProps<RichStudent, RichAnswer> & {
  /** Alias of `readOnly`, for hosts that speak in disabled controls. */
  disabled?: boolean;
  strings?: StringOverrides<RichPlayerStringKey>;
  renderMarkdown?: MarkdownRenderer;
};

export function RichPlayer({
  student,
  answer,
  onChange,
  readOnly,
  disabled,
  strings,
  renderMarkdown,
  RichText,
}: RichPlayerProps) {
  const s = resolveStrings(richPlayerStrings, strings);
  const locked = isLocked(readOnly, disabled);
  const id = useId();
  const limit = charLimit(student.maxChars);
  /** What the formatted editor holds beyond the limit, and that is not sent. */
  const [unsent, setUnsent] = useState<string | null>(null);
  const text = unsent ?? answer?.text ?? "";
  const count = countChars(text);
  const over = count - limit;

  const change = (next: string) => {
    if (countChars(next) > limit) {
      setUnsent(next);
      return;
    }
    setUnsent(null);
    onChange({ text: next });
  };

  const counter =
    student.maxChars === undefined
      ? fmt(s.count, { count })
      : fmt(s.countOf, { count, max: student.maxChars });
  const formatted = student.format === "markdown" && RichText !== undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-lg leading-relaxed text-fg">{markdown(renderMarkdown, student.prompt)}</div>
      <div className="flex flex-col gap-1.5">
        {formatted ? (
          <>
            <span className={label}>{s.label}</span>
            <RichText
              id={`${id}-answer`}
              aria-label={s.label}
              value={text}
              onChange={change}
              placeholder={s.placeholder}
              disabled={locked}
            />
          </>
        ) : (
          <>
            <label className={label} htmlFor={`${id}-answer`}>
              {s.label}
            </label>
            <textarea
              id={`${id}-answer`}
              rows={12}
              maxLength={limit}
              aria-describedby={`${id}-count`}
              className={cx(textareaClass, "w-full resize-y")}
              placeholder={s.placeholder}
              value={text}
              disabled={locked}
              onChange={(e) => change(e.target.value)}
            />
          </>
        )}
        <p id={`${id}-count`} className={cx(caption, "tabular-nums", over > 0 && "text-danger!")}>
          {counter} · {fmt(s.pages, { pages: pagesText(count, s.decimal) })}
        </p>
        {over > 0 ? (
          <p role="alert" className="text-[13px] text-danger">
            {fmt(s.over, { n: over })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
