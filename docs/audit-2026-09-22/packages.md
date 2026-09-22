# Audit — shared packages of `/home/ycr/quiz`

Scope: `packages/contracts`, `packages/core`, `packages/domain`, `packages/registry`,
`packages/qt-mcq`, `packages/qt-short`, `packages/qt-cloze`, `packages/qt-code`,
`packages/qt-circuit`. `apps/api`, `apps/web` and `apps/runner` were read only to
establish who consumes what. **Nothing in the repository was modified.**

Constraining documents read: `CLAUDE.md` (invariants 1–14, decision D1, the planned
`canonical` / `ui` / `cli` packages), `docs/spec/04-types-de-questions.md`,
`docs/spec/05-architecture.md` §5.1–5.10 (§5.2 and §5.7 in detail),
`docs/adr/ADR-019-simulation-de-circuit.md`, `docs/adr/ADR-015`.
Metrics cross-checked against `scratchpad/cc.json`, `scratchpad/clones.md`,
`scratchpad/knip.md`, plus a full import-graph pass over every
`import … from "@quiz/…"` in `apps/**`, `packages/**`, `scripts/**`.

---

## 1. Overview

### 1.1 Size and complexity

Raw `wc -l`, `src/**` split on `*.test.*`:

| package | src files | src LOC | test files | test LOC | exported names¹ | fns | ΣCC | CC>10 | CC>20 | max CC |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `contracts` | 13 | 2 452 | **0** | **0** | 227 | 26 | 38 | 0 | 0 | 3 |
| `core` | 8 | 787 | 3 | 274 | 56 | 21 | 28 | 0 | 0 | 2 |
| `domain` | 14 | 1 842 | 14 | 1 471 | 109 | 123 | 390 | 5 | 0 | 17 |
| `registry` | 2 | 107 | 1 | 83 | 6 | 4 | 6 | 0 | 0 | 2 |
| `qt-mcq` | 13 | 1 987 | 5 | 1 243 | 77 | 108 | 242 | 3 | 0 | 18 |
| `qt-short` | 12 | 1 809 | 5 | 804 | 66 | 106 | 246 | 3 | 0 | 16 |
| `qt-cloze` | 13 | 1 247 | 5 | 694 | 56 | 82 | 181 | 0 | 0 | 8 |
| `qt-code` | 16 | 3 174 | 8 | 1 598 | 95 | 177 | 434 | 7 | 1 | 35 |
| `qt-circuit` | 25 | **9 113** | 18 | **3 970** | **305** | 560 | **1 610** | **26** | **11** | **65** |
| **total** | **116** | **22 518** | **59** | **10 137** | 997 | 1 207 | 3 175 | 44 | 12 | 65 |

¹ distinct `export const|function|class|interface|type|enum <Name>` in non-test sources.

Three numbers frame everything below:

- **`qt-circuit` is 40 % of package source and 51 % of package complexity** — ΣCC 1 610
  of 3 175; 26 of the 44 functions over CC 10; 11 of the 12 over CC 20.
- **`packages/contracts` has no test at all.** `packages/contracts/package.json:22` is
  `"test": "echo 'no tests yet'"`, and one of its six runtime helpers is the SSE
  authorization filter (P-09).
- **The public surfaces are 5–30× larger than what is consumed** (next table).

### 1.2 Surface vs consumption (exact, from the import graph)

| entry point | names exported | names imported from outside | unused exports | fully dead² |
|---|---:|---:|---:|---:|
| `@quiz/contracts` | 227 | 193 | 14 | 14 |
| `@quiz/core` (`.`) | — | **0** | the whole key | — |
| `@quiz/core/server` | ~40 | 26 | 8 | 2 |
| `@quiz/core/client` | ~20 | 15 | (in the 8) | — |
| `@quiz/core/rng` | 6 | 5 | 1 (`pick`) | — |
| `@quiz/domain` | 109 | 50 | 28 | 0 |
| `@quiz/domain/*` | (all files) | **0** | the whole map | — |
| `@quiz/registry/server` | 4 | 3 | 0 | — |
| `@quiz/registry/client` | 2 | 4³ | 0 | — |
| `@quiz/qt-mcq/server` | 23 | **1** (`mcqServer`) | 15 | 4 |
| `@quiz/qt-mcq/client` | 23 | 8 | | |
| `@quiz/qt-short/*` | 24 | 7 | 11 | 1 |
| `@quiz/qt-cloze/*` | 23 | 5 | 12 | 2 |
| `@quiz/qt-code/server` | 36 (2 × `export *`) | **4** | 19 | 2 |
| `@quiz/qt-code/client` | 51 | 16 | | |
| `@quiz/qt-circuit/server` | 96 (4 × `export *`) | **1** (`circuitServer`) | 34 | 6 |
| `@quiz/qt-circuit/client` | 46 | 19 (+5 dev-mock only) | | |
| `@quiz/qt-circuit/canvas` | **88** | **6** (one file: `apps/web/src/DevGallery.tsx:1`) | 16 | |

² never imported anywhere and not referenced inside its own file → safe deletion.
³ includes re-exports of `QUESTION_TYPE_IDS` / `QuestionTypeId`.

`packages/qt-circuit/src/canvas/index.ts` is 96 lines of pure re-export serving six
consumed symbols.

---

## 2. Findings, ranked by (estimated LOC × confidence) / risk

Each finding: **id · title · principle · evidence · behaviour-preserving refactoring ·
LOC delta · risk · covering tests · constraining invariant/spec/ADR**.

---

### P-01 — A `packages/ui` of question-type primitives would delete ~980 LOC across the five surfaces
**DRY.**

**Evidence** — verified by `diff`, not by eye:

```
$ diff <(head -86 packages/qt-code/src/styles.ts) <(head -86 packages/qt-circuit/src/styles.ts)
  → no output (byte-identical, doc comments included)
$ diff <(sed -n 284,287p packages/qt-code/src/strings.ts) \
       <(sed -n 427,430p packages/qt-circuit/src/strings.ts)
  → no output
$ diff <(sed -n 56,82p packages/qt-mcq/src/ui.tsx) <(sed -n 30,56p packages/qt-short/src/ui.tsx)
  → no output
```

Repeated shapes, each with a `path:line` pair in ≥2 packages:

