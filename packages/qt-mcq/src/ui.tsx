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

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Field chrome: the `--radius-field` token, `line-strong` hairline, accent
 * ring on focus. The RADIUS is a token and not `rounded-xl` on purpose — the
 * field radius of `apps/web/src/style.css` is a value the design owns, and a
 * literal here would drift the day it changes.
 */
export const inputClass =
  "rounded-field border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50";

export const labelClass = "text-[13px] font-medium text-fg";
export const helpClass = "text-xs text-fg-faint";
export const sectionClass = "flex flex-col gap-2";
export const legendClass = "text-[13px] font-medium text-fg";

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

/** Letter of a choice, as the editor and the review show it: A, B, C… */
export function choiceLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26));
}

/**
 * The segmented control of `apps/web/src/ui.tsx`, mirrored here class for
 * class: a pill track on `surface-3`, the selected option lifted onto
 * `surface` with a hairline ring. A `qt-*` package cannot import the app's
 * primitives (`packages/ui` is a later work package), so the markup is copied
 * and the TOKENS are what keeps the two in step.
 *
 * Native radios, visually hidden inside the labels: the arrow keys, the
 * grouping and the announcement come from the platform rather than from a
 * `role="radiogroup"` re-implementation.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled,
}: {
  /** Groups the native radios (one editor holds several groups). */
  name: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <div
      role="radiogroup"
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
 * Two icons, drawn here rather than imported: `lucide-react` is a dependency
 * of `apps/web`, not of this package, and a leaf question type has no business
 * pulling an icon set of its own (`McqIcon` in `client.tsx` does the same).
 */
export function GripIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
    </svg>
  );
}

export function TrashIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 12A1.5 1.5 0 0 0 8.8 20.5h6.4a1.5 1.5 0 0 0 1.5-1.5l.8-12" />
    </svg>
  );
}

/** Round, borderless control the size of a row: the handle and the bin. */
export const iconButtonClass =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40";
