/**
 * `@quiz/docexport` — the document tree of the export factory (ADR-121 §1).
 *
 * Pure: no database, no network, no clock. A Source in the API builds a
 * {@link Document} (the question types add their blocks through the hooks of
 * `QuestionTypeServer`), and the Markdown renderer,
 * `@quiz/docexport/markdown` (Node only: it hashes the body), turns it into
 * a file. The tree is internal: no route serves it, the JSON export is the
 * record.
 */
export * from "./document.js";