| # | shape | pkgs | ~LOC |
|---|---|---|---|
| a | `styles.ts` token table (`cx`, `card`, `label`, `hint`, `button()`, `badge()`, `table`) — `qt-code/src/styles.ts:11-86` ≡ `qt-circuit/src/styles.ts:11-86`; `cx` also at `qt-mcq/src/ui.tsx`, `qt-short/src/ui.tsx`, `qt-cloze/src/ui.tsx`, `qt-circuit/src/canvas/canvasStyles.ts:15`, `apps/web/src/ui.tsx:53` | 5 (+2) | 240 |
| b | prompt field `RichText ? contenteditable : textarea` — **the same 6-line comment verbatim in all five**: `qt-code/src/Editor.tsx:195-219`, `qt-circuit/src/Editor.tsx:418-441`, `qt-mcq/src/Editor.tsx:271-298`, `qt-short/src/Editor.tsx:421-458`, `qt-cloze/src/Editor.tsx:55-98` | 5 | 138 |
| c | list-row editor (add / remove / `patchAt`): `qt-code/src/Editor.tsx:368-455` vs `qt-circuit/src/Editor.tsx:574-642` — `<li className="rounded-card border border-line bg-surface-2 p-3">` and the "hidden" checkbox are literal clones; `qt-short/src/Editor.tsx:580-588` repeats the remove button | 4 | 135 |
| d | `Segmented`: `qt-mcq/src/ui.tsx:191-257`, `qt-short/src/ui.tsx:71-120`, `qt-circuit/src/Editor.tsx:173-209` — same DOM (`role="radiogroup"` + `sr-only` radios), identical pill class string | 3 | 120 |
| e | `issuesAt` / `rootIssues` / `IssueList`: `qt-mcq/src/ui.tsx:56-82` ≡ `qt-short/src/ui.tsx:30-56` ≡ `qt-cloze/src/ui.tsx:26-52`, plus a private clone at `qt-circuit/src/Editor.tsx:100-122` | 4 | 104 |
| f | verdict-pill ternary ladder: `qt-mcq/src/Review.tsx:45-56`, `qt-short/src/Review.tsx:38-45`, `qt-cloze/src/Review.tsx:105-115`, `qt-code/src/Review.tsx:170`, `qt-circuit/src/Review.tsx:253-267` | 5 | 48 |
| g | teacher "try the reference" panel: `qt-code/src/Editor.tsx:330-356` ≡ `qt-circuit/src/Editor.tsx:792-809` (14 lines identical bar the handler name) | 2 | 44 |
| h | `NumberField` (`qt-circuit/src/Editor.tsx:211-254`) vs inline copies at `qt-code/src/Editor.tsx:420-434`, `qt-short/src/Editor.tsx:570-579` | 3 | 40 |
| i | `renderMarkdown ? renderMarkdown(p) : p` — `qt-code/src/Review.tsx:67-72` ≡ `qt-circuit/src/Review.tsx:122-127` **including the comment**; 8 call sites | 5 | 32 |
| j | field label + help row (`FieldCell`, `qt-short/src/ui.tsx:152-170`) inlined at `qt-code/src/Editor.tsx:194,236,399`, `qt-circuit/src/Editor.tsx:417,602` | 4 | 30 |
| k | `aside` settings portal — the tail `{aside ? null : X} … createPortal(X, aside)` at `qt-mcq/src/Editor.tsx:494-505` ≡ `qt-circuit/src/Editor.tsx:876-887` | 2 | 28 |
| l | score header `points / maxPoints`: `qt-mcq/src/Review.tsx:76-86`, `qt-short/src/Review.tsx:87-92`, `qt-cloze/src/Review.tsx:126-136`, `qt-code/src/Review.tsx:99-108`, `qt-circuit/src/Review.tsx:165-177` | 5 | 26 |
| m | `details` grading-marker guard, near-verbatim comment in `qt-code/src/Review.tsx:74-87` and `qt-circuit/src/Review.tsx:131-137` | 5 | 25 |
| n | `CheckboxField` (`qt-short/src/ui.tsx:127-150`) vs inline copies in code/circuit/cloze | 4 | 25 |
| o | `locked = readOnly \|\| disabled === true` — `qt-mcq/src/Player.tsx:32` ≡ `qt-short/src/Player.tsx:84` ≡ `qt-cloze/src/Player.tsx:46` | 3 | 15 |
| p | `withStrings` ≡ `withStrings` ≡ `resolveStrings` (see P-04) | 2 | 14 |

**Four live divergences the extraction closes — these are defects, not style:**

1. `qt-short/src/ui.tsx:18` and `qt-cloze/src/ui.tsx:18` hard-code `rounded-xl` where
   everyone else uses the `rounded-field` token. The comment at `qt-mcq/src/ui.tsx:17-22`
   warns a literal "would drift the day it changes" — it has.
2. An ungraded answer renders `—` in mcq/short/cloze and `0` in code/circuit
   (`points === null ? "—" : points` vs `s.score(points ?? 0, maxPoints)`).
3. `disabled` is honoured by the mcq/short/cloze players and **silently ignored** by the
   code and circuit players (`qt-code/src/Player.tsx:224`, `qt-circuit/src/Player.tsx:221`
   thread only `readOnly`).
4. `qt-code/src/Editor.tsx` renders **no `ConfigIssue` at all** (`grep -n Issue` → nothing)
   — the only one of the five.

**Refactoring.** Create `packages/ui` — already planned in `docs/spec/05-architecture.md`
§5.2 ("`ui/  design system: tokens, primitives, quiz components`") — exporting `cx`, the
token table, `Segmented`, `NumberField`, `FieldCell`, `CheckboxField`, `Verdict`,
`ScoreHeader`, `PromptField`, `RowList`, `AsideSection`, `TryPanel`.
Put `issuesAt` / `rootIssues` / `IssueList` in `packages/core/src/client.ts` instead,
beside the `ConfigIssue` type they act on (`client.ts:220-224`): they are contract-level,
not design-system-level, and that keeps `packages/ui` out of a leaf type's dependency on
`@quiz/core/client`.

**LOC delta.** −980 in the five qt packages, +~350 in `packages/ui`. Net **−630**; the
React surface goes from ~4 800 to ~3 800 LOC.

**Risk: medium** (visual). Mitigate: one primitive per commit, screenshots after each.

**Covering tests.** `qt-mcq/src/components.test.tsx`, `qt-short/src/components.test.tsx`,
`qt-cloze/src/components.test.tsx`, `qt-code/src/{Editor,Player,Review}.test.tsx`,
`qt-circuit/src/{Editor,Player,Review}.test.tsx`, `apps/web/src/questionTypes.test.tsx`,
plus `apps/web/scripts/screenshots.mjs` before/after.

**Constraint.** Invariant 2 and `apps/web/DESIGN.md` own the tokens; `packages/ui` must
not import `apps/web`. Invariant 1: every string still arrives through the `strings` prop.

---

### P-02 — `extractNets` is one 264-line function at CC 65; split it into seven phases and index the geometry
**CC.**

**Evidence.** `packages/qt-circuit/src/netlist.ts:234-497`. CC 65, 264 lines — the worst
function in the repository (runner-up: `GradingPanel`, CC 40). It **already** uses
union-find (`class Dsu`, `netlist.ts:163-194`), so the complexity is not a missing
algorithm; it is seven phases welded into one body, each with its own banner:

```
:239  // --- the nodes: one per component pin, one per port, one per wire
:277  // --- wire ↔ wire
:300  // --- pin ↔ wire, pin ↔ pin
:322  // --- the harness's own ties
:346  // --- the fixed names
:361  // --- group
:406  // --- diagnostics       (four independent loops: :412 / :456 / :480 / :490)
```

Two phases are gratuitously quadratic on what is pure point equality:

```ts
// netlist.ts:312-320 — O(P²)
for (let i = 0; i < pinNodes.length; i += 1) {
  for (let j = i + 1; j < pinNodes.length; j += 1) {
    if (samePoint(a.at, b.at)) dsu.union(a.key, b.key);
```
```ts
// netlist.ts:302-310 — O(W·P), same story
for (const wire of schematic.wires) {
  const ends = endsOf(wire);
  for (const node of pinNodes) { if (ends.some((e) => samePoint(e, node.at))) …
```

**Refactoring (behaviour-preserving).**

1. Build a `PointIndex` — `Map<"x,y", string[]>` — once from `pinNodes` and every wire
   end. Pin↔pin becomes "union each bucket", pin↔wire becomes a lookup: O(P + W) instead
   of O(P² + W·P), and two nested loops (CC 8) collapse to two `for…of` (CC 3).
   `wire ↔ wire` keeps `onPolyline` (a point-on-segment test, not equality) but only for
   wires whose bounding boxes overlap.
2. Extract, in order: `collectNodes(schematic)`, `unionGeometry(dsu, nodes, wires, index)`,
   `tieHarness(dsu, schematic, commonGround)`, `assignNames(dsu, railKeys, commonGround)`,
   `buildNets(dsu, nodes, wires, fixedName)`, and four `diagnose*` functions
   (`Components`, `Wires`, `Ports`, `Palette`). `extractNets` becomes ~35 lines of sequencing.
3. `switch (valueIssue(…))` at `:431-443` → a lookup
   `{missing:"missing_value", invalid:"invalid_value", range:"value_out_of_range"}`. CC 4 → 1.

Result: **max CC 65 → ~8**; longest function 264 → ~40.

**LOC delta.** +10 (the index). This is a complexity refactor, not a size one.

**Risk: low-medium.** The function is pure and precisely specified.

**Covering tests.** `packages/qt-circuit/src/netlist.test.ts` (330 lines), `spice.test.ts`,
`grade.test.ts`, `spice.int.test.ts`, `toStudent.test.ts`.

