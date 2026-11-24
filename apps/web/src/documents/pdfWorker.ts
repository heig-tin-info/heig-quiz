/**
 * pdf.js's worker (legacy build), preceded by the polyfills it needs on an
 * older WebKit (`polyfills.ts`). Vite bundles this file as a worker of its
 * own (`?worker&url` in `pdfjs.ts`): a hashed asset of our origin, which
 * pdf.js starts as a module worker. The ES import order runs the polyfills
 * first.
 */
import "./pdfWorkerPolyfills";
import "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
