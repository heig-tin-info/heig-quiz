# ADR-099 — Regex matchers on RE2: linear matching, bounded programs, refused at publication only

## Status

Accepted (2026-10-10), security audit finding H3. Amends decision D10 of
[PLAN-MVP §9](../PLAN-MVP.md) (the engine and where the refusal applies; the
pattern, input and flag limits stay).

Scope: the `regex` matchers of `short` and the regex blanks of `cloze`
(`packages/domain/src/regex.ts`).

## Context

D10 bounded a pattern to 300 characters and the input to 500, on the premise
that matchers run in the grading worker, off the request path. They do not:
the live verdict of every autosave, practice, the author's try and grading
all match in the one API process that also carries the deadline ticker and
the SSE streams. JavaScript's `RegExp` backtracks, and one careless pattern
on one ordinary answer froze the whole API for a minute (H3). Bounding the
input does not help an engine that is exponential in it.

Three further costs showed up once the engine was linear in the input:
the program itself (`(.?){999}` is 4 000 instructions, each walked per input
character), the build (under `i`, a range such as `[Ā-\u{10FFFF}]` is folded
code point by code point, 35 ms a copy; each `\p{Ll}` merges its table with
the folding table, 0.2 ms), the memory a compiled program keeps (a written-out
`\pL` holds some 1 400 ranges, and re2js's one-pass matcher copies a class
into every instruction that tests it), and the sum over one question: fifty
blanks, each acceptable alone, built on every draft save.

## Decision

1. **Engine.** Patterns compile with RE2 through `re2js`, a pure JavaScript
   port pinned to one version: no native module, no install script, no
   toolchain in the image. The pattern syntax is RE2's: a backreference, a lookahead or
   lookbehind, a `\u` escape and other JavaScript-only syntax are refused.
   Flags `ims` map to RE2's inline flags, `u` is RE2's default; the full
   match stays `^(?:pattern)$`.
2. **Bounds, each checked before the next costs anything:** D10's limits; a
   static estimate read on the pattern's text — program size at most twice
   the bound below, at most 2 000 code points folded one by one, at most ten
   Unicode property escapes written, at most 50 000 class ranges copied by
   repetitions (a property counting as a thousand) — so the slowest pattern
   accepted builds in about 5–6 ms warm, 12 ms the first time after a start
   (re2js 2.8.6); the compiled program at most 500
   instructions; its weight in memory (its instructions, class runes and
   one-pass tables) at most 250 kB. re2js's prefilter for alternations of
   literals is dropped (it only rules out unanchored searches early, and
   every source here is anchored), and so is a one-pass matcher that alone
   would pass the bound (the match stays linear without it). Compiled
   patterns and refusals are cached, least recently used first out once the
   weights pass 48 MB; the weights are calibrated so that a cache full of the
   heaviest accepted families holds about half of that. The weight reads
   re2js's program (pinned version, shape asserted by a test).
3. **One question's budget.** Publication first sums the estimated build
   time of all the patterns of one question (its matchers, its blanks) and
   refuses past 25 ms (`regex.config_too_complex`), building none of them.
4. **The measured time is the invariant, the estimate the filter.** The
   estimate prices what re2js is known to do; whatever it does that the
   estimate misses is cut by the clock. A pattern whose build took over
   50 ms (about ten times the slowest first build the estimate admits) is
   refused at publication as too complex until the entry is evicted or the
   process restarts; the build is kept, and grading uses it. A question
   stops building once its builds have taken 100 ms, refused as
   `regex.config_too_complex`. The margins keep a pause of the process or a
   coverage run from refusing a legitimate pattern. A draft save thus costs
   at most 100 ms of builds plus one build whose length the estimate bounds
   (about 5–6 ms warm, 12 ms the first after a start, on re2js 2.8.6).
5. **No computed regex.** A cloze regex blank of a parameterized question
   may not hold a `[[…]]` reference (`cloze.computed_regex_key`), as a
   `short` text or regex key may not (ADR-056 §10, `short.computed_text_key`):
   every student's instance would be a pattern of its own, built cold at the
   first grade. That gap predates this record.
6. **Where the refusal applies.** A pattern RE2 refuses is a publication
   issue (the types' `publicationIssues`, also returned with a draft's issues
   and checked by the MCP tools before they publish), with one key per reason
   shared by both types: `regex.invalid`, `regex.invalid_flags`,
   `regex.unsupported`, `regex.too_complex`. The schemas and the cloze parser,
   which every read goes through, never compile: a version published under
   the old engine stays readable, served and graded; its refused matcher or
   blank never matches. A one-shot read-only command,
   `node dist/regex-audit.js`, lists those versions before the deploy, with
   the questions over the budget and the computed regex blanks.

## Consequences

- The request path is safe: one match costs at most 500 steps per input
  character, a few milliseconds at the D10 input limit, and no build or
  cache can exhaust the heap.
- A student's right answer to a matcher RE2 refuses is graded wrong until the
  teacher publishes a fixed version; an evaluation that froze the old version
  keeps it. The audit command is how the product owner finds them first.
- A rare legitimate pattern is refused as too complex (a CJK range under `i`,
  `.{0,300}`, eleven Unicode classes); the teacher drops the flag or narrows
  the repetition.
- The measured guard never changes a grade: a build that took over 50 ms
  (a stall of the process, a slower host, a cold start) still grades with
  the program it built. It only refuses that pattern at publication, until
  the entry is evicted or the process restarts; republishing later passes.
- The residual cost is the cold build: about 5–6 ms for the slowest pattern,
  25 ms for the costliest question, paid once per process and per pattern
  (after a restart, or when a question's patterns change), and a question's
  compiled patterns (at most 12.5 MB) fit the cache four times over, so
  grading one question never evicts its own.
- The browser never compiles a pattern (the parser and the schemas do not):
  re2js stays out of the web bundle, and the editor shows the server's
  issues.

## Alternatives considered

- **`re2-wasm`**: unmaintained since 2021, built for Node only, requires the
  `u` flag.
- **Native `re2`**: needs node-gyp or a prebuilt download at image build, a
  deployment risk with no toolchain in `node:24-slim`.
- **A worker pool with a hard timeout around `RegExp`**: keeps the backtracking
  engine and adds threads, termination and a verdict that depends on load.
- **Refusing in the schema**: what the first version did; every read parses
  with the schema, so an old version holding a refused pattern became
  unreadable, its students' pages and grading failing with it.