**Constraint.** Invariant 14 and ADR-019 §3 — the netlist is rebuilt server-side from
`wire.points` and nothing else. Keep the header comment of `netlist.ts:1-20` on the new
`unionGeometry`.

---

### P-03 — Every `qt-*` imports the `@quiz/domain` **barrel** while its own comment names the subpath
**ARCH / KISS.** Zero-risk, real bundle effect.

**Evidence.** `packages/domain/package.json:11-14` already publishes `"./*"`. It is
**never used**: all twelve occurrences of `@quiz/domain/<file>` in the repository are
inside doc comments, two lines above a barrel import.

```ts
// packages/qt-cloze/src/schema.ts:4   "… lives in `@quiz/domain/cloze` …"
// packages/qt-cloze/src/schema.ts:9
import { parseCloze } from "@quiz/domain";

// packages/qt-short/src/schema.ts:4   "… live in `@quiz/domain/short` …"
// packages/qt-short/src/schema.ts:17
import { ALLOWED_REGEX_FLAGS, isValidPattern, MAX_PATTERN_LENGTH } from "@quiz/domain";

// packages/qt-mcq/src/Stats.tsx:4     "… is `@quiz/domain/stats#mcqDistribution` …"
// packages/qt-mcq/src/Stats.tsx:9
import { mcqDistribution } from "@quiz/domain";
```

Same at `qt-code/src/segments.ts:10`, `qt-code/src/Player.tsx:19`,
`qt-cloze/src/text.tsx:15`, and the five `grade.ts`.
`packages/domain/src/index.ts:7-19` re-exports thirteen modules including `roster`
(224 LOC of CSV import), `pollTally` (135), `pseudonym`, `deadline`, `poolRole`, `stats`.
`qt-code/src/client.tsx:21` re-exports a **value** from `schema.js`, so the whole barrel
is a static edge out of the browser's initial chunk.

**Refactoring.** Rewrite twelve import lines to the subpath they already document.

**LOC delta.** 0 source; **≈ −1 200 LOC of unrelated domain code out of the initial
browser bundle**. It also shrinks `@quiz/domain`'s de-facto public surface (P-18).

**Risk: very low.** Caught by `pnpm build` / `pnpm typecheck`.

**Constraint.** Invariant 8 untouched; N-PERF-05 is the reason.

---

### P-04 — Three implementations of "merge string overrides", two of them byte-identical
**SSOT / DRY.**

```ts
// packages/core/src/client.ts:237-242
export function resolveStrings<K extends string>(
  defaults: Readonly<Record<K, string>>, overrides?: StringOverrides<K>,
): Readonly<Record<K, string>> {
  return overrides === undefined ? defaults : { ...defaults, ...overrides };
}
```
```ts
// packages/qt-code/src/strings.ts:284-287   AND   packages/qt-circuit/src/strings.ts:427-430
/** Merges a partial override on top of the English defaults. */
export function withStrings<T extends object>(defaults: T, override?: Partial<T>): T {
  return override === undefined ? defaults : { ...defaults, ...override };
}
```

`diff` of the two `withStrings` blocks: empty. Runtime behaviour of all three: identical.
The fork exists only because `resolveStrings` is constrained to `Record<K, string>` and
cannot carry the function-valued entries of code/circuit (`lockedRegions: (n) => string`,
`qt-code/src/strings.ts:227`; `score: (p, m) => string`, `qt-circuit/src/strings.ts:381`).
Both packages publish `withStrings` to the same host (`client.tsx:111` and `:135`).

**Refactoring.** Widen core to `resolveStrings<T extends object>(defaults: T,
overrides?: Partial<T>): T` — a strict superset; today's call sites still type-check.
Delete both `withStrings`.

**LOC delta.** −14, and one fewer public API. **Risk: very low.**

**Covering tests.** The five component suites + `apps/web/src/questionTypes.test.tsx`.

---

### P-05 — `apps/web/src/questionTypes.tsx` hand-rebuilds ~90 lines of parameterised strings, for two types only
**DRY / SSOT.**

**Evidence.** One generic translator exists at `apps/web/src/questionTypes.tsx:124-135`:

```ts
function translated<T extends object>(t: TFunction, defaults: T, prefix: string): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === "function") continue;          // ← the escape hatch
    out[key] = t(`${prefix}.${key}` as keyof Dict);
  }
  return out as T;
}
```

mcq / short / cloze therefore cost **one line each** (`:183`), while `code` and `circuit`
cost 6 + 5 (editor, `:186-201`), 8 + 22 (player, `:236-272`), 4 + 12 (review, `:281-300`),
plus `circuitCanvasStrings` (`:215-230`) and the `MCQ_HOST_MAPPED_KEYS` reflection hack
(`:169-173`). Every line is the same shape:

```ts
issueFloatingPin: (ref) => t("qt.circuit.p.issueFloatingPin", { ref }),
```

**Refactoring.** Make the function-valued defaults plain **templates** with named
placeholders (`"Floating pin {ref}"`), resolved by a three-line `fmt(tpl, params)` in
`@quiz/core/client` next to `resolveStrings`. `apps/web/src/i18n.tsx` already does
`t(key, { n })` interpolation, so **not a single `en`/`fr` entry changes** — only the
package-side English default and the call site inside the component. `translated()` then
covers all five types.

**LOC delta.** −90 in `apps/web/src/questionTypes.tsx`, +3 in core, ~30 lines changed (not
added) in the two `strings.ts`. `MCQ_HOST_MAPPED_KEYS` survives: it maps into a different
i18n namespace on purpose (`:137-142`).

**Risk: low-medium.** A missed placeholder shows as a literal `{ref}`, which the component
tests (which assert rendered sentences) catch.

**Constraint.** Invariant 1 / N-I18N-01 — `fr` stays `Record<keyof Dict, string>`; since no
key moves, the compile-time guarantee is untouched.

---

### P-06 — Five hand-maintained forbidden-key lists that disagree with each other and with the API's
**SSOT.** Security-adjacent.

| list | file | entries |
|---|---|---:|
| API (the real filter) | `apps/api/src/modules/live/studentView.ts:32-52` | 19 |
| mcq | `packages/qt-mcq/src/toStudent.test.ts:12-30` | 17 |
| short | `packages/qt-short/src/toStudent.test.ts:6-29` | 22 |
| cloze | `packages/qt-cloze/src/toStudent.test.ts:6-25` | 18 |
| code | `packages/qt-code/src/toStudent.test.ts:30-49` | 18 |
| circuit | `packages/qt-circuit/src/toStudent.test.ts:23-36` | 12 |

They diverge in both directions. The API forbids `referenceSolution`, `regex`, `solution`,
`hiddenCases`, `isCorrect`, `changeNote`, `deprecationNote`, `configVersion` — **no package
test checks the last five**. `qt-circuit`'s list omits `matchers`, `pattern`, `compare`,
`compileArgs`, `internalName`, `referenceSolution`, all of which the other four check.
`qt-mcq` forbids `value`, which no other list mentions.

Some keys must stay per type: `mode` is a member of `McqStudent`
(`qt-mcq/src/server.ts:116`) yet forbidden by circuit; `expected` is deliberately published
by `code`'s visible cases — `studentView.ts:27-30` says so explicitly.

**Refactoring.** Export `COMMON_FORBIDDEN_STUDENT_KEYS` from `@quiz/core/server`: the
fourteen every list agrees on (`answers, changeNote, compare, compileArgs, correct,
deprecationNote, difficulty, explanation, internalName, matchers, pattern, penalty,
referenceSolution, rubric, tags`). Then `studentView.ts:32` becomes
`[...COMMON_FORBIDDEN_STUDENT_KEYS, "answerKey", "configVersion", "hiddenCases",
"isCorrect", "matcher", "regex", "solution", "tolerance"]` and each test becomes
`[...COMMON_FORBIDDEN_STUDENT_KEYS, /* type extras */]`.

**LOC delta.** −55 net, and the five tests get **stronger**.

**Risk: low** — the lists only grow.

**Covering tests.** The five `toStudent.test.ts`,
`apps/api/src/modules/live/studentView.leak.test.ts`,
`apps/api/src/modules/poll/poll.db.test.ts:191`.

**Constraint.** Invariant 4 and §5.7 require **both** checks per type. The secret-value
halves (`SECRET_VALUES` in code and circuit, inline elsewhere) stay per type — that is the
part that cannot be shared.

---

### P-07 — `@quiz/qt-circuit/client` statically re-exports the grader, the netlist extractor and the SPICE emitter
**ARCH / YAGNI.**

**Evidence.** `packages/qt-circuit/src/client.tsx:91-103`:

```ts
/*
 * The PURE things a host may need … They are plain
 * functions, so they cost the bundle nothing and stay out of the lazy chunks.
 */
