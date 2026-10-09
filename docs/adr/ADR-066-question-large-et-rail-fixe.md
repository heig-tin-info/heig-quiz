# ADR-066 — A wide question beside a pinned rail

## Status

Accepted (2026-10-02; asked by the product owner, the pinned rail agreed
with a colleague teaching the course, the threshold, the frame's cap, the
single question and the types left at 760 px settled by the product owner
in conversation). Implemented by `QuestionTypeClient.wide`
(`packages/core/src/client.ts`), set by `code` and `codeimage`
(`packages/qt-code`); the frame in `apps/web/src/student/PlayerShell.tsx`
and the split in `packages/qt-code/src/ProgramPlayer.tsx`
(`ProgramSplit`). Completes ADR-046 §6 and its addenda (Expand) and
ADR-021 (the program half `codeimage` shares with `code`).

Amended 2026-10-09: the Rollback section is removed (the runbook owns operational procedures).

## Context

The zen player kept every question in a 760 px column, and from 1024 px of
viewport its question list stood in a 12rem column left of it, the two
centered together as one 984 px block. A text question reads well in that
column. A code question does not: its statement, its editor, its tools and
its table of cases stack in 760 px, the statement scrolls away as the
student writes, and on a 1920 px screen half the width is canvas.

Two facts constrain the remedy. The list is how a student moves through
the paper: if the frame widened for a code question and narrowed for the
next one, the list would jump under the mouse at every move between them.
And a 12" Chromebook (about 1100 px at its default zoom), a tablet, a
half-screen window or a zoomed browser have no room for two columns; there
the stack must stay.

The contract already had an answer for "more room than the card":
`PlayerProps.Expand` (ADR-046 §6), a layer over the page. It suits a
canvas, which is the whole answer and wants the whole screen. It does not
suit a program, whose statement must stay in sight while it is written.

## Decision

1. **The rail is pinned, for every evaluation.** From 1024 px of viewport,
   with more than one question, the list stands at the left edge of the
   frame and never moves from one question to the next. The frame is the
   screen up to 1872 px (the rail, its gap, 1600 px of question and the
   gutters) and centered past it, so a 2560 px screen does not leave the
   list alone at one edge and "Hand in" at the other. The bar spans the
   frame; the title lines up with the list.
2. **A text question keeps its 760 px**, centered in the room right of the
   rail.
3. **A type states a need, not a layout: `QuestionTypeClient.wide`.** A
   type that sets it gets the whole room right of the rail, up to 1600 px;
   without a rail (one question, the teacher's question preview), the
   frame takes that width from 1024 px of viewport. Under 1024 px every
   question keeps the 760 px column, so the strip in the bar keeps one
   width. The host reads the flag; it never tests a type id.
4. **The player arranges itself by its own width.** `ProgramSplit` sets
   the statement (2fr) beside the editor and its tools (3fr) when the
   player is at least 60rem wide — a container query, never the viewport —
   and stacks them otherwise; what a run is judged against (the visible
   cases and the free try of `code`, the picture of `codeimage`) comes
   after, across the whole width. 60rem keeps the editor above 560 px and
   splits a 1366 px laptop (about 590 px of editor, under a classic
   scrollbar too) while a 1280 px screen stays stacked. One tree and one
   stylesheet: crossing the threshold moves the halves without remounting
   Monaco, whose undo history and cursor stay.
5. **`wide` for a statement beside a program, Expand for a canvas.** Only
   `code` and `codeimage` set `wide`. `circuit` and `diagram` keep their
   760 px card and their Expand layer; `categorize` and the others keep the
   reading column.

## Consequences

- Every evaluation's player changes on a wide screen: the rail moves from
  the centered block to the frame's edge, and a text question is centered
  in the room right of it (its content is 760 px wide there, 712 px in the
  narrow layout, as before).
- The container query reaches every host of the code player: the
  teacher's Try panel splits too when it has 60rem, an item preview sheet
  stacks. The grading panel draws the review, not the player, and is not
  concerned.
- The guide's screenshots of the player change.

## Alternatives considered

- **Widen the frame only for a code question.** Rejected: the rail moves
  under the mouse at every move between a code and a text question.
- **Keep the rail in place and grow the code question to the right only.**
  Rejected: an asymmetric page, and on a 1366 px laptop the room right of
  a centered rail is too narrow for two columns, where they help most.
- **Expand for code.** Rejected: the layer covers the page, and the
  statement with it.
- **Decide the split on the viewport.** Rejected: the Try panel, a sheet, a
  zoomed or half-screen window would split where the player has no room.
- **A 64rem threshold (editor ≥ 600 px).** Rejected after measuring: the
  card's padding and its flag leave the player 1016 px on a 1366 px screen,
  999 px under a classic scrollbar, and that laptop would never split.
