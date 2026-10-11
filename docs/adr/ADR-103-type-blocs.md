# ADR-103 — Blocks: a block-programming question type, a warehouse robot graded by a pure interpreter

## Status

Accepted (2026-10-11). The product owner settled grading (§2), the mandatory
reference (§3), keyboard and devices (§9) and the v1 scope (§10) on
2026-10-11 and approved the rest with the plan the same day.

Scope: the `blocks` question type (`packages/qt-blocks`), its interpreter
`@quiz/domain/blocks`, and the Blockly dependency of the web client.

Relations: specified in [docs/spec/04 §4.17](../spec/04-types-de-questions.md#417-blocks-blocks);
adds `blocks` to the "optimised for desktop" exception of
[docs/spec/00 §0.4](../spec/00-cadre-et-perimetre.md); extends the drill's
scope of [ADR-041 §3](ADR-041-entrainement-espace.md#3-the-types-of-v1);
applies [ADR-021 §1](ADR-021-codeimage-variante-de-code.md#1-a-variant-inside-packagesqt-code-not-a-package-of-its-own)
(one concept per type), the hidden-case redaction of
[ADR-096 §5](ADR-096-fichiers-annexes-publics.md) and the self-hosting rule
of [ADR-015 §4](ADR-015-execution-navigateur-correction-serveur.md).

## Context

Introductory programming courses start before any syntax: sequence, loops,
conditions, and the habit of writing a program that works on inputs it has
not seen. Block languages (Scratch, Blockly) are the usual vehicle. Teachers
of the first weeks have no Quiz question for it: `code` needs a language, a
compiler and a runner, and asks a beginner to type syntax before thinking in
steps.

A prototype (`blocks.html`, outside the repository) settled the exercise: a
warehouse robot must reach the loading dock without hitting a rack; the
program runs on SEVERAL warehouses, some hidden, so it must read its sensors
rather than count cells. Blockly draws the blocks. The prototype interpreted
Blockly's block tree directly and counted only the moves it emitted, so a
program of nested empty `repeat` blocks ran 40^d iterations for free.

## Decision

### 1. A new type, `blocks`, in its own package

`packages/qt-blocks` (`./server`, `./client`), registered in both registries,
shown as "Blocks" / « Blocs ». It is not a variant of `code`: ADR-021 made
`codeimage` a variant because it shares everything about the program
(language, template, runner, Monaco); `blocks` shares none of it. Its model
is `circuit`: a simulation, graded server-side, whose stimuli play the role of
cases. The config carries `world: { kind: "warehouse" }`, a discriminated
union with one member in v1, so a second world (a turtle, a sorting line)
later needs no new type id. The world fixes the block set.

### 2. Grading as `code` (product owner)

Each case has its points; the grade is the sum of the cases whose run reaches
the dock, or all or nothing with `allOrNothing` (config, default `false`).
The battery is PER CASE, since maps differ in size. A turn costs no battery,
a forward move costs one, a collision stops the run. Path length is never
rewarded: a correct program is not penalised for a longer route.

### 3. A reference solution is mandatory at publication (product owner)

A draft saves without it. Publication runs the reference on every case,
visible and hidden, and is refused when it is missing
(`blocks.reference_missing`) or fails a case (`blocks.reference_fails_case`,
naming the case). This catches an unsolvable map (a dock walled in, a
battery too small) before a student meets it. The reference grades nothing;
only the verdict "dock reached" counts.

### 4. One pure interpreter, with a hard budget

The interpreter lives in `packages/domain/src/blocks.ts`
(`@quiz/domain/blocks`): no `eval`, no `new Function`, no Blockly import. The
CSP has no `unsafe-eval`, and the server grades with the SAME function the
browser animates with, so what the student sees is what is graded.

EVERY node visit and EVERY loop iteration costs one step of a budget, not
only the emitted moves. The budget is a server constant derived from the
battery, never a teacher setting: `stepBudget(battery) = 50 × battery + 100`.
Exhausting it ends the run with `loop`. The answer schema caps the program:
at most 200 nodes, nesting depth at most 16, `repeat.times` in 1..40
(`PROGRAM_LIMITS`). The config schema caps `battery` at 200 (a 12 × 12 map
has 144 cells), so a run never takes more than 10 100 steps, whatever the
program, on the request path or in the grading worker.

The semantics, for one map and one battery: `forward` into a rack or off the
map ends with `collision` (the move is not counted; a collision is checked
before the battery); `forward` with no battery left ends with `battery`;
reaching the dock ends the run at once with `dock`; a program that ends
elsewhere ends with `short`. `if_sensor` tests the cell in front, to the
left or to the right of the robot: `free` is inside the map and not a rack,
`blocked` its negation. `repeat_until_dock` re-tests before each iteration.

### 5. The stored answer is our syntax tree, not Blockly's JSON

`{ program: Stmt[] }`, with English node kinds and no positions:

```ts
type Stmt =
  | { kind: "forward" }
  | { kind: "turn"; dir: "left" | "right" }
  | { kind: "repeat"; times: number; body: Stmt[] }
  | { kind: "repeat_until_dock"; body: Stmt[] }
  | { kind: "if_sensor"; sensor: "free" | "blocked"; where: "front" | "left" | "right"; then: Stmt[]; else: Stmt[] };
```

The client converts Blockly to and from it. The workspace holds ONE
undeletable, unmovable hat block, "when the robot starts"; only the stack
under it is the program. Detached stacks are disabled visually
(`Blockly.Events.disableOrphans`) and discarded on save; on reload the client
lays the stack out canonically under the hat. Reasons: F-GRADE-06 re-grades
old answers, a Blockly major may change its serialization, and the server
must not depend on where a student dropped a block.

### 6. Maps are ASCII rows

`.` floor, `#` rack, one of `^ > v <` the start cell and its heading, `D` the
dock. Width and height 3..12, rectangular, exactly one start and one dock;
`parseMap` refuses anything else with a message key (`blocks.map_*`).
Compact, diffable, writable through MCP. The teacher's editor shows a
clickable grid over the rows.

### 7. What the student gets (invariant 4)

`toStudent` publishes the prompt, the toolbox, the starter program, the
VISIBLE cases whole (name, map, battery, points) and, of the hidden cases,
only their count and total points. Never a hidden map, never the reference
(`referenceSolution`, a key of the common forbidden floor). `studentDetails`
gives a visible case its full result (verdict, reason, moves, trail); a
hidden case its verdict and a coarse reason (`collision`, `battery`, `loop`,
`short`) only — never the trace, the move count or the step index — its name
under `showHiddenCaseNames`, its map only under `showKey`, as ADR-096 §5 does
for `code`. The leak test searches the serialized student view for the rack
and dock coordinates of the hidden maps and for fragments of the reference.

### 8. The player runs everything in the browser, with no route

"Test on every warehouse" runs the visible cases in the browser through the
domain interpreter and fills the case table; the selected case is animated
from the interpreter's trace. No `interactiveRequest`, no `/run`, no
`onRun`: there is nothing secret to run and nothing to protect with a
cooldown. The grade is the server's (ADR-015 §2).

### 9. Keyboard and devices (product owner)

Keyboard navigation of the workspace is mandatory in v1. Blockly 13 ships it
in core (below), so no plugin is needed. `blocks` joins `code` and `diagram`
in the "optimised for desktop" exception of docs/spec/00 §0.4: it stays
usable on a tablet, but dragging blocks on a phone is not a target. Block
labels are UI strings and go through the canvas dictionary (`qt.blocks.c.*`,
`en` and `fr`, invariant 1); block kinds and ids are English.

### 10. The v1 scope (product owner)

All four options are in: (a) a "Code" tab showing the JavaScript Blockly
generates, for display only, never executed; (b) the teacher picks the
toolbox, `toolbox: BlockKind[]`, a non-empty subset of the five kinds,
default all; (c) a starter program, `starter: Stmt[]`, default empty,
preloaded in the student's workspace — `isAnswered` is true only when the
program is non-empty AND differs from the starter (`programEquals`); (d)
`blocks` enters the drill's `DRILL_TYPES` (ADR-041 §3): its grading is
synchronous, automatic and final.

### 11. Blockly is loaded lazily, and self-hosted

Blockly and its JavaScript generator live in ONE module,
`packages/qt-blocks/src/blocklyBundle.ts`, reached only by a dynamic
`import()` from the workspace host. The client entry point exports lazy
surfaces and nothing that transitively imports Blockly; `server.ts` never
imports it. Blockly's media (SVG, sounds) are copied from
`node_modules/blockly/media` into the web app's public directory at build
time, the `media` option points there, and sounds are off: nothing is fetched
from a third-party host (ADR-015 §4).

### 12. A fallback surface without Blockly

When Blockly is unavailable (jsdom, a chunk that failed to load) the surfaces
render a read-only pseudo-code view of the program with a message. Component
tests drive it (`blockly?: boolean`, like `monaco?: boolean` in `qt-code`).
It is not a student editing path.

### 13. The contract hooks

`shuffleable` is false; `summarizeAnswer` is "N blocks" (never a verdict);
`aggregate` is the pass rate of the visible cases, as `code`; `answerMisfit`
refuses a program that uses a kind the toolbox does not offer (`usedKinds`);
`searchText` and `assistText` read the prompt and the case names. No
generator (wand) in v1, and the type is not usable in a poll.

### The Blockly dependency

`blockly` 13.3.0 (Apache-2.0), pinned exactly, the current stable release
(2026-09-10). Its core ships keyboard navigation (checked in the 13.3.0
package: `KeyboardNavigationController`, the keyboard mover, the shortcuts
that focus and navigate the workspace and the flyout), so no plugin is
needed; `@blockly/keyboard-navigation`, last released as 3.0.5, declares a
peer of `blockly@^12.3.0` only. Its media (`node_modules/blockly/media`) are
in the package, which §11 needs. The bundle is about 1 MB, which is why §11
keeps it in its own chunk.

## Consequences

- Teachers get a first-weeks programming question that needs neither a
  runner nor a compiler, graded at once, usable in the drill.
- One interpreter decides both the animation and the grade; its budget makes
  every run bounded whatever the program, so grading needs no worker and no
  runner capacity (ADR-101 does not apply).
- The stored answer survives a Blockly upgrade; the conversion to and from
  Blockly is client code the type owns and tests.
- A second world is a new member of `world`, its block set and its
  interpreter rules; it needs no new type id and no migration of existing
  configs.
- Cost: a ≈1 MB dependency, lazily loaded; a canvas dictionary for block
  labels; a media copy step in the web build.

## Alternatives considered

- **A `language: "blocks"` variant of `code`.** Rejected: it would share no
  template, no runner, no editor and no grading path with `code`, only the
  word "program".
- **Generate JavaScript from the blocks and run it.** Rejected: the CSP has no
  `unsafe-eval`, the server would need a JavaScript sandbox, and the budget
  could not count loop iterations of generated code. The "Code" tab shows the
  generated JavaScript for reading only.
- **Store Blockly's serialization.** Rejected: positions and block ids are
  noise for grading, and a Blockly major may change the format under answers
  that must be re-gradable.
- **Count only the moves, as the prototype did.** Rejected: nested empty loops
  run exponentially long for free.
- **A teacher-set step budget.** Rejected: a budget is a server protection,
  not a pedagogical setting; deriving it from the battery keeps it generous
  for any program that could reach the dock.
- **Run the hidden cases in the browser too.** Rejected: the maps would reach
  the student.
- **The `@blockly/keyboard-navigation` plugin.** Not needed: Blockly 13 has
  keyboard navigation in core, and the plugin declares Blockly 12 only.
