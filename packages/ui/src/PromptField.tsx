import type { ReactNode } from "react";

import type { RichTextComponent } from "@quiz/core/client";

/**
 * The statement field of an editor, with its label (audit P-01b): the host's
 * WYSIWYG editor when it lent one (`EditorProps.RichText`), a textarea
 * otherwise. There is no preview block under either: with `RichText` the
 * field IS the preview, and under a textarea a second rendering of the string
 * the teacher is looking at is noise.
 *
 * A caption and not a `<label for>` when the host lent its rich editor: its
 * surface is a contenteditable, which is not a labelable element — the
 * browser reports such a `for` as matching no control, and the field takes
 * its name from `aria-label` instead. The textarea fallback is a real control
 * and keeps its label.
 *
 * It renders the label and the field as siblings, so the caller keeps its own
 * wrapper (and puts its hint and its issues after them).
 */
export function PromptField({
  id,
  label,
  value,
  onChange,
  disabled,
  RichText,
  uploadImage,
  holes,
  rows = 4,
  labelClassName,
  textareaClassName,
}: {
  /** Shared by both surfaces, so a host can focus the field by id. */
  id: string;
  /** Already translated: the caption AND the accessible name. */
  label: string;
  /** Markdown. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  RichText?: RichTextComponent | undefined;
  /** Given to the rich editor only; the textarea has nowhere to drop an image. */
  uploadImage?: ((file: File) => Promise<string>) | undefined;
  /** `cloze` only: the `{{…}}` holes are objects of the rich field (`RichTextProps.holes`). */
  holes?: boolean | undefined;
  rows?: number | undefined;
  labelClassName: string;
  textareaClassName: string;
}): ReactNode {
  if (RichText) {
    return (
      <>
        <span className={labelClassName}>{label}</span>
        <RichText
          id={id}
          aria-label={label}
          value={value}
          onChange={onChange}
          {...(holes === true ? { holes } : {})}
          {...(disabled === undefined ? {} : { disabled })}
          {...(uploadImage === undefined ? {} : { uploadImage })}
        />
      </>
    );
  }
  return (
    <>
      <label className={labelClassName} htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        className={textareaClassName}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </>
  );
}
