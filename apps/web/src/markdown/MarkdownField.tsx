import { useCallback, useId } from "react";

import { useT } from "../i18n";
import { cx } from "../ui";
import { RichText } from "./RichText";

/*
 * The markdown field a teacher writes a prompt in (PLAN-MVP §6.7, decision
 * D11; docs/spec/05 §5.10 for the Tiptap decision).
 *
 * Markdown is the single source of truth, and what is left here is the label,
 * the hint line and the upload adapter: `RichText` holds BOTH surfaces now —
 * the Tiptap one and the markdown source underneath it — and swaps between
 * them from the last button of its own toolbar.
 *
 * That is the second round of teacher feedback: "Write / Source" as a
 * segmented control named two things the reader had no reason to tell apart,
 * and it sat on every field of the editor. One toggle, at the end of the
 * toolbar, pressed-state and all, says the same thing where the other
 * formatting buttons are — and a field whose source nobody needs (a choice of
 * an mcq) simply does not carry it.
 *
 * There is no "Preview" pane either. The rich surface IS the preview — it
 * renders with the student's own `.md-body` stylesheet — and a button that
 * shows what the pane next to it already shows is a button nobody presses.
 */

export interface MarkdownFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name of the field; also the visible label when set. */
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  /**
   * Uploads a pasted or dropped image and returns its asset id. Without it
   * the image affordances are hidden rather than shown broken: a button that
   * cannot work is worse than one that is not there.
   */
  onUploadImage?: (file: File) => Promise<{ id: string }>;
  className?: string;
}

export function MarkdownField({
  value,
  onChange,
  label,
  placeholder,
  disabled,
  id,
  onUploadImage,
  className = "",
}: MarkdownFieldProps) {
  const t = useT();
  const auto = useId();
  const fieldId = id ?? auto;

  /**
   * What `RichText` expects: the asset REFERENCE, not the id. One line, and
   * it keeps `onUploadImage` the shape every caller already passes.
   */
  const uploadImage = useCallback(
    async (image: File) => {
      const { id: assetId } = await onUploadImage!(image);
      return `asset:${assetId}`;
    },
    [onUploadImage],
  );

  const showImage = onUploadImage != null;

  return (
    <div className={cx("flex flex-col gap-2", className)}>
      {label ? (
        <label htmlFor={fieldId} className="text-[13px] font-medium text-fg">
          {label}
        </label>
      ) : null}

      <RichText
        id={fieldId}
        value={value}
        onChange={onChange}
        {...(placeholder === undefined ? { placeholder: t("md.placeholder.body") } : { placeholder })}
        aria-label={label ?? t("md.label")}
        {...(disabled === undefined ? {} : { disabled })}
        {...(showImage ? { uploadImage } : {})}
      />

      <p id={`${fieldId}-hint`} className="text-xs text-fg-faint">
        {showImage ? t("md.hint.withImages") : t("md.hint")}
      </p>
    </div>
  );
}
