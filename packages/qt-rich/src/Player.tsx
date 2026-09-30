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
 * the student typed in its middle. While it holds such text back, it tells
 * the host (`PlayerProps.onUnsent`), whose badge then stops saying "Saved".
 */
import { useEffect, useId, useState } from "react";

import type { MarkdownRenderer, PlayerProps, StringOverrides } from "@quiz/core/client";
import { fmt, resolveStrings } from "@quiz/core/client";
import {
  caption,
  cx,
  ErrorText,
  isLocked,
  label,
  markdown,
  textareaClass,
} from "@quiz/ui";

import { charLimit, countChars, pagesText, type RichAnswer, type RichStudent } from "./schema.js";
import { richPlayerStrings, type RichPlayerStringKey } from "./strings.js";

/** The answer field's height, formatted or plain: room for an essay, not a line (issue #267). */
const ESSAY_ROWS = 12;

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
  onUnsent,
}: RichPlayerProps) {
  const s = resolveStrings(richPlayerStrings, strings);
  const locked = isLocked(readOnly, disabled);
  const id = useId();
  const limit = charLimit(student.maxChars);
  const stored = answer?.text ?? "";
  /**
   * What the formatted editor holds beyond the limit, and that is not sent —
   * pinned to the stored answer it was typed over. When the answer changes
   * from OUTSIDE (the server's newer copy adopted, another item, a reset),
   * the pin no longer matches and the stored answer shows again.
   */
  const [unsent, setUnsent] = useState<{ text: string; over: string } | null>(null);
  const held = unsent !== null && unsent.over === stored;
  const text = held ? unsent.text : stored;
  // The host's sync badge must not say "Saved" over text that was never sent.
  useEffect(() => {
    if (!held || !onUnsent) return;
    onUnsent(true);
    return () => onUnsent(false);
  }, [held, onUnsent]);
  const count = countChars(text);
  const over = count - limit;

  const change = (next: string) => {
    if (countChars(next) > limit) {
      setUnsent({ text: next, over: stored });
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
              rows={ESSAY_ROWS}
            />
          </>
        ) : (
          <>
            <label className={label} htmlFor={`${id}-answer`}>
              {s.label}
            </label>
            <textarea
              id={`${id}-answer`}
              rows={ESSAY_ROWS}
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
          <ErrorText role="alert">
            {fmt(s.over, { n: over })}
          </ErrorText>
        ) : null}
      </div>
    </div>
  );
}
