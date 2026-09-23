/**
 * The few shared class strings and helpers of this package's components.
 *
 * A `qt-*` package cannot import `apps/web/src/ui.tsx` (packages never depend
 * on an app), and `packages/ui` is a later work package, so the markup here is
 * plain semantic HTML carrying the design tokens of `apps/web/DESIGN.md`:
 * hairlines and surfaces, no shadow in the page flow, no raw colour, no `dark:`
 * variant — the tokens swap by themselves.
 */
import type { ReactNode } from "react";
import type { ConfigIssue } from "@quiz/core/client";
import { cx } from "@quiz/ui";

/** Field chrome: 12 px radius, `line-strong` hairline, accent ring on focus. */
export const inputClass =
  "rounded-xl border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50";

export const labelClass = "text-[13px] font-medium text-fg";
export const helpClass = "text-xs text-fg-faint";
export const sectionClass = "flex flex-col gap-2";

/** Secondary button chrome (pill, hairline), for the editor's add/remove actions. */
export const buttonClass =
  "inline-flex h-7 shrink-0 select-none items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2 disabled:opacity-50";

/** The issues whose path starts with `path` (decision D16 reporting). */
export function issuesAt(
  issues: readonly ConfigIssue[],
  ...path: (string | number)[]
): ConfigIssue[] {
  return issues.filter((issue) => path.every((part, i) => issue.path[i] === part));
}

/** The issues that belong to the config as a whole (an empty zod path). */
export function rootIssues(issues: readonly ConfigIssue[]): ConfigIssue[] {
  return issues.filter((issue) => issue.path.length === 0);
}

/**
 * Validation feedback under a field. The message is shown verbatim: a `qt-*`
 * package emits i18n keys, the host decides how to present them.
 */
export function IssueList({ issues }: { issues: readonly ConfigIssue[] }): ReactNode {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-danger">
      {issues.map((issue, i) => (
        <li key={`${issue.path.join(".")}-${i}`}>{issue.message}</li>
      ))}
    </ul>
  );
}

/**
 * The app's segmented control, mirrored from `apps/web/src/ui.tsx` the way
 * `packages/qt-mcq/src/ui.tsx` mirrors it — a leaf package cannot import the
 * app's primitives (`packages/ui` is a later work package), so the markup is
 * copied and the TOKENS are what keeps the three in step.
 *
 * Native radios, visually hidden inside the labels: the arrow keys, the
 * grouping and the announcement come from the platform rather than from a
 * `role="radiogroup"` re-implementation.
 *
 * Its track is 34 px tall, exactly the height of `inputClass`, so a segmented
 * control and the fields beside it sit on one baseline.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled,
  labelledBy,
}: {
  /** Groups the native radios (one editor holds several groups). */
  name: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  disabled?: boolean | undefined;
  /** The id of the element that names the group — a radiogroup needs one. */
  labelledBy?: string | undefined;
}): ReactNode {
  return (
    <div
      role="radiogroup"
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      className={cx(
        "inline-flex shrink-0 flex-wrap gap-0.5 rounded-full bg-surface-3 p-0.75",
        disabled && "opacity-60",
      )}
    >
      {options.map((o) => (
        <label
          key={o.value}
          className={cx(
            "inline-flex h-7 items-center justify-center rounded-full px-3 text-[13px] font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent/50",
            value === o.value
              ? "bg-surface text-fg ring-1 ring-line-strong/70"
              : cx("text-fg-muted", !disabled && "cursor-pointer hover:text-fg"),
          )}
        >
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/**
 * A checkbox and its word. `h-8.5` is the height of a field, so a checkbox
 * dropped into a row of labelled fields lands on their baseline instead of
 * floating half a line above it.
 */
export function CheckboxField({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean | undefined;
  onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <label className="inline-flex h-8.5 items-center gap-1.5 text-[13px] text-fg-muted">
      <input
        type="checkbox"
        className="size-4 accent-accent"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/** One cell of a row of labelled fields: the label above, the control below. */
export function FieldCell({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <label className={labelClass} {...(htmlFor === undefined ? {} : { htmlFor })}>
        {label}
      </label>
      {children}
    </div>
  );
}
