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

The type's rules are in [docs/spec/04 §4.17](../spec/04-types-de-questions.md#417-blocks-blocks);
what a program means is the header of `packages/domain/src/blocks.ts`. This
record keeps the decisions and their reasons.

### 1. A new type, `blocks`, in its own package

`packages/qt-blocks`, registered in both registries. It is not a variant of
`code`: ADR-021 made `codeimage` a variant because it shares everything about
the program (language, template, runner, Monaco); `blocks` shares none of it.
Its model is `circuit`: a simulation graded server-side, whose stimuli play
the role of cases. The config carries `world: { kind: "warehouse" }`, a
discriminated union with one member, so a second world (a turtle, a sorting
line) later needs no new type id; the world fixes the block set.

### 2. Grading as `code` (product owner)

Points per case, summed over the cases whose run reaches the dock, or all or
nothing under `allOrNothing`. The battery is per case because maps differ in
size; a turn is free, a forward move costs one, a collision stops the run.
Path length is never rewarded: a correct program is not penalised for a
longer route.

### 3. A reference solution is mandatory at publication (product owner)

A draft saves without it; publication runs it on every case, visible and
hidden, and refuses a missing or failing reference. This catches an
unsolvable map (a dock walled in, a battery too small) before a student
meets it. The reference grades nothing.

### 4. One pure interpreter, with a hard budget

The interpreter lives in `@quiz/domain/blocks`, with no `eval`, no
`new Function` and no Blockly import: the CSP has no `unsafe-eval`, and the
server grades with the SAME function the browser animates with, so what the
student sees is what is graded.

EVERY node visit and EVERY loop iteration costs one step of a budget, not
only the emitted moves; the run ends with `loop` beyond `stepBudget`. The
budget derives from the battery and is never a teacher setting. The bound
lives in the domain itself: `stepBudget` and `simulate` clamp the battery to
0..`BATTERY_MAX` whatever the caller passes, so no config, however it got
stored, makes a run unbounded. The config schema refuses a battery above
`BATTERY_MAX` too, and every schema that accepts a program — the answer, the
starter, the reference — holds it to `PROGRAM_LIMITS`, measured first by the
iterative `programStats`: the rest of the interpreter recurses, and the
server runs the reference at publication.

### 5. The stored answer is our syntax tree, not Blockly's JSON

`{ program: Stmt[] }` with English node kinds and no positions; the client
converts Blockly to and from it. The workspace holds one undeletable hat
block, "when the robot starts"; only the stack under it is the program, and
detached stacks are discarded on save. Reasons: F-GRADE-06 re-grades old
answers, a Blockly major may change its serialization, and the server must
not depend on where a student dropped a block.

### 6. Maps are ASCII rows

`.` floor, `#` rack, `^ > v <` the start and its heading, `D` the dock,
bounded by `MAP_SIZE`. Compact, diffable, writable through MCP; the teacher's
editor shows a clickable grid over the rows.

### 7. What the student gets (invariant 4)

Visible cases whole, hidden cases as a count and a total of points; a hidden
case's result as its verdict and a coarse reason, never its trace — the
redaction ADR-096 §5 gives `code`, for the same reason: a trace on a hidden
map draws the map. The exact payloads and their leak tests are in the spec.

### 8. The player runs everything in the browser, with no route

"Test on every warehouse" runs the visible cases in the browser through the
domain interpreter and animates its trace. No `interactiveRequest`, no
`/run`: there is nothing secret to run and nothing to protect with a
cooldown. The grade is the server's (ADR-015 §2).

### 9. Keyboard and devices (product owner)

Keyboard navigation of the workspace is mandatory in v1; Blockly 13 has it in
core (below). `blocks` joins `code` and `diagram` in the "optimised for
desktop" exception of docs/spec/00 §0.4: dragging blocks on a phone is not a
target. Block labels are UI strings (invariant 1); block kinds are English.

### 10. The v1 scope (product owner)

All four options are in: a read-only "Code" tab showing the JavaScript
Blockly generates (never executed); a teacher-chosen toolbox; a starter
program, with `isAnswered` false while the program is still the starter; and
`blocks` in the drill's `DRILL_TYPES` (ADR-041 §3), since its grading is
synchronous, automatic and final.

*Note (PR 2, 2026-10-11).* `isAnswered` sees the answer and not the config,
so the stored answer carries the rule: the empty program `[]` means "the
starter as shown". The player stores a program equal to the starter as `[]`
and shows the starter for `[]` (`storedProgram` / `shownProgram`,
`packages/qt-blocks/src/schema.ts`). A client that sends the starter itself
is counted as answered and graded on it; we accept that, since only a
client that bypasses the player can do it and it gains nothing a student
could not get by editing one block.

### 11. Blockly is loaded lazily, and self-hosted

Blockly and its generator live in one module, `blocklyBundle.ts`, reached
only by a dynamic `import()`; nothing on the client entry point or the
server imports it. Its media are copied from `node_modules/blockly/media`
into the web app's public directory and sounds are off: nothing is fetched
from a third-party host (ADR-015 §4).

### 12. A fallback surface without Blockly

Without Blockly (jsdom, a chunk that failed to load) the surfaces show the
program as read-only pseudo-code. Component tests drive it, as `monaco?:
boolean` does in `qt-code`; it is not a student editing path.

### 13. The contract hooks

The hooks follow `code` where a hook exists for cases (`aggregate` on the
visible cases) and stay off otherwise: not shuffleable, not pollable, no
generator (wand) in v1. `answerMisfit` refuses a program that uses a kind the
toolbox does not offer, so the toolbox is a rule and not only a palette. The
spec's Answer and Dashboard paragraphs list them.

### The Blockly dependency

`blockly` 13.3.0 (Apache-2.0), pinned exactly, the current stable release
(2026-09-10). Its core ships keyboard navigation (checked in the 13.3.0
package: `KeyboardNavigationController`, the keyboard mover, the shortcuts
that focus and navigate the workspace and the flyout), so no plugin is
needed; `@blockly/keyboard-navigation`, last released as 3.0.5, declares a
peer of `blockly@^12.3.0` only. Its media are in the package, which §11
needs. The bundle is about 1 MB, which is why §11 keeps it in its own chunk.

## Consequences

- Teachers get a first-weeks programming question that needs neither a
  runner nor a compiler, graded at once, usable in the drill.
- One interpreter decides both the animation and the grade; its budget,
  enforced by the domain, bounds every run, so grading needs no worker and no
  runner capacity (ADR-101 does not apply).
- The stored answer survives a Blockly upgrade; the conversion to and from
  Blockly is client code the type owns and tests.
- A second world is a new member of `world`, its block set and its rules; no
  new type id, no migration.
- Cost: a ≈1 MB dependency, lazily loaded; a canvas dictionary for block
  labels; a media copy step in the web build.

## Alternatives considered

- **A `language: "blocks"` variant of `code`.** Rejected: it would share no
  template, no runner, no editor and no grading path with `code`.
- **Generate JavaScript from the blocks and run it.** Rejected: the CSP has no
  `unsafe-eval`, the server would need a JavaScript sandbox, and the budget
  could not count loop iterations of generated code.
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
