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
