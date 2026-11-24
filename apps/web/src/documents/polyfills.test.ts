import { describe, expect, it } from "vitest";

import { installPdfPolyfills } from "./polyfills";

/** A scope without the two functions, as Safari 16 has it. */
function oldScope() {
  // A constructor with no static methods: `new` returns a real promise.
  const OldPromise = function <T>(executor: (resolve: (v: T) => void, reject: (r?: unknown) => void) => void) {
    return new Promise<T>(executor);
  };
  class OldSignal extends EventTarget {}
  return { Promise: OldPromise as unknown as PromiseConstructor & { withResolvers?: unknown }, AbortSignal: OldSignal, AbortController };
}

describe("the polyfills of pdf.js's legacy build", () => {
  it("adds Promise.withResolvers where it is missing", async () => {
    const scope = oldScope();
    installPdfPolyfills(scope as never);
    expect(typeof scope.Promise.withResolvers).toBe("function");
    const ctor = scope.Promise as unknown as { withResolvers: () => { promise: Promise<number>; resolve: (value: number) => void } };
    const { promise, resolve } = ctor.withResolvers();
    resolve(42);
    await expect(promise).resolves.toBe(42);
  });

  it("adds AbortSignal.any where it is missing: aborted when one of them is, with its reason", () => {
    const scope = oldScope();
    installPdfPolyfills(scope as never);
    const any = (scope.AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any;
    const a = new AbortController();
    const b = new AbortController();
    const both = any([a.signal, b.signal]);
    expect(both.aborted).toBe(false);
    b.abort("gone");
    expect(both.aborted).toBe(true);
    expect(both.reason).toBe("gone");
    const done = new AbortController();
    done.abort("early");
    expect(any([done.signal]).reason).toBe("early");
  });

  it("keeps a browser's own", () => {
    const native = Promise as unknown as { withResolvers: unknown };
    const own = native.withResolvers;
    installPdfPolyfills();
    expect(native.withResolvers).toBe(own);
  });
});
