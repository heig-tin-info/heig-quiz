/**
 * Two readings every player and review makes of what it is handed (audit
 * P-01i and P-01m).
 */
import type { ReactNode } from "react";

import type { MarkdownRenderer } from "@quiz/core/client";

/**
 * Authored markdown through the host's sanitised renderer, or as plain text
 * when the host lent none (a test, another host): a `qt-*` package never owns
 * a markdown pipeline of its own.
 */
export function markdown(render: MarkdownRenderer | undefined, source: string): ReactNode {
  return render ? render(source) : source;
}

/**
 * The type's own grading breakdown, or `null` when `details` is not one.
 *
 * `details` comes off the wire as whatever `gradings.details` holds: this
 * type's breakdown OR a grading-level marker — an absent answer, an
 * unreadable configuration, a grader that threw — which carries none of the
 * breakdown's fields. Reading a marker as a breakdown is a crash or a blank
 * page on the one screen whose job is to reassure, so a review asks for its
 * breakdown by the ARRAY it must carry (`cases`, `stimuli`, `perBlank`).
 */
export function breakdownOf<T extends object>(
  details: T | null | undefined,
  key: keyof T,
): T | null {
  return details !== null && details !== undefined && Array.isArray(details[key]) ? details : null;
}
