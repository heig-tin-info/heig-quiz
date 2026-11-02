# ADR-123 — Logic circuit question type, graded by an in-process simulator

## Status

Accepted (2026-11-02, product owner Yves Chevallier, on issue #459; the
decisions of its two last comments).

Scope: the `logic` question type (a second type of `packages/qt-circuit`),
its simulator and expression parser `@quiz/domain/logic`, and the
component library that parameterizes the `circuit` canvas.

Relations: specified in [docs/spec/04 §4.18](../spec/04-types-de-questions.md#418-logic-circuit-logic);
applies [ADR-021 §1](ADR-021-codeimage-variante-de-code.md#1-a-variant-inside-packagesqt-code-not-a-package-of-its-own)
(a second type inside an existing package) and the pure-interpreter rule of
[ADR-103 §4](ADR-103-type-blocs.md#4-one-pure-interpreter-with-a-hard-budget);
takes [ADR-019](ADR-019-simulation-de-circuit.md) Decision 3 (the
server-side rebuild); meets the condition of
[ADR-046 §7](ADR-046-type-diagramme.md#7-circuit-is-left-as-it-is).

## Context

First-year digital systems ask students to design with gates: a majority
function, a comparator, a multiplexer in NAND only, then a counter. `circuit`
(ADR-019) is analogue: SPICE in the runner, a waveform within a tolerance. A
logic circuit has discrete values and a truth table small enough to try
whole (≤ 10 inputs, 1 024 rows). Karnaugh maps are out: tools do them today;
designing with gates still teaches something.

## Decision

The type's rules, payloads and scoring are in
[docs/spec/04 §4.18](../spec/04-types-de-questions.md#418-logic-circuit-logic).
This record keeps the decisions and their reasons.

### 1. A second type `logic` inside `packages/qt-circuit`

What `logic` shares with `circuit` is the canvas (grid, parts, orthogonal
wires, junctions from geometry, inspector, Expand, shortcuts); only the parts
and the judge differ — ADR-021 §1's case for a second type in one package.
The canvas is **parameterized by a component library**, extracted from what
`circuit` hard-codes today, not moved onto the diagram engine: ADR-046 §7
makes that move a separate change with its own ADR. The extraction keeps
`circuit` byte for byte: `router.golden.test.ts` is unchanged, and a change
to it is a failure, not an update. Own tile in "New question", right after
`circuit`.

### 2. Our own simulator, pure, bounded, in `@quiz/domain/logic`

Event-driven, values `0`/`1`/`X`/`Z`, a unit delay per gate (a NOR latch is
legal), and a per-row event cap past which every net still changing reads
`X`: an oscillation is `X`, never a hang. Engine and parser live in
`@quiz/domain/logic` (invariant 8, as ADR-103 put its interpreter in
`@quiz/domain/blocks`), and the same function runs in the browser's play mode
and in the API's grade.

**One `LOGIC_LIMITS` constant** in `@quiz/domain/logic` bounds everything:
inputs ≤ 10, outputs ≤ 8, components ≤ 60, wires ≤ 120, vertices per wire
≤ 64 (as `circuit`), events per row ≤ 2 000, and the length and nesting
depth of an expression. The answer and config schemas use it, and the domain
enforces it itself: it refuses an over-cap netlist, and the event cap is a
domain constant callers cannot pass. The rebuild is bounded by wires ×
vertices and the grade by 1 024 rows × the event cap; a test grades the
worst case — 10 inputs, 60 components, a circuit that oscillates on every
row so each row hits the cap — in under 500 ms.

### 3. A netlist IR modeled on Yosys JSON, rebuilt server-side

The stored answer is a schematic, as for `circuit`. The simulator reads an
internal netlist modeled on the Yosys JSON netlist (ports, typed cells, nets
as bit numbers) — a shape, not a contract. It is **rebuilt server-side from
the stored schematic every time and never stored** (invariant 14 by
analogy, ADR-019 Decision 3).

### 4. The teacher's specification: one expression per output

The grammar is §4.18's: precedence NOT > AND > XOR > OR, no juxtaposition
(`ab` is a name, so a missing operator never silently means AND), and every
identifier a declared input. The parse and the identifier check run in the
type's `configSchema`, as a refine through `@quiz/domain/logic`, so
publication, import and the MCP server refuse a bad expression as the editor
does (`logic.expression_invalid`, `logic.unknown_identifier`, with the
position); drafts follow the usual rule. No ADR-056 variables and no
don't-care rows in v1. The sequential phase uses Digital-style test vectors
(hneemann).

### 5. Inputs, outputs, symbols

Declared by the teacher, placed freely by the student, neither deletable nor
renamable. IEC 60617 by default, ANSI by the teacher's segmented control.
Buses and multi-bit signals are out of scope.

### 6. Grading

Each row from a fresh state, an `X` or `Z` output wrong, the score the share
of rows whose outputs are all right, each output's rate in the details. The
allowed gates and `maxGates` are editor limits, not criteria. An answer that
breaks them (`palette_violation`) or whose terminals differ from the
declared ones (`ports_mismatch`, new) gets 0, stored `proposed` as `circuit`
does: the editor cannot produce it, so it is stale (the teacher changed the
question) or forged, and a human decides. Malformed answers (a declared
terminal placed twice, an unknown kind, a wire to a missing pin) are
`ports_mismatch` or a schema refusal, never a simulated circuit; two outputs
driven together are net resolution (`X`), not a refusal.

### 7. What the student gets (invariant 4)

No expression in the student view. The play mode shows the student's own
outputs only, never a comparison, with no route (as ADR-103 §8). With 0/1
values a failing row's student output reveals the expected one, so **failing
rows reach the student only when the key may be shown**; otherwise the
details carry the score, the count of right rows and the per-output rates.
The leak tests are in §4.18.

### 8. Drill and polls

`logic` is not added to `DRILL_TYPES` nor made pollable in v1; to be decided.

## Consequences

- One package, one canvas, two types; a canvas fix reaches both.
- Grading is in-process, synchronous and final, bounded by `LOGIC_LIMITS`;
  it needs no runner capacity (ADR-101 does not apply).
- ADR-019's rejected alternative 2 (SPICE in the browser) does not apply: it
  rejected a second simulator that had to agree with ngspice to the last
  decimal, and a grade defended by the student's machine. Here one simulator
  runs on both sides, exact on discrete values, and the server always grades.
- `packages/core/src/reasons.ts` gains `ports_mismatch` in `MACHINE_REASONS`,
  with its `en` and `fr` strings.
- [docs/spec/06 Q29](../spec/06-questions-ouvertes.md) leans towards
  `circuit` staying the home of schematics: the canvas grows by libraries,
  not by moving into `diagram`.

## Alternatives considered

- **DigitalJS.** Four-valued, but bound to its JointJS editor and graph
  model: a second canvas and a second schematic representation.
- **Willow DLS.** Node only; the play mode needs the same code in the
  browser.
- **circuit-ts.** No `X` or `Z`: no honest answer for an undriven input, a
  conflict or an oscillation.
- **The runner.** It exists for untrusted code (invariants 10 to 14); a
  circuit is data and its cost is bounded.
- **A package `qt-logic`.** ADR-021's reason: a type package importing
  another, or a copied canvas.
- **Moving the canvas onto the diagram engine first.** ADR-046 §7's
  separate change; it risks `circuit`'s stored routes for no gain to `logic`.
