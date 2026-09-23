/**
 * The sections the code and circuit editors are both made of (audit P-15):
 * a titled card, the statement card that opens every editor, and the
 * "Advanced options" fold that closes it. What differs between the two
 * editors is what goes INSIDE these blocks; the blocks themselves were the
 * same markup written twice.
 */
import type { ReactNode } from "react";

import type { ConfigIssue, RichTextComponent } from "@quiz/core/client";

import { IssueList } from "./issues.js";
import { PromptField } from "./PromptField.js";
import { card, cx, hint as hintToken, input, label, sectionTitle } from "./styles.js";

/**
 * One card of an editor's main column: its title, an optional one-line
 * explanation, then its fields. `gap` is the rhythm inside the card —
 * `gap-4` for the statement card, whose fields are tall, `gap-3` otherwise.
 * Without a `title` the caller writes its own heading row (a title with a
 * badge beside it, a list header with its "add" button).
 */
export function EditorSection({
  title,
  hint,
  gap = "gap-3",
  children,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  gap?: "gap-3" | "gap-4";
  children?: ReactNode;
}): ReactNode {
  return (
    <section className={cx(card, gap === "gap-4" ? "flex flex-col gap-4 p-4" : "flex flex-col gap-3 p-4")}>
      {title === undefined ? null : <h3 className={sectionTitle}>{title}</h3>}
      {hint === undefined ? null : <p className={hintToken}>{hint}</p>}
      {children}
    </section>
  );
}

/**
 * The statement card every editor opens with: the prompt field and the
 * issues found on it, then whatever settings of the type belong beside the
 * statement (a language, a runtime).
 */
export function PromptSection({
  title,
  id,
  label: fieldLabel,
  value,
  onChange,
  disabled,
  RichText,
  uploadImage,
  rows,
  issues,
  children,
}: {
  /** The card's heading ("Question"). */
  title: ReactNode;
  id: string;
  /** The field's caption and accessible name ("Statement"). */
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  RichText?: RichTextComponent | undefined;
  uploadImage?: ((file: File) => Promise<string>) | undefined;
  rows?: number | undefined;
  /** The issues found at the `prompt` path. */
  issues: readonly ConfigIssue[];
  children?: ReactNode;
}): ReactNode {
  return (
    <EditorSection title={title} gap="gap-4">
      <div className="flex flex-col gap-1.5">
        <PromptField
          id={id}
          label={fieldLabel}
          value={value}
          onChange={onChange}
          disabled={disabled}
          RichText={RichText}
          uploadImage={uploadImage}
          {...(rows === undefined ? {} : { rows })}
          labelClassName={label}
          textareaClassName={cx(input, "w-full py-2 leading-relaxed")}
        />
        <IssueList issues={issues} />
      </div>
      {children}
    </EditorSection>
  );
}

/**
 * The fold at the bottom of an editor: what a teacher touches once a term.
 * Native `<details>`, so the keyboard and the announcement are the
 * platform's. `className` lays out the body (`grid gap-4 sm:grid-cols-2`,
 * `flex flex-col gap-3`).
 */
export function AdvancedDisclosure({
  summary,
  className,
  children,
}: {
  summary: ReactNode;
  className: string;
  children: ReactNode;
}): ReactNode {
  return (
    <details className={cx(card, "p-4")}>
      <summary className={cx(sectionTitle, "cursor-pointer")}>{summary}</summary>
      <div className={cx("mt-4", className)}>{children}</div>
    </details>
  );
}