export { extractNets } from "./netlist.js";
export { parseSimulation } from "./grade.js";
export { COMPONENT_KINDS, LIBRARY, formatValue, parseValue, valueIssue } from "./library.js";
export { emptyCircuitConfig, emptyStimulus, EMPTY_SCHEMATIC } from "./schema.js";
```

The comment is wrong in exactly the way the same file warns about eleven lines later for
the components ("a static `export … from` would pull them back … undoing the `lazy`").
`client.tsx` is imported by `packages/registry/src/client.ts:9`, which
`apps/web/src/questionTypes.tsx:28` imports on **every page**. A static re-export of a
value therefore drags `netlist.ts` (511), `grade.ts` (549), `spice.ts` (470) and
`schema.ts` (410) — **≈1 940 LOC, the whole grading path** — into the initial chunk, for a
type most students never see.

The only outside consumer is the dev mock: `apps/web/src/mock/index.ts:72-73`, itself
behind `if (import.meta.env.VITE_MOCK === "1") await import("./mock")`
(`apps/web/src/main.tsx:21`). The lazy `Player` imports them **directly**
(`Player.tsx:24`, `:26`), so nothing in the app needs the re-export. `EMPTY_SCHEMATIC` is
imported nowhere — the mock declares its own copy at `apps/web/src/mock/index.ts:1156`.

**Refactoring.** Delete the four value re-export lines. Give the mock a
`@quiz/qt-circuit/testing` subpath, or let it reach them through the lazy `Player` path it
already exercises. Keep `LIBRARY` (used by `summarize`, `client.tsx:83`) and the type-only
exports.

**LOC delta.** −8 source; **≈ −1 940 LOC out of the initial browser chunk**, plus zod for
`schema.ts`. **Risk: low.**

**Covering tests.** `apps/web/src/questionTypes.test.tsx`,
`packages/qt-circuit/src/Player.test.tsx`, plus a `pnpm --filter @quiz/web build`
bundle-size comparison recorded in the PR.

**Constraint.** N-PERF-05 / §5.2 ("the code player does not weigh on a multiple-choice
quiz"). ADR-019 §3: the netlist is a server thing; publishing the extractor to the browser
is at best confusing about where the grade comes from.

---

### P-08 — `SchematicEditor` is 1 019 lines / CC 38, with three CC>20 callbacks inside it
**CC.**

**Evidence.** `packages/qt-circuit/src/canvas/SchematicEditor.tsx:247-1266`. 14 `useState`,
3 ref-mirrors, 4 `useEffect`, 20 `useCallback`. Worst callbacks: `:614` (CC 29, 89 lines,
`onPointerDown`), `:882` (CC 26, 51 lines, `onKeyDown`), `:722` (CC 21, 50 lines,
`onPointerMove`). The seams are already visible in the file's own ordering:

```
:264-301   refs and 14 pieces of state
:304-338   derived memos (kinds, displayed, routes, obstacles, connected, byId)
:339-485   commands: place, removeSelection, transformSelection, duplicate
:469-486   undo / redo   (on top of ./history.ts, which is already extracted)
:487-612   wire drafting: finishWire, wireClick, cancelStep, toWorld, slack, *Under
:613-812   pointer: down / move / up
:813-880   effects: measure, wheel-zoom, window pointer capture
:881-937   onKeyDown
:938-1266  render
```

**Refactoring (five hooks + two components).**

1. `useViewport(canvasRef, height)` → `{view, setView, toWorld, slack, zoom, fit}`
   (absorbs `:280`, `:553-572`, `:813-848`, `:987`) — ~130 LOC out.
2. `useSchematicCommands(schematic, apply, selection)` (`:339-468`) — ~130 LOC out.
3. `useWireDraft(...)` (`:487-551`, `:968-999`) — ~95 LOC out.
4. `usePointerTools(...)` (`:613-812`) — ~200 LOC out; each handler becomes a top-level
   function of the hook module and is directly testable.
5. `<Toolbar>` and `<PaletteRail>` (`:1000-1266`).

`SchematicEditor` ends at ~250 lines, CC ~10; no hook above CC 12.

**LOC delta.** ≈ 0 (moved, +40 plumbing). Buys reviewability and unlocks P-15.

**Risk: medium** — hook extraction from a stateful canvas is where render-order bugs hide.
One hook per PR, viewport first (most isolated).

**Covering tests.** `canvas/SchematicEditor.test.tsx` (436 lines), `geometry.test.ts`,
`router.test.ts`, `SchematicView.test.tsx`; `pnpm dev:mock` +
`apps/web/scripts/screenshots.mjs`.

**Constraint.** Invariant 2 and `.claude/skills/quiz-ui/SKILL.md` (look at the screen).
§4.11 requires drop-on-grid, rotate, mirror, orthogonal wiring — none may be lost.

---

### P-09 — `isStaffOnly`, the SSE authorization filter, lives in the one package with zero tests
**SSOT / ARCH.** Security.

```ts
// packages/contracts/src/realtime.ts:251-260
export const STAFF_ONLY_EVENTS = [
  "dashboard.cell", "dashboard.presence", "dashboard.attempt", "poll.tally",
] as const;

