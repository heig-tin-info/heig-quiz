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

/** Field chrome: 12 px radius, `line-strong` hairline, accent ring on focus. */
export const inputClass =
  "rounded-xl border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50";

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
 * A card, in the little of `apps/web`'s `Card` a leaf package can carry: the
 * card radius, one hairline, the surface — and no shadow, because nothing in
 * the page flow has one. One predefined choice set wears it.
 */
export const cardClass = "rounded-card border border-line bg-surface p-3";

/** Round, borderless control the size of a row: the bin. */
export const iconButtonClass =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40";

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
