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
code point by code point, 35 ms a copy), and the memory a compiled program
keeps (a written-out `\pL` holds some 1 400 ranges).

## Decision

1. **Engine.** Patterns compile with RE2 through `re2js`, a pure JavaScript
   port pinned to one version: no native module, no install script, no
   toolchain in the image. The pattern syntax is RE2's: a backreference, a lookahead or
   lookbehind, a `\u` escape and other JavaScript-only syntax are refused.
   Flags `ims` map to RE2's inline flags, `u` is RE2's default; the full
   match stays `^(?:pattern)$`.
2. **Bounds, each checked before the next costs anything:** D10's limits; a
   static estimate read on the pattern's text (program size, at most twice
   the bound below, and at most 2 000 code points folded one by one); the
   compiled program at most 500 instructions; its weight in memory at most
   about 1 MB. Compiled patterns and refusals are cached, least recently used
   first out once the weights pass about 48 MB. The weight reads re2js's
   program (pinned version, shape asserted by a test).
3. **Where the refusal applies.** A pattern RE2 refuses is a publication
   issue (the types' `publicationIssues`, also returned with a draft's issues
   and checked by the MCP tools before they publish), with one key per reason
   shared by both types: `regex.invalid`, `regex.invalid_flags`,
   `regex.unsupported`, `regex.too_complex`. The schemas and the cloze parser,
   which every read goes through, never compile: a version published under
   the old engine stays readable, served and graded; its refused matcher or
   blank never matches. A one-shot read-only command,
   `node dist/regex-audit.js`, lists those versions before the deploy.

## Consequences

- The request path is safe: one match costs at most 500 steps per input
  character, a few milliseconds at the D10 input limit, and no build or
  cache can exhaust the heap.
- A student's right answer to a matcher RE2 refuses is graded wrong until the
  teacher publishes a fixed version; an evaluation that froze the old version
  keeps it. The audit command is how the product owner finds them first.
- A rare legitimate pattern is refused as too complex (a CJK range under `i`,
  `.{0,300}`); the teacher drops the flag or narrows the repetition.
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