export function isStaffOnly(event: ServerEvent): boolean {
  return (STAFF_ONLY_EVENTS as readonly string[]).includes(event.type);
}
```
```ts
// apps/api/src/modules/realtime/routes.ts:319
if (!stream.staff && isStaffOnly(message.event)) return;
```

`ServerEvent` is a `z.discriminatedUnion` of twelve members (`realtime.ts:233-248`).
`STAFF_ONLY_EVENTS` is a hand-written string array with **no compile-time link to that
union**: a thirteenth staff-only event is a silent leak to every student stream, and
`packages/contracts/package.json:22` is `"test": "echo 'no tests yet'"`, so nothing notices.

**Refactoring.** Either (cheap) a `realtime.test.ts` that iterates `ServerEvent.options`,
reads each member's `type` literal and asserts it against an exhaustive
`Record<ServerEventName, boolean>` — a new member then fails to compile **and** fails the
test; or (better) carry the audience on the schema
(`const DashboardCellEvent = staffEvent(z.object({…}))`) so `isStaffOnly` reads a property.
Either way, give `packages/contracts` a real `test` script; it also covers `pageOf`,
`isDateFormat`, `defaultSettings`, `defaultGradingScale`, `defaultFeedbackPolicy`.

**LOC delta.** +60 (tests). Negative on LOC, first on risk reduction. **Risk: none.**

**Constraint.** Invariants 4 and 6 — this is the last filter before an event reaches a
student's `EventSource`.

---

### P-10 — Four definitions of the language list and two of the MCQ policy list, with one compile-time check between them
**SSOT.**

Languages:
```ts
// packages/core/src/runner.ts:17
export const RunnerLanguage = z.enum(["c","cpp","python","js","rust","spice"]);
```
```ts
// packages/qt-code/src/schema.ts:18-19
/** The languages of phase 1; the same list as `RunnerLanguage` in `@quiz/core`. */
export const CODE_LANGUAGES = ["c","cpp","python","js","rust"] as const;
```
The comment is false — it is `RunnerLanguage` **minus `spice`**, and nothing enforces even
that relation.
```ts
// packages/domain/src/lockedTemplate.ts:14
export type CodeLanguage = "c" | "cpp" | "python" | "js" | "rust";
```
A hand-written union in a *third* package — so `@quiz/domain` and `@quiz/qt-code/server`
both export a type called `CodeLanguage`.
A fourth table (language → Monaco id) at `packages/qt-code/src/MonacoHost.tsx:31-35`.
Only `apps/runner/src/languages.ts:28` is actually checked
(`Readonly<Record<RunnerLanguage, Spec>>`).

MCQ policy:
```
packages/domain/src/mcqScore.ts:62        "This module is the REFERENCE"   (hand union)
packages/contracts/src/evaluation.ts:60   McqPolicy = z.enum([...5 names])
packages/qt-mcq/src/schema.ts:41          McqPolicySchema = z.enum([...5 names])
packages/contracts/src/evaluation.ts:69   export const DEFAULT_MCQ_POLICY
packages/qt-mcq/src/schema.ts:69          export const MCQ_DEFAULT_POLICY   ← transposed name, same value
```

Contrast with the one place it is done right:
```ts
// apps/api/src/modules/pool/routes.ts:86
const _questionTypesAgree: readonly QuestionTypeId[] = QUESTION_TYPE_IDS;
```

**Refactoring.** (1) derive `CODE_LANGUAGES` from `RunnerLanguage.options`, or add the
`routes.ts:86`-style assertion in both directions; (2) rename
`domain`'s `CodeLanguage` → `TemplateLanguage` or alias `RunnerLanguage`; (3) add two
assertion lines for `McqPolicy` and delete one of `DEFAULT_MCQ_POLICY` /
`MCQ_DEFAULT_POLICY`.

**LOC delta.** −10 source, +6 assertions. Four typos become four compile errors — the same
posture as invariant 9's closed audit union. **Risk: very low.**

**Covering tests.** `pnpm typecheck`, `qt-code/src/grade.test.ts:84` (already iterates
`CODE_LANGUAGES`), `domain/src/lockedTemplate.test.ts`, `domain/src/mcqScore.test.ts`.

---

### P-11 — `apps/api` depends on four `qt-*` packages and hard-codes per-type knowledge in `results`
**ARCH.**

`apps/api/package.json:24-27` declares `@quiz/qt-code`, `@quiz/qt-cloze`, `@quiz/qt-mcq`,
`@quiz/qt-short`. Only one is ever imported:

```ts
// apps/api/src/modules/results/service.ts:38
import { CodeDetails } from "@quiz/qt-code/server";
// …:425
const parsed = CodeDetails.safeParse(row.details);
```

and the same file branches on type ids by hand:

```ts
// apps/api/src/modules/results/service.ts:385-405
export function distributionOf(type: string, payloads: readonly unknown[]) {
  if (type === "mcq"   && … "selected" in payload) { … }
  if (type === "cloze" && … "blanks"  in payload) { … }
```

`docs/spec/05` §5.3 says "the core only knows `type`, `config`, `payload`, `details`", and
§4.1 gives the type a `Stats` hook for exactly this. `QuestionTypeServer` has no
server-side aggregation member, so the knowledge leaked upward.

**Refactoring.** (1) Drop the three unused deps (`knip.md` flags the same three).
(2) Add `aggregate?(answers: TAnswer[], gradings: TDetails[]): AnswerDistributionEntry[]`
to `QuestionTypeServer`, implement it in the four types, and make `distributionOf` /
`casePassRateOf` call `questionType(type).aggregate?.(…)`. The last `@quiz/qt-code` edge
then goes too.

**LOC delta.** −60 in `results/service.ts`, +70 across four `server.ts` (where the payload
shape is typed rather than `"selected" in payload`-sniffed). Net ≈ +10, but it deletes four
dependency edges and two `if (type === …)` chains, and makes a fifth type's distribution a
package concern.

**Risk: low-medium.** **Covering tests.** `results.db.test.ts`, `feedback.db.test.ts`,
`scripts/smoke.sh`.

**Constraint.** §5.2 module table (`results` depends on `grading`, not on a question type)
and §5.3.

---

### P-12 — `emitDevices` is a 16-arm switch (CC 19) where the library already has a per-kind table
**CC / DRY.**

`packages/qt-circuit/src/spice.ts:236-327`. Five nearly identical arms:

```ts
case "NPN": case "PNP": {
  const model = MODEL_OF_KIND[component.kind];
  if (model !== undefined) { models.set(model.name, model.card);
    elements.push(`${name} ${at(0)} ${at(1)} ${at(2)} ${model.name}`); }
  break; }
case "NMOS": case "PMOS": case "NMOSD": case "PMOSD": {
  const model = MODEL_OF_KIND[component.kind];
  if (model !== undefined) { models.set(model.name, model.card);
    elements.push(`${name} ${at(0)} ${at(1)} ${at(2)} ${at(2)} ${model.name}`); }
  break; }
```

`MODEL_OF_KIND` is already a table; only pin arity and order differ.

**Refactoring.** One `const EMITTERS: Record<ComponentKind, Emitter | null>` local to
`spice.ts`, each entry a two-line arrow returning `{line, model?}`. `emitDevices` becomes a
~20-line loop, CC 4; a seventeenth kind becomes a table row. Keep the table in `spice.ts`,
**not** `library.ts` — `library.ts` is imported by the canvas and must not learn SPICE.

**LOC delta.** −15; CC 19 → 4. **Risk: low** — `spice.test.ts` (367 lines) asserts emitted
netlists line by line, `spice.int.test.ts` runs ngspice for real when Podman exists.

**Constraint.** ADR-019 §4: the op-amp's `E … TABLE` line and its 100 µV knee are load
bearing; that arm keeps its comment verbatim.

---

### P-13 — `astar` (CC 37, 85 lines) and `junctionPoints` (CC 25) in `canvas/router.ts`
**CC.**

`packages/qt-circuit/src/canvas/router.ts:122-206` holds the two-pass window loop, the flat
node encoding, the path reconstruction and the neighbour cost model in one function.

`junctionPoints` (`:336-385`) re-inlines, at `:367-379`, a bounding-box test the same file
exports as `onPolyline` (`:392-412`) — a 12-line literal duplicate:

```ts
// :371-376
x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0]) &&
y >= Math.min(a[1], b[1]) && y <= Math.max(a[1], b[1])
```

**Refactoring.** (1) `astar` → `searchWindow(bounds, start, goal, obstacles)` +
`reconstruct(parent, cur, W, x0, y0)` + `stepCost(d, nd, goal, need, bd, used)`; `astar`
becomes 20 lines of "tight window, then the whole box, then the L". CC 37 → ~12 / 6 / 8.
(2) `junctionPoints:367-379` → `onPolyline(points, x, y, 0)`. −12 LOC, CC 25 → ~14.

**LOC delta.** −12. **Risk: low** — `router.test.ts` (242 lines) covers routing and dots.

---

### P-14 — Three symbols defined twice inside `qt-circuit`, with different semantics
**SSOT.**

| name | definition A | definition B | difference |
|---|---|---|---|
| `pinPosition` | `netlist.ts:56` `(component, pin: PinSpec) → Point2` | `canvas/geometry.ts:106` `(component: Placement, index) → PinPoint \| null` | one takes the spec, one the index; one may return `null` |
| `portPosition` | `netlist.ts:65` → `Point2` | `canvas/geometry.ts:117` → `PinPoint` (carries a direction) | |
| `onPolyline` | `netlist.ts:149` — **collinearity** via cross product, inclusive | `canvas/router.ts:392` — **bounding box** with slack, exported at `canvas/index.ts:86` | for a non-orthogonal segment they disagree |

`netlist.ts:1-20` is explicit that its geometry is the one the grade depends on. Two
functions with the same name, one a laxer approximation, in the same package, is the setup
for a copy-paste that changes a grade.

**Refactoring.** Rename the canvas pair to `pinPointOf` / `portPointOf` (they return a
richer `PinPoint`), and `router.onPolyline` to `nearPolyline(points, x, y, slack)` — its
call sites are hit-testing, which is what "near" means. Keep `netlist.onPolyline` private
and exact.

**LOC delta.** 0 — pure de-ambiguation. **Risk: very low.**
**Covering tests.** `netlist.test.ts`, `geometry.test.ts`, `router.test.ts`.
**Constraint.** Invariant 14 / ADR-019 §3.

---

### P-15 — `CircuitEditor` (633 lines, CC 30) and `CodeEditor` (662 lines, CC 20) are the same editor twice
**CC + DRY.** Largely unlocked by P-01c/g/k.

`jscpd` finds four clone pairs between them alone (`scratchpad/clones.md`):
`qt-circuit/src/Editor.tsx:415`↔`qt-code/src/Editor.tsx:192` (18 lines), `:431`↔`:214` (14),
`:798`↔`:336` (12), plus `:435`↔`qt-mcq/src/Editor.tsx:282` (9) and
`:435`↔`qt-short/src/Editor.tsx:443` (9). Their structure is identical: prompt → settings →
a list of cases / stimuli → a "try the reference" panel → an `aside` portal.

**Refactoring.** After P-01 lands, both files are mostly a declaration of which fields
exist. Extract each remaining section as a local component (`<StimuliSection>`,
`<GradingSection>`, `<PaletteSection>` / `<CasesSection>`, `<LimitsSection>`), giving files
of ~250 lines with no function over CC 8.

**LOC delta.** −180 combined, on top of P-01. **Risk: medium.**
**Covering tests.** `qt-code/src/Editor.test.tsx`, `qt-circuit/src/Editor.test.tsx`,
`apps/web/src/question/QuestionEditor` screenshots.

---

### P-16 — `fromCanonical` is `Schema.parse(raw)` five times, and the whole canonical layer has no caller
**DRY / YAGNI.**

```ts
// packages/qt-mcq/src/canonical.ts:48-50
export function fromCanonical(raw: unknown): McqConfig { return McqConfigSchema.parse(raw); }
// packages/qt-cloze/src/canonical.ts:23-25   — identical modulo the schema name
```
…and the same in `qt-short`, `qt-code`, `qt-circuit`.

`grep -rn "toCanonical\|fromCanonical" apps/api/src apps/web/src` → **no hits**, and no
`yaml` dependency exists anywhere in the workspace. The layer (324 LOC of source + ~200 of
tests) waits on `packages/canonical`, which §5.2 and `docs/PLAN-MVP.md` §8 schedule next.

**Refactoring.** Do **not** delete it. But make `fromCanonical` default to
`configSchema.parse` in the contract (`packages/core/src/contract.ts:252`) and drop the five
one-liners. Keep `toCanonical` per type: "which fields a canonical file carries" is an
editorial decision per type (`qt-mcq/src/canonical.ts:5-7` says so), not mechanisable.

**What `packages/canonical` should absorb when it is written:** the YAML codec, the
`pool.yaml` layout, the `assets/` folder, the `id`-honouring import and the per-file error
report (§5.8) — **not** the per-type field mapping, which belongs where it is.

**LOC delta.** −25 now. The finding's real value is the reminder that 520 LOC is currently
unreachable and untested against a real round trip. **Risk: very low.**

---

### P-17 — `apps` resolve `@quiz/*` through `dist/`, with no source condition
**ARCH / KISS.**

`apps/web/vite.config.ts` declares no `resolve.alias`; `tsconfig.base.json` declares no
`paths`. Every `@quiz/*` import therefore resolves through the `exports` map to `dist/`
(`packages/core/package.json:6-25`), which `.gitignore:2` excludes. `CLAUDE.md` documents
the consequence (`pnpm build` before `pnpm dev`) but nothing enforces it: a stale `dist/`
silently serves old code to `pnpm dev`, to `pnpm test` in `apps/*`, and to `pnpm dev:mock`.

**Refactoring.** Add a `"development"` (or custom `"@quiz/source"`) condition to each
package's `exports`, pointing at `./src/<entry>.ts`; set `resolve.conditions` in
`apps/web/vite.config.ts` and `--conditions` on the API's `tsx` dev script. Production
builds keep resolving `default` → `dist/`.

**LOC delta.** +40 of config. Removes a whole class of "I edited the package and nothing
changed" and makes package edits hot-reload.

**Risk: low-medium** — a mis-set condition in the production build would ship TS. Guard it
with a CI assertion that the built app resolved `dist/`.

---

### P-18 — Dead, internal-only and test-only exports
**YAGNI.** Many small items; verified by a full import-graph pass (no `import * as ns` of
any `@quiz/*` package exists, so nothing can hide).

**18a — fully dead** (never imported, not referenced in its own file → safe deletion):

| name | site |
|---|---|
| the `"."` export key of `@quiz/core` | `packages/core/package.json:7-10` — duplicates `./server` byte for byte, no importer |
| the `"./*"` map of `@quiz/domain` | `packages/domain/package.json:11-14` — never used (P-03 would start using it) |
| `ServerRegistry`, `ClientRegistry` | `packages/core/src/registry.ts:25`, `:26` (the second is even re-exported at `client.ts:196`) |
| `selectClass`, `legendClass` | `qt-mcq/src/ui.tsx:32`, `:50` |
| `legendClass` | `qt-short/src/ui.tsx:24`, `qt-cloze/src/ui.tsx:24` |
| `choiceLetter` | `qt-cloze/src/ui.tsx:55` — **a copy of qt-mcq's** |
| `McqMode`, `McqDefaults` | `qt-mcq/src/schema.ts:26`, `:66` |
| `inputMd`, `textarea` | `qt-code/src/styles.ts:27`, `:29` |
| `inputMd`, `textarea`, `codeArea` | `qt-circuit/src/styles.ts:27`, `:29`, `:31` |
| `hoverRing` | `qt-circuit/src/canvas/canvasStyles.ts:136` |
| `IDENTITY`, `isComponentKind` | `qt-circuit/src/schema.ts:61`, `qt-circuit/src/library.ts:104` |
| `EMPTY_SCHEMATIC` | `qt-circuit/src/client.tsx:103` — the mock redeclares its own at `apps/web/src/mock/index.ts:1156` |
| `CircuitEditor` / `CircuitPlayer` / `CircuitReview` | named exports beside the defaults in `qt-circuit/src/{Editor,Player,Review}.tsx`; `lazy` takes the default |
| 14 contracts names | `ApiError`, `BoolFlag`, `ClassroomArchive`, `EnrollmentStatus`, `EventsQuery`, `JoinCodeState`, `NotificationKind`, `Role`, `isDateFormat`, and the five of P-21 |
| `noRunner` | `qt-mcq/src/fixtures.ts`, `qt-short/src/fixtures.ts`, `qt-cloze/src/fixtures.ts` |

**18b — uniform patterns worth one sweep each:**

- **18 `*Props` types exported and never imported**: `McqEditorProps`, `McqPlayerProps`,
  `McqReviewProps`, `McqStatsProps`, `ShortEditorProps`, `ShortPlayerProps`,
  `ShortReviewProps`, `ClozeEditorProps`, `ClozePlayerProps`, `ClozeReviewProps`,
  `ClozeTextProps`, `CodePlayerProps`, `CodeReviewProps`, `CodeAreaProps`,
  `CircuitPlayerProps`, `CircuitReviewProps`, `SchematicViewProps`, `ComponentGlyphProps`.
  Only `CodeEditorProps` and `CircuitEditorProps` are imported (by
  `apps/web/src/questionTypes.tsx`, to derive `TryOutcome`).
- **3 `*Client` alias types never imported**: `McqClient` (`qt-mcq/src/client.tsx:13`),
  `ShortClient` (`qt-short/src/client.tsx:17`), `ClozeClient` (`qt-cloze/src/client.tsx:17`).
- **`export *` over-exposure**: `qt-circuit/src/server.ts:166-169` (4 × `export *`) exposes
  96 names, of which **1** is imported; `qt-code/src/server.ts:162-163` exposes 36, of which
  4 are. Replace with explicit named re-exports.
- **`@quiz/domain`**: 28 types/constants are public but referenced only inside their own
  module (`PollTallyInput`, `RosterRow`, `ClozeParse`, `TemplateSegment`, `McqScore`, …),
  and 22 more are exported solely for the package's own unit tests (`matchShort`,
  `compileFullMatch`, `parseDateInput`, `pseudonym`, …). Note `matchShort`
  (`domain/src/short.ts:265`) — the headline "short answer matcher" — is called only from
  `short.test.ts`; `qt-short` calls the finer-grained `matchExact`/`matchRegex`/`matchNumber`.
- **`@quiz/qt-circuit/canvas`**: 88 exports, 6 consumed, 53 internal-only, 11 test-only,
  16 unused (`markUsed`, `Obstacles`, `Rect`, `ScreenRect`, `History`, `SymbolSpec`,
  `ORIENT_180`, `ORIENT_270`, the four `ORIENT_MIRROR_*`, …). Reduce it to the six
  `DevGallery.tsx` needs, or delete the entry point and let `DevGallery` import
  `@quiz/qt-circuit/client` plus one deep path.
- **`core/src/llm.ts` (28 LOC)** has no production consumer: `LlmGradeOutcome` is dead,
  `LlmGradeRequest` / `LlmService` are referenced only by `contract.ts`. Keep it (the
  `pending: "llm"` branch is produced by `qt-circuit/src/grade.ts:357`), but it is the
  smallest phase-2 surface in the repo and should not grow.
- **`randomize?`** (`packages/core/src/contract.ts:211`) is declared, implemented by no
  type and called by nobody (§4.3 = phase 2). `pick` (`core/src/rng.ts:53`) is test-only.
  `seededShuffle` (`core/src/rng.ts:50`) is an alias of `shuffle`; **both** are exported and
  both are used, in different packages — pick one name.
- **`isQuestionTypeId`** (`core/src/contract.ts:31`) is used only inside `core`, yet
  re-exported at `client.ts:193`.

**18c — unused dependencies.** Every `dependencies` entry of every package **is** used.
Specifically cleared: `@dnd-kit/*` (`qt-mcq/src/Editor.tsx:30-38`), `@monaco-editor/react`
(dynamic, `qt-code/src/MonacoHost.tsx:41` — a naive grep reports it unused), `@quiz/domain`
in all five, `@quiz/core` in `domain`, `react-dom` in `qt-mcq` (`createPortal`).
Two real ones remain:

- `packages/registry/package.json`: `react` and `zod` as `peerDependencies` — **neither is
  imported anywhere in `packages/registry/src`**;
- `apps/api/package.json:25-27`: `@quiz/qt-cloze`, `@quiz/qt-mcq`, `@quiz/qt-short` (P-11).

`knip.md`'s claim that `qt-circuit` does not use `@testing-library/*` and `jsdom` is a
**false positive**: `packages/qt-circuit/vitest.config.ts:9-11` sets `environment: "jsdom"`
and `setupFiles`, and `Editor.test.tsx:10` imports `@testing-library/react`.

**18d — no dead files.** Every non-test source file under `packages/*/src` is reachable.
One inconsistency: `qt-mcq`, `qt-short` and `qt-cloze` put `fixtures.ts` and `test-setup.ts`
at `src/` root and name them one by one in `tsconfig.json`'s `exclude`
(`packages/qt-mcq/tsconfig.json:15-20`), while `qt-code` and `qt-circuit` use `src/test/`
and exclude the directory. Align on `src/test/`.

**LOC delta.** −220 of exports and their doc comments; −4 lines of `apps/api/package.json`;
−2 of `packages/registry/package.json`.
**Risk: very low** — a deleted export that was in fact used is a compile error.

---

### P-19 — Five HTTP response schemas declared in `contracts` that `apps/api` never validates against
**SSOT / YAGNI.**

| schema | declaration | route |
|---|---|---|
| `SubmitResponse` | `packages/contracts/src/live.ts:175`, `:180` | `POST …/submit` |
| `RunAccepted` | `packages/contracts/src/live.ts:206`, `:207` | `POST …/run` |
| `ExtendResponse` | `packages/contracts/src/live.ts:360`, `:364` | `POST …/extend` |
| `ResetAttemptResponse` | `packages/contracts/src/live.ts:342`, `:343` | `POST …/reset-attempt` |
| `GradingRunAccepted` | `packages/contracts/src/grading.ts:140`, `:145` | `POST …/grading/run` |

None is imported anywhere. Invariant 7 says "Every HTTP input is validated by a schema from
`packages/contracts`, **and the client uses the same schema**" — these five are the response
half, written and then not wired, so a route change breaks neither side at compile time.

**Refactoring.** Either wire them (typed `reply.send` on the API side and a
`Schema.parse(await res.json())` on the web side) or delete them. Wiring is the better
answer and costs ten lines; leaving them is the one option that buys nothing.

**LOC delta.** −21 if deleted, +10 if wired. **Risk: very low.**
**Covering tests.** `scripts/smoke.sh` walks all five routes.

---

### P-20 — `parseBlankBody` (CC 17) and `canonicalMatcher` (CC 16)
**CC.**

`packages/domain/src/cloze.ts:160-212` is a four-way dispatcher (weight prefix, `#number`,
`/regex/`, `=select` | text) with all four bodies inline.
`packages/qt-short/src/canonical.ts:28` is the mirror image on the matcher side.

