/**
 * The one place this package parses a `cloze` config.
 *
 * The predefined choice sets are part of the grammar — `{{1}}` is a dropdown
 * only because a set is named "1" — so forgetting them at one call site is
 * exactly how a blank would change kind between the editor, `toStudent` and
 * the grader. Every caller goes through here.
 *
 * Its own module rather than `server.ts`, because `grade.ts` needs it and
 * `server.ts` needs `grade.ts`.
 */
import { parseCloze, type ClozeParse } from "@quiz/domain";
import type { ClozeConfig } from "./schema.js";

export function clozeParse(config: ClozeConfig): ClozeParse {
  return parseCloze(config.text, config.choiceSets ?? []);
}
