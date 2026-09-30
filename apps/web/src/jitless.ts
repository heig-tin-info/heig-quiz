/**
 * Zod without its JIT, so the SPA runs under a CSP without `'unsafe-eval'`
 * (N-SEC-02, `apps/api/src/csp.ts`).
 *
 * Zod 4 compiles object parsers with `new Function` when it can, and finds out
 * whether it can by trying: under our policy the attempt throws, Zod falls
 * back to the interpreted parser, and the browser still reports a CSP
 * violation on every page load. `jitless` skips the probe and the compile.
 *
 * It must run before any schema is BUILT (Zod reads the flag at
 * construction), so `main.tsx` imports this module first, before anything
 * that pulls `@quiz/contracts` or a question type.
 */
import { z } from "zod";

z.config({ jitless: true });