**Refactoring.** `parseBlankBody` → `stripWeight(body) → {weight, rest}` +
`parseNumberBlank` + `parseRegexBlank` + `parseSelectOrText`; the dispatcher becomes 7
lines, CC 5, each helper CC 4-6. Same shape for `canonicalMatcher`.

**LOC delta.** +8 (four signatures). CC 17 → 5, 16 → 5. **Risk: very low.**

**Constraint.** §4.6: "It reads the existing body and rewrites it with the domain functions
(`parseBlankBody` / `formatBlank`), never by concatenation" —
`apps/web/src/markdown/BlankPopover.tsx` depends on this staying one exported entry point.
**Keep the signature.**

---

### P-21 — `CodePlayer`: two 25-line run functions that differ by one field
**DRY / CC.**

`packages/qt-code/src/Player.tsx:142-178` — `runVisibleCases` and `runManual` share the same
`setState(running) / await onRun / setState(done|failed)` body; `runManual` adds a
`manual: {args, stdin}` option and writes a different slot. Component CC: 35, the highest
outside `qt-circuit`.

**Refactoring.** `function useRunSlot(onRun)` returning `[state, run(options)]`, called
twice. The verdict helper above it (`Player.tsx:88-111`, the exit-code / stdout ladder)
moves out as a pure `verdictOf(visibleCase, result, s)` — nearly free-standing already, and
directly unit-testable afterwards.

