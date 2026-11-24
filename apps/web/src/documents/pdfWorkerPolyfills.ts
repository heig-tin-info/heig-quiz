/** Installs the polyfills in the worker's scope, as a module evaluated before pdf.js's worker (`pdfWorker.ts`). */
import { installPdfPolyfills } from "./polyfills";

installPdfPolyfills();
