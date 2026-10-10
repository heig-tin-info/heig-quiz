import type { TeacherCandidate } from "@quiz/contracts";

import { ok } from "./render";

/**
 * The stubs of a `TeacherPicker` search: the picker asks after every
 * keystroke, so one stub per prefix of what is typed, the empty one
 * included, all answering `rows`. `url` is the candidates route, without
 * its `?q=`.
 */
export function candidatesFor(url: string, typed: string, rows: TeacherCandidate[]) {
  const stubs: Record<string, ReturnType<typeof ok>> = {};
  for (let i = 0; i <= typed.length; i += 1) {
    stubs[`GET ${url}?q=${encodeURIComponent(typed.slice(0, i))}`] = ok(rows);
  }
  return stubs;
}
