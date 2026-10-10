import type { PoolDetail } from "@quiz/contracts";

/**
 * What the concept pickers rank first for a pool: its own concepts, then
 * those of the courses the caller staffs that it is linked to (ADR-081 §5).
 * One rule for the question editor's picker and the bulk bar's.
 */
export const pickerConceptIds = (detail: Pick<PoolDetail, "concepts" | "courseConceptIds">): string[] => [
  ...detail.concepts.map((c) => c.concept.id),
  ...detail.courseConceptIds,
];
