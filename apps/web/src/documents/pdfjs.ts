/**
 * pdf.js, loaded on demand: nothing of it is in the entry chunk. The first
 * PDF a viewer opens imports the library, then its viewer components
 * (`EventBus`, `PDFViewer`, `PDFLinkService`, `PDFFindController`, read from
 * `pdf_viewer.mjs`, never the prebuilt `viewer.html`) and their stylesheet,
 * once for the page.
 *
 * The LEGACY build, all three parts: the modern one needs a current browser
 * (Safari 18), and Safe Exam Browser on macOS runs the system's WebKit, so
 * an exam on an older Mac would lose its documents. The legacy build carries
 * its own polyfills but two (`polyfills.ts`).
 *
 * Everything pdf.js asks for comes from our origin (the CSP's
 * `default-src 'self'`): the worker is a file of the build (`pdfWorker.ts`),
 * started by pdf.js as a module worker from a same-origin URL (no `blob:`
 * wrapper, which pdf.js only makes for a foreign one); the character maps,
 * the standard fonts, the ICC profiles and the WebAssembly decoders are
 * copied into `/pdfjs/<version>/` by `scripts/copy-vendor-assets.mjs`, and
 * the viewer asks for the folder of the version it loaded: a tab opened
 * before an upgrade keeps reading its own (ADR-110 keeps that folder).
 */
import { installPdfPolyfills } from "./polyfills";
import workerUrl from "./pdfWorker?worker&url";

export type PdfjsLib = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
export type PdfjsViewer = typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs");

export interface Pdfjs {
  lib: PdfjsLib;
  viewer: PdfjsViewer;
}

/** Where `scripts/copy-vendor-assets.mjs` puts what pdf.js `version` fetches at run time. */
export const pdfjsAssets = (version: string) => `/pdfjs/${version}/`;

/**
 * Each range request is authenticated by the API (the file route checks the
 * session every time), so a piece is 1 MiB rather than pdf.js's 64 KiB.
 * A file under two pieces arrives in one plain GET.
 */
export const RANGE_CHUNK = 1 << 20;

/**
 * How a document is fetched and read. Exported for its test: these options
 * are the viewer's hardening, not a matter of taste.
 */
export function documentParams(url: string, version: string) {
  const assets = pdfjsAssets(version);
  return {
    url,
    // Same-origin cookies, as every fetch of the app (`api.ts`); `true`
    // would send them cross-origin, which a document never needs.
    withCredentials: false,
    // By ranges only, and only what the pages on screen (or a search) need.
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: RANGE_CHUNK,
    // No XFA form is rendered: a form is no part of a document provided to read.
    enableXfa: false,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    // A font the PDF does not embed is drawn from the standard fonts we
    // serve, never from the machine's own: the same page on every machine.
    useSystemFonts: false,
    iccUrl: `${assets}iccs/`,
    wasmUrl: `${assets}wasm/`,
  };
}

let loading: Promise<Pdfjs> | null = null;

/** The library and its viewer components, imported once; a failed import is tried again next time. */
export function loadPdfjs(): Promise<Pdfjs> {
  loading ??= (async () => {
    installPdfPolyfills();
    const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // `pdf_viewer.mjs` reads the core library from `globalThis.pdfjsLib`, so
    // it is imported after that is set.
    (globalThis as { pdfjsLib?: PdfjsLib }).pdfjsLib = lib;
    const [viewer] = await Promise.all([
      import("pdfjs-dist/legacy/web/pdf_viewer.mjs"),
      import("pdfjs-dist/legacy/web/pdf_viewer.css"),
    ]);
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    return { lib, viewer };
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
