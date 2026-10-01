/**
 * What a host makes of an image's `src` in the rich editor: the URL to draw
 * it from, {@link REFUSED}, or null to leave it to the asset rule of
 * `tiptap.ts`. A module of its own, without the editor, so that a pure
 * resolver (the journal's, `journal/editor/images.ts`) does not load Tiptap.
 */
export type ImageUrl = (src: string) => string | typeof REFUSED | null;

/**
 * The answer for a picture that must NEVER be fetched (the journal's external
 * images, F-JRN-09): no `src` reaches the DOM, the alt text shows instead,
 * and the markdown keeps the reference verbatim.
 */
export const REFUSED = Symbol("refused image");
