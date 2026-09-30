/**
 * `@quiz/docrender` — the journal's renderer (ADR-049, merge task M4-01).
 *
 * Pure: no database, no network, no clock. The API renders a page once per
 * synchronisation with it, and the web app's mock can render fixtures with
 * it. The code tokenizer is also a subpath of its own,
 * `@quiz/docrender/highlight`, which the question renderer of `apps/web`
 * imports without pulling marked nor KaTeX; and so is the navigation,
 * `@quiz/docrender/journalTree`, which the web app's journal mock builds its
 * navigation with.
 */
export * from "./assets.js";
export * from "./highlight.js";
export * from "./journalTree.js";
export * from "./render.js";
export * from "./repoName.js";