**LOC delta.** −30. CC 35 → ~14 plus two helpers under 8. **Risk: low.**
**Covering tests.** `qt-code/src/Player.test.tsx`.
**Constraint.** ADR-015 — "the browser runs, the server grades"; the extracted hook must not
acquire any grading meaning.

---

## 3. Sequenced plan

Each phase is independently mergeable and leaves `pnpm build && pnpm typecheck && pnpm test`
green. `AGENTS.md` applies: one worktree per phase, `main` by merge only.

**Phase 0 — guards and sweeps (½ day, no behaviour change).**
P-09 (contracts test script + `isStaffOnly` exhaustiveness), P-10 (three `_xAgree`
assertions), P-18a/b/c (delete the dead exports, the three `apps/api` deps, the two
`registry` peerDeps; align the fixtures layout), P-19 (wire or delete the five response
schemas). Additive or a compile error — green by construction.

**Phase 1 — resolution and bundling (½ day).**
P-03 (twelve subpath imports), P-07 (four re-export lines out of `qt-circuit/client.tsx`),
P-17 (source condition). Record the `pnpm --filter @quiz/web build` delta in the PR.

**Phase 2 — the server halves (1 day).**
P-06 (`COMMON_FORBIDDEN_STUDENT_KEYS`), P-16 (`fromCanonical` default in the contract),
P-04 (widen `resolveStrings`, delete both `withStrings`). Invariant 4 is strengthened, never
relaxed: the per-type `SECRET_VALUES` searches stay exactly as they are.

