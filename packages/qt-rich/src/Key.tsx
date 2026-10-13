/**
 * The `rich` answer key of the debrief (ADR-033, ADR-109): an essay's model
 * answer, once revealed, after the host's statement and answer groups.
 *
 * NEVER its grading criteria (`solution.rubric`): they are the grader's
 * (ADR-037), on the grading screen, and the debrief is read by a class.
 *
 * Staff only (`QuestionTypeClient.Key`): never mounted on a student surface.
 */
import type { KeyProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { NotePanel } from "@quiz/ui";

import type { RichSolution, RichStudent } from "./schema.js";
import { richKeyStrings, type RichKeyStringKey } from "./strings.js";

type RichKeyProps = KeyProps<RichStudent, RichSolution> & {
  strings?: StringOverrides<RichKeyStringKey>;
};

export function RichKey({ solution, revealed, stats, prompt, rows, renderBlock, strings }: RichKeyProps) {
  const s = resolveStrings(richKeyStrings, strings);
  const reference = solution?.reference;
  const model = revealed && typeof reference === "string" && reference.trim() !== "" ? reference : null;
  return (
    <>
      {prompt}
      {/* The blanks alone say nothing the head does not: a row of them needs groups. */}
      {stats.distribution.length > 0 ? rows : null}
      {model === null ? null : <NotePanel eyebrow={s.modelAnswer}>{renderBlock(model)}</NotePanel>}
    </>
  );
}
