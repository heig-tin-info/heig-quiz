import type { ReactNode } from "react";

import type { ConfigIssue } from "@quiz/core/client";

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
    <ul className="flex flex-col gap-0.5 text-xs text-danger">
      {issues.map((issue, i) => (
        <li key={`${issue.path.join(".")}-${i}`}>{issue.message}</li>
      ))}
    </ul>
  );
}
