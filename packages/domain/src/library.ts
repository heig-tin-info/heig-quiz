/**
 * The course library (F-ORG-18, ADR-144): the kinds of document a course may
 * hold. The kind is decided by the bytes of the upload, never by the type a
 * browser declared (N-SEC-24).
 */
export const DOCUMENT_KINDS = ["pdf", "markdown"] as const;
