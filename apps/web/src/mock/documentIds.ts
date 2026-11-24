/**
 * The ids of PRG1's first two documents (`library.ts`), which its draft exam
 * and the student's exam provide (ADR-144 §7): a leaf both mock files import,
 * so neither reads the other at load.
 */
export const FORMULAIRE_ID = "5b0c8a1e-2f7d-4c3a-9e61-0d4b7a2c1f01";
export const AIDE_MEMOIRE_ID = "5b0c8a1e-2f7d-4c3a-9e61-0d4b7a2c1f02";

/** What the mock's exams provide, in their order. */
export const MOCK_PROVIDED = [FORMULAIRE_ID, AIDE_MEMOIRE_ID] as const;
