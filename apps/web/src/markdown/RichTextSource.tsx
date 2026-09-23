import { FileCode2 } from "lucide-react";
import type { ReactNode } from "react";

import type { RichTextProps } from "@quiz/core/client";

import { useT } from "../i18n";
import { IconButton } from "../ui";
import { SourcePane } from "./SourcePane";

/*
 * The markdown source half of the rich text field: the button that swaps the
 * surface for the source and back, and the source pane as a rich field
 * configures it. The pane edits the very string the rich surface does.
 */

/** The last button of the toolbar, and the trailing one of the source pane. */
export function SourceToggle({
  source,
  disabled,
  onToggle,
}: {
  source: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <IconButton
      size="sm"
      label={t("md.source")}
      active={source}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      <FileCode2 />
    </IconButton>
  );
}

/** The source pane of a rich field, with the field's label, placeholder and uploader. */
export function RichTextSourcePane({
  fieldId,
  value,
  onChange,
  ariaLabel,
  placeholder,
  disabled,
  inline,
  uploadImage,
  trailing,
}: {
  fieldId: string;
  value: string;
  onChange: RichTextProps["onChange"];
  ariaLabel: string | undefined;
  placeholder: string | undefined;
  disabled: boolean;
  inline: boolean;
  uploadImage: RichTextProps["uploadImage"];
  trailing: ReactNode;
}) {
  const t = useT();
  return (
    <SourcePane
      id={fieldId}
      value={value}
      onChange={onChange}
      label={ariaLabel ?? t("md.label")}
      placeholder={placeholder ?? t("md.placeholder.body")}
      disabled={disabled}
      rows={inline ? 3 : 8}
      {...(uploadImage === undefined ? {} : { uploadImage })}
      trailing={trailing}
    />
  );
}
