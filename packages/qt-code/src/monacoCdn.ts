/**
 * Where Monaco comes from: the jsDelivr copy of `monaco-editor`, pinned.
 *
 * `@monaco-editor/react` does not bundle the editor; its loader injects
 * `<script src="${MONACO_VS}/loader.js">` and pulls the rest (modules, CSS,
 * the codicon font) from the same directory. The path is set here rather than
 * left to the loader's default because the API's Content-Security-Policy
 * (`apps/api/src/csp.ts`) admits exactly this directory and no other: one
 * constant, read by both, so a version bump cannot silently fall outside the
 * policy and leave every student on the plain textarea.
 *
 * No React here: `./server` re-exports it for the API.
 */
export const MONACO_VS = "https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs";
