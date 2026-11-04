/**
 * The pieces every staff document of the export factory (ADR-121) opens an
 * item and itself with: the item's heading, statement and key, and the
 * provenance. Pure: the Sources in the modules hand in what they read.
 */
import type { AnyQuestionTypeServer } from "@quiz/core/server";
import { heading, number, type Block, type Labels, type Provenance } from "@quiz/docexport";

/**
 * `## Question n: name (p points)`, the statement and, when the type draws
 * one, the reference solution. `position` is the item's canonical place.
 */
export function itemKeyBlocks(
  type: AnyQuestionTypeServer,
  position: number,
  name: string,
  points: number,
  statement: unknown,
  solution: unknown,
  l: Labels,
): Block[] {
  return [
    heading(2, `${l.question} ${position + 1}: ${name} (${number(points)} points)`),
    heading(3, l.statement),
    ...type.statementDoc!(statement, l),
    ...(type.solutionDoc ? [heading(3, l.referenceSolution), ...type.solutionDoc(solution, statement, l)] : []),
  ];
}

/** A record's provenance (ADR-121 §5): its kind, version and clock, the source's ids, the attempts it holds. */
export const provenanceOf = (
  record: { kind: string; version: number; generatedAt: string },
  source: Readonly<Record<string, string>>,
  attempts: readonly string[],
  app: string | null,
): Provenance => ({
  kind: record.kind,
  version: record.version,
  source,
  attempts,
  generatedAt: record.generatedAt,
  app,
});
