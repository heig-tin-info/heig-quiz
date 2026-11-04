/**
 * The pieces every staff document of the export factory (ADR-121) opens an
 * item and itself with: the item's heading, statement, key and explanation,
 * and the provenance. Pure: the Sources in the modules hand in what they read,
 * and the labels of the requester's language.
 */
import type { AnyQuestionTypeServer } from "@quiz/core/server";
import { heading, labelled, markdown, pointsShort, type Block, type Labels, type Provenance } from "@quiz/docexport";

/** `### Statement` and the statement, through the type's hook (the caller checked it is there). */
export const statementBlocks = (type: AnyQuestionTypeServer, statement: unknown, l: Labels): Block[] => [
  heading(3, l.statement),
  ...type.statementDoc!(statement, l),
];

/** `### Reference solution` and the key, when the type draws one. */
export const solutionBlocks = (type: AnyQuestionTypeServer, solution: unknown, statement: unknown, l: Labels): Block[] =>
  type.solutionDoc ? [heading(3, l.referenceSolution), ...type.solutionDoc(solution, statement, l)] : [];

/** `### Explanation` and its text, when there is one. */
export const explanationBlocks = (text: string | null, l: Labels): Block[] =>
  text ? [heading(3, l.explanation), markdown(text)] : [];

/**
 * `## Question n: name`, its points set apart at the line's end (`2 pt`),
 * the statement and, when the type draws one, the reference solution.
 * `position` is the item's canonical place.
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
    heading(2, labelled(l, `${l.question} ${position + 1}`, name), pointsShort(l, points)),
    ...statementBlocks(type, statement, l),
    ...solutionBlocks(type, solution, statement, l),
  ];
}

/**
 * A record's provenance (ADR-121 §5): its kind, version and clock, the
 * source's ids, the attempts it holds. The build (`app`) is stamped by
 * `sendExport`, the one place a document leaves the server.
 */
export const provenanceOf = (
  record: { kind: string; version: number; generatedAt: string },
  source: Readonly<Record<string, string>>,
  attempts: readonly string[],
): Provenance => ({
  kind: record.kind,
  version: record.version,
  source,
  attempts,
  generatedAt: record.generatedAt,
  app: null,
});
