import type { HTMLAttributes, ReactNode } from "react";

import type { ConfigIssue } from "@quiz/core/client";

import { AlertIcon } from "./icon.js";
import { cx } from "./styles.js";

/**
 * One line of error, in the danger ink, marked by a circled "!" so that it
 * reads as a refusal at a glance and not as a red hint. The icon is sized in
 * `em`: it follows whatever text size the caller gives the line. Every inline
 * error of the app goes through it — the editors' issues, a field refused by
 * a dialog, a mutation that failed — so there is one look for "this is wrong".
 *
 * A `<p>` by default; `as="li"` inside a list, `as="span"` inside a phrase.
 * 13 px, or 12 px with `small` (the issues under an editor's field): a size
 * prop and not a class, since `cx` does not merge two text sizes.
 */
export function ErrorText({
  as: Tag = "p",
  small,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & { as?: "p" | "li" | "span" | "div"; small?: boolean }): ReactNode {
  return (
    <Tag {...rest} className={cx("flex items-start gap-1.5 text-danger", small ? "text-xs" : "text-[13px]", className)}>
      <AlertIcon className="mt-[0.2em] size-[1.1em] shrink-0" />
      <span className="min-w-0">{children}</span>
    </Tag>
  );
}

/**
 * Validation feedback under a field (decision D16). The message is shown
 * verbatim: a `qt-*` package emits i18n keys, the host decides how to present
 * them. Nothing at all is drawn when there is nothing to say.
 *
 * `issuesAt` and `rootIssues`, which pick what goes under which field, are
 * the contract's and live in `@quiz/core/client` beside `ConfigIssue`.
 */
export function IssueList({ issues }: { issues: readonly ConfigIssue[] }): ReactNode {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {issues.map((issue, i) => (
        <ErrorText as="li" small key={`${issue.path.join(".")}-${i}`}>
          {issue.message}
        </ErrorText>
      ))}
    </ul>
  );
}
