# TODO

What is known, decided to be left as is for now, and worth a line so it is
not rediscovered. Product questions live in `docs/spec/06-questions-ouvertes.md`;
this file is for engineering debts.

- **Browser runner memory cap.** The Runno runtimes (`clang.wasm`,
  `wasm-ld.wasm`, `python-3.11.3.wasm`) EXPORT their linear memory, so
  `WebAssembly.Memory({ maximum })` cannot be imposed on them and the 2 s
  wall clock is the only bound (`apps/web/src/runner/runno/runner.ts`,
  ADR-015). A real cap needs the runtimes rebuilt with `--import-memory`;
  the code already takes the capped path when a module imports its memory.
  Left as is until a memory bomb in a trial run is observed to matter.
- **Lucide aliases in the pool icon catalogue.** `iconNames` lists ~1 994
  names for ~1 500 icons: a search can show one glyph twice under two names.
  No runtime way to tell an alias from its canonical name. Cosmetic.
- **Dependabot** reports vulnerabilities on the default branch; they are in
  transitive development dependencies and need a pass of their own.
