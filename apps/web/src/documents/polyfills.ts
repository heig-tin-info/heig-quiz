/**
 * The two functions pdf.js's legacy build calls without shipping a polyfill
 * for them (its core-js covers the rest): `Promise.withResolvers` (in the
 * library, its viewer components and its worker) and `AbortSignal.any` (in
 * the library and the viewer components). Both arrived in Safari 17.4; the
 * app targets Safari 16.4, and Safe Exam Browser on macOS runs the system's
 * WebKit, so an older Mac must still open a document. Installed in the page
 * before pdf.js is imported (`pdfjs.ts`) and in the worker before pdf.js's
 * worker (`pdfWorker.ts`). A browser that has them keeps its own.
 */

type Resolvers<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };

interface Scope {
  Promise: { withResolvers?: unknown } & PromiseConstructor;
  AbortSignal?: { any?: unknown; new (): AbortSignal };
  AbortController?: new () => AbortController;
}

export function installPdfPolyfills(scope: Scope = globalThis as unknown as Scope): void {
  if (typeof scope.Promise.withResolvers !== "function") {
    const PromiseCtor = scope.Promise;
    Object.defineProperty(PromiseCtor, "withResolvers", {
      configurable: true,
      writable: true,
      value: function withResolvers<T>(): Resolvers<T> {
        let resolve!: (value: T) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new PromiseCtor<T>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      },
    });
  }
  const { AbortSignal: Signal, AbortController: Controller } = scope;
  if (Signal && Controller && typeof Signal.any !== "function") {
    Object.defineProperty(Signal, "any", {
      configurable: true,
      writable: true,
      value: function any(signals: Iterable<AbortSignal>): AbortSignal {
        const controller = new Controller();
        for (const signal of signals) {
          if (signal.aborted) {
            controller.abort(signal.reason);
            break;
          }
          signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true, signal: controller.signal });
        }
        return controller.signal;
      },
    });
  }
}