**Phase 3 — `packages/ui` (3–4 days, one primitive per commit).**
P-01 in this order: tokens (a) → `Verdict` + `ScoreHeader` (f, l) → `issuesAt`/`IssueList`
into `@quiz/core/client` (e) → `PromptField` (b) →
`Segmented`/`NumberField`/`FieldCell`/`CheckboxField` (d, h, j, n) →
`AsideSection` + `TryPanel` (k, g) → `RowList` (c). Fix the four divergences as their own
commits so they are visible in the history. Screenshot check after each.

**Phase 4 — the host (½ day).** P-05 (`fmt` templates; `questionTypes.tsx` −90).

**Phase 5 — `qt-circuit` complexity (3–4 days).**
P-02 (`extractNets`) → P-12 (`EMITTERS`) → P-13 (`astar`, `junctionPoints`) → P-14
(renames) → P-08 (`SchematicEditor`, one hook per PR, viewport first) → P-15 (both Editors).

**Phase 6 — small CC (½ day).** P-20, P-21.

**Phase 7 — boundaries (1–2 days, alongside `packages/canonical`).**
P-11 (`aggregate` hook; drop the last `apps/api` → `qt-code` edge).

---

## 4. Keep as is

- **`packages/core` split into `./server` and `./client`.** It is the mechanism of decision
  D1 and of "the API never loads React": `client.ts:8` imports React as types only and
  `verbatimModuleSyntax` erases them. Only the redundant `"."` key goes (P-18a). The name
  `/server` meaning "React-free" is documented at `core/src/index.ts:1-6`; renaming it would
  churn 30 files for nothing.
- **Two registry files.** `packages/registry/src/{server,client}.ts` are 107 LOC total and
  are exactly the two static maps D1 requires. There is no third file to find, and merging
  them would put React into the API's module graph. This is the minimum.
- **`makeLookup` / `defineServerRegistry` / `defineClientRegistry`.** Nine lines buying a
  total lookup (`UnknownQuestionType` rather than `undefined`) and a definition-site type
  check. Cheap and load-bearing.
- **`registerForTests`** (`registry/src/server.ts:57-69`). A test hook in production code is
  a smell, but it is `NODE_ENV=production`-guarded, documented, and the alternative is an
  `apps/api` test that depends on a `qt-*` package another work package owns.
- **The seeded RNG API** (`core/src/rng.ts`, 67 LOC). No dependency, bit-identical on Node
  and in the browser, one derivation (`streamSeed(attemptSeed, itemId, purpose)`) used
  everywhere. Only `pick` and the `seededShuffle` alias are surplus (P-18b).
- **`RunnerRequest` / `RunnerOutcome` / `RunnerService`** (`core/src/runner.ts`, 78 LOC).
  Not over-general: `spice` rides the same shape as the five languages (ADR-019 §5); the
  `files` / `cases` / `limits` caps are what invariants 10–12 need; one interface, two
  methods.
- **`StudentDetailsPolicy`** (`core/src/contract.ts:121-126`) as a structural subset of
  `contracts.FeedbackPolicy`. Duplicating two booleans is the price of `core` not importing
  `contracts`, and `:114-119` says so. *(Optional 1-liner: a
  `const _: StudentDetailsPolicy = {} as FeedbackPolicy` assertion in `apps/api` makes a
  rename a compile error.)*
- **`packages/domain`.** No `Date.now()`, no `Math.random()`, no `fetch`, no `node:` import
  anywhere in `src` (verified by grep); 14 modules, 14 test files. Invariant 8 is respected.
  `mcqScore.ts`'s 60-line policy essay is documentation that belongs next to the formulas.
- **`qt-circuit` staying in this repository.** ADR-019 is accepted and §4.11 specifies the
  type down to `sourceOhms` and `skipMs`; `schema.ts` implements exactly that list and
  nothing more (checked field by field against §4.11). The 9 100 LOC are the canvas (§4.11
  requires drop-on-grid, rotate, mirror, orthogonal wiring and geometry-read junctions) and
  the SPICE path (ADR-019 §1–§5), not gold plating. **The one honest question is zoom and
  pan** on a fixed-size box: `geometry.ts:340-457` (118 LOC), the wheel handler and pan drag
  at `SchematicEditor.tsx:741-745,842`, the fit button at `:1060`, the zoom readout at
  `:987` — ~180 LOC plus tests. `SchematicView` (the read-only surface used in Review and
  the student view) uses `FIT_VIEW` alone. Worth asking the owner; not worth recommending
  blind.
- **The per-type `toStudent.test.ts` files.** Invariant 4 and §5.7 require them, and the two
  halves (key blacklist + secret-value search) are the check that matters. P-06 shares the
  blacklist's floor; nothing else moves.
- **`toCanonical` per type.** Per-type editorial decisions (§4.2), currently unreachable but
  scheduled with `packages/canonical`.
- **No `onChange` debouncing in any player.** Confirmed absent in all five; autosave lives
  in `apps/web/src/attempt/autosave.ts`. Do not "extract" a hook that does not exist.

---

## 5. Summary

### By package

| package | current src LOC | est. removed | est. added | net | main items |
|---|---:|---:|---:|---:|---|
| `qt-circuit` | 9 113 | 450 | 100 | **−350** | P-01, P-07, P-12, P-13, P-15, P-18 |
| `qt-code` | 3 174 | 350 | 20 | **−330** | P-01, P-04, P-15, P-18, P-21 |
| `qt-mcq` | 1 987 | 235 | 10 | **−225** | P-01, P-18 |
| `qt-short` | 1 809 | 185 | 10 | **−175** | P-01, P-18, P-20 |
| `qt-cloze` | 1 247 | 165 | 10 | **−155** | P-01, P-18 |
| `core` | 787 | 35 | 65 | **+30** | P-01e, P-04, P-05, P-06, P-16, P-18 |
| `domain` | 1 842 | 30 | 10 | **−20** | P-10, P-18b, P-20 |
| `contracts` | 2 452 | 30 | 70 | **+40** | P-09, P-10, P-19 |
| `registry` | 107 | 2 | 0 | **−2** | P-18c |
| **`packages/ui` (new)** | 0 | — | 350 | **+350** | P-01 |
| `apps/web` | — | 100 | 40 | **−60** | P-05, P-17 |
| `apps/api` | — | 60 | 70 | **+10** | P-11 |
| **total** | **22 518** | **1 642** | **755** | **−887** | |

Plus **≈3 140 LOC removed from the browser's initial chunk** without deleting a line
(P-03 ≈1 200, P-07 ≈1 940).

### By principle

| principle | findings | net LOC | note |
|---|---|---:|---|
| DRY | P-01, P-04, P-05, P-12, P-15, P-16, P-21 | −950 | the five React surfaces are ~21 % duplicate |
| YAGNI | P-07, P-16, P-18, P-19 | −250 | plus 6 dependency edges and 2 entry points |
| ARCH | P-03, P-07, P-11, P-17 | +10 | bundle and boundaries, not size |
| SSOT | P-06, P-09, P-10, P-14, P-19 | +5 | four duplicated lists, one of them a security filter |
| CC | P-02, P-08, P-13, P-20, P-21 | +10 | max CC 65 → ~14; CC>20 count 12 → ~2 |
| KISS | P-17, P-18 (`"."` key, `seededShuffle`, `pick`, `export *`) | −30 | |

### Complexity, before and after

| metric | now | after | driver |
|---|---:|---:|---|
| max CC in `packages/` | 65 | ~14 | P-02, P-08, P-13 |
| functions CC > 20 | 12 | ~2 | P-02, P-08, P-12, P-13, P-21 |
| functions CC > 10 | 44 | ~20 | all of the above |
| longest function | 1 019 | ~300 | P-08 |
| `qt-circuit` share of package ΣCC | 51 % | ~35 % | P-02, P-08, P-12, P-13 |
| public names vs consumed | 997 / ~330 | ~700 / ~330 | P-18 |
