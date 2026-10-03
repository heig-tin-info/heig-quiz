# ADR-046 — Diagram: one editor engine, one question type, eight notations

## Status

Accepted (2026-09-30), with the two addenda below. Proposed 2026-09-29.
Decided with the product owner: v1 graded by hand,
all eight kinds in v1, the text form shown to the teacher only, `diagram`
replaces the drawing type of docs/spec/04 §4.10, and a starter diagram may
be given to the student. Open: whether a drawing-only schematic is a kind of
`diagram` (docs/spec/06 Q29). No migration.

Amended by [ADR-063](ADR-063-correction-llm.md) §5: diagrams can receive LLM grading proposals
through their text form. The manual-only v1 scope of §5 below is historical;
the diagram engine and student editing decisions remain in force.

## Context

Teachers of software engineering, databases, digital systems and
algorithmics ask students to DRAW: a class diagram from a statement, the
state machine of a controller, the entity-relationship model of a small
shop, the flowchart of a loop, the automaton of a language, a weighted
graph to run Dijkstra on. Today this happens on paper or in a free tool,
outside the evaluation.

The specification planned a `drawing` type for phase 3 (docs/spec/04 §4.10):
an embedded Excalidraw, graded by LLM vision on a PNG. A free-form canvas
does not know what a class, a transition or a cardinality is, so neither the
student's tools nor any later automatic help can use the notation.

The schematic editor of `circuit` (ADR-019) showed what a structured canvas
on a grid of 20 feels like: an orthogonal A* router, rubber-band selection,
undo, zoom and pan. A standalone mockup (`mockups/uml.html`) reused that
logic for seven notations, each with a text form edited in a second tab and
parsed back (PlantUML, Mermaid, Graphviz DOT). The mockup is the origin of
this type; its behaviour is described in docs/spec/04 §4.14.

## Decision

### 1. An engine package and a type package

- **`packages/diagram`** (`@quiz/diagram`) is the engine:
  - `./server`, with no React: the scene model and its zod schemas, the
    catalogue of kinds (elements, links, line mode, text form), the router
    and the anchoring, the straight-line layout, and the text serialisers
    and parsers, all pure and unit-tested;
  - `./client`: `DiagramEditor` and `DiagramView`.

  It depends on `@quiz/core` and `@quiz/ui` (the class-list helper, and the
  undo hook of a controlled editor, which moved there from the circuit
  canvas so the two editors share it), takes its strings through `strings`
  props filled by the host in `en` and `fr` (the rule of `qt-circuit`), and
  never imports a `qt-*` package.
- **`packages/qt-diagram`** is the question type, registered in both
  registries, like every type since ADR-036.

The engine is a package of its own because a `qt-*` package may not import
another one (decision D1 of the registry), `@quiz/ui` holds small
primitives only (ADR-029), and a second type is expected to use it (§7).

### 2. The scene is the record, the text is a view

The stored answer and the stored reference are SCENES: elements with a
position on the grid and their content, links with their ends, elbows, name
and end labels. The text form is produced from a scene by the kind's
serialiser, on demand.

- **The server never parses a text written in a browser.** The parsers are
  pure and live in the package, but `@quiz/diagram/server` exports the
  serialisers only: an entry that offers no parser cannot be used to run
  one on student text. The editor reads text through its own modules. The
  server runs the serialisers (for the teacher's review, and later for
  grading). What reaches the server is a scene, validated by
  `answerSchema`. This is the spirit of invariant 14: the server works from
  data it can bound and check, not from a program-like text.
- **A scene is bounded like an essay.** Counts, lengths, and 50 000
  characters of text in all (the limit of `rich`), since the autosave sends
  the whole answer every 300 ms; no control character in any text, so an
  answer cannot forge the structure of the text the server derives from it;
  and each field only on the types that use it. The editor refuses an edit
  that would break a limit rather than hand the host an answer the schema
  would refuse. Every parser reads a line of at most 1 000 characters with
  patterns that read a run of spaces one way only (linear on a failing
  line), and the editor parses at most 200 000 characters, so a pasted text
  cannot freeze the teacher's tab.
- **The routed polyline is not stored.** Unlike `circuit`, where
  `wire.points` is the geometry the netlist is read from (ADR-019), a
  diagram's meaning is its elements and links; the lines are recomputed on
  display. A change to the router therefore moves no grade and needs no
  migration of stored answers.
- **Ids are opaque and minted by the editor**, the rule of `categorize`
  (ADR-036): a starter reaches the student with its ids.

### 3. Eight kinds in v1, each a data entry

`class`, `usecase`, `state`, `er`, `flow`, `automaton`, `graph` and `free`
(docs/spec/04 §4.14 has the table). A kind is an entry of the catalogue:
its element kinds, link kinds, line mode (orthogonal or straight), text
form and example. Adding a kind is a catalogue entry, its serialiser and
parser with their tests, its icons and strings, and a screenshot; it
changes no schema of the type.

`free` answers the need the drawing type was planned for, with basic shapes
(square, rectangle, circle, ellipse, triangle, line) and a freehand brush,
and no links. It has no text form.

### 4. The text form is the teacher's, in v1

The teacher gets the text tab in the editor, editable, and the text forms
of the answer and of the reference in the grading panel, where a missing
link or a wrong multiplicity shows at a glance. The student does not see
the text form in v1: two editable surfaces for one answer raise the
question of which one is right when the text does not parse, and the
student's task is to draw. Showing it later, read-only or editable, is a
decision of its own.

### 5. Graded by hand in v1

Historical v1 scope; [ADR-063](ADR-063-correction-llm.md) §5 adds LLM grading through the text form.

`grade` proposes 0 points (`proposed`, `reason: manual`) for an answer and
validates 0 for no answer or the untouched starter, exactly like `rich`
(docs/spec/04 §4.8). The grading panel shows the two diagrams side by side.

Later, and each behind its own ADR:

- **Computed proposals per kind**, always `proposed` except where the rule
  is exact: the equivalence of two deterministic automata is decidable, so
  an `automaton` answer could be validated outright; a graph compares
  vertices, edges and weights; `class` and `er` match names with partial
  credit. A diff of the texts is rejected: the same diagram written in
  another order, or with another name for an unnamed link, would read as
  wrong. This is not the netlist comparison that docs/spec/00 §0.6 puts out
  of scope: a UML or ER diagram's elements carry the names the grading
  compares, which a schematic's components do not.
- **The LLM service** (F-LLM-01..04, Q13), fed with the text forms of the
  reference and of the answer and the rubric: `LlmGradeRequest` is already
  text-only (`packages/core/src/llm.ts`), and a diagram's text needs no
  vision model. `free` would need a rendering.

### 6. The student edits inline or in an overlay, never in the browser's full screen

The canvas sits under the prompt, and an Expand button opens it over the
page with a 16 px margin and a thin bar: the remaining time, the save state,
and one primary action, "Back to the questions". Both edit the same answer.

The browser's Fullscreen API is not used: it hides the header where the
server's clock is shown (invariant 5) and asks Safe Exam Browser (ADR-027)
to change its window, which it may refuse. The overlay is lent by the host
to the player, the way `RichText` already is (`PlayerProps`), since the
app's layers (`apps/web/src/ui/layers.tsx`) are not reachable from a
package.

### 7. `circuit` is left as it is

`qt-circuit` keeps its own canvas in this change. Moving it onto the engine
is a later, separate change, and it has a condition: `circuit` stores
`wire.points` as the geometry its netlist is read from, so the move must
produce byte-identical routes (`router.golden.test.ts` unchanged), and the
fixed box with its four ports becomes a policy the engine accepts (a bounded
world, anchoring on pins as well as on sides). It will have its own ADR.

Whether `diagram` also offers a drawing-only schematic kind is open
(docs/spec/06 Q29): `circuit` already has a `manual` grading mode, which is
a schematic drawn and graded by hand, and ADR-021 kept one concept per type.

## Consequences

- One more type in both registries, `QUESTION_TYPE_IDS`, the `contracts`
  enum, the leak test, the MCP guide, the seed and the guide; one more
  package besides the type. No table and no column.
- The drawing type of docs/spec/04 §4.10 disappears from the plan, and with
  it the Excalidraw dependency of docs/spec/05 §5.10 and docs/spec/06 Q11.
- The eight kinds each carry their text grammar: that is the largest test
  surface of the change (a serialise-then-parse round trip per kind, and the
  mockup's example for each).
- The grading panel gains a side-by-side view of two diagrams and of two
  texts, which later computed proposals and the LLM will reuse.

### Rollback

Unregistering the type hides it from new questions; stored questions of the
type would then fail to load, so a rollback deletes them first. The engine
package is inert without the type.

## Addendum (2026-09-30): what the implementation settled

Decided with the product owner when `packages/qt-diagram` was written.

1. **An answer is a stored, non-empty scene.** `isAnswered` keeps the
   contract of every type: a question is answered as soon as its stored
   answer holds something. The player writes nothing until the student's
   first edit, so an untouched starter is no answer at all. `grade` compares
   the answer with the starter (`sameScene` of the engine, key order and
   absent fields ignored): no answer, an empty scene or the starter as it
   was is a VALIDATED 0 with `details.reason: "empty"`; anything else is a
   PROPOSED 0 with `reason: "manual"`, like `rich`. A scene edited back to
   the starter therefore counts as answered on the student's list and is
   graded empty — the one place the two readings differ, on purpose: the
   list says "you touched it", the grade says "nothing was added".
2. **The overlay is an optional slot of `PlayerProps`.** `@quiz/core/client`
   gains `Expand?: ComponentType<{ open; onClose; children }>` (the
   `ExpandProps` interface). The student host of `apps/web`
   (`student/ExpandLayer.tsx`) implements it: a layer of the page with a
   16 px margin, a thin bar with the server's clock, the save state and the
   single primary action "Back to the questions". The player renders its
   ONE editor inside it while it is open (two live editors would keep two
   undo histories of one answer). Where the host lends no layer — the try
   panel, the grading panel — the player shows no Expand button. Every
   other type ignores the slot. Escape first reaches the canvas, which now
   consumes the key only when it cancelled something (the link being drawn,
   the tool, the selection); a key it leaves alone closes the layer, which
   is why `useLayer` gained `escape: false`. Alt+←/→ closes the layer and
   the player moves as ever. Under 1024 px the inline canvas is a read-only
   preview and the drawing happens in the layer.
3. **The grading panel stacks, the table counts.** The review draws the
   student's diagram, then the reference, then — for the teacher only — the
   two text forms (`toText`) in tabs "Student | Reference", then the rubric.
   The grading table's cell is the counts, "n elements · m links", with no
   thumbnail; the expected row gives the reference's.
4. **The kind is chosen on a draft and locked once published.** The editor
   shows a grid of eight cards (icon, name, one line); changing the kind of
   a drawn draft asks inline, then empties the reference and the starter. A
   question with a published version shows its kind without the grid: the
   host passes `EditorProps.published` (a new optional prop of
   `@quiz/core/client`, which every other editor ignores). The lock is the
   EDITOR's only. The server's publication gate
   (`QuestionTypeServer.publicationIssues`) sees the new config and not the
   published one, so it cannot tell a changed kind; enforcing it there
   would need a hook that compares two versions, which no type has yet.
   A version of another kind can still exist (one published through the
   MCP or an import), and can meet answers already given: the one-click
   "update to the latest version" is refused once an attempt exists
   (`updateVersions`), but a REGRADE (F-GRADE-06, issue #106) repoints the
   item at the version the teacher picks and grades the stored answers
   against it (`regradeItem`). `answerMisfit` only guards new writes. So
   `grade` defends itself: an answer holding an element or a link the
   version's kind does not have is a PROPOSED 0 with `details.reason:
   "kind_mismatch"` — never a validated empty 0 — the review says so, and
   `DiagramView` draws the foreign elements as they are.

The MCP guide (`describe_question_types`) documents the scene with one
example; `create_question` takes a scene, never a text form.

## Addendum (2026-09-30): Expand wherever one draws

Asked by the product owner once `diagram` shipped: the Expand button of
item 2 of the addendum above serves every canvas, the `circuit` one
included, and the teacher's as well as the student's. What it settled:

1. **One primitive, two types.** `ExpandableCanvas` of `@quiz/ui` is the
   behaviour item 2 describes, written once: the heading row with the Expand
   button (only when a layer is lent), the one-line note in place of the
   inline canvas while the layer is open (one live editor), and — for a
   player, which passes a `preview` — the read-only picture under 1024 px
   that opens the layer. The `diagram` and `circuit` players and editors all
   use it; `@quiz/ui` still depends on `@quiz/core` alone. `circuit` keeps
   its own canvas (§7): only its frame changed.
2. **`circuit` hands Escape back like `diagram` does.** Its canvas consumes
   Escape only when it cancelled something (the wire being drawn, the armed
   tool, the selection), and its inspector fields consume the Escape that
   blurs them, so a layer around it closes on a key left alone and never
   under a field being typed in. `SchematicEditor` takes `height="fill"` to
   take the room of the layer rather than its fitted height.
3. **`EditorProps.Expand`, the same slot as the player's.** `@quiz/core`
   gains an optional `Expand` on `EditorProps`, of the same `ExpandProps`
   shape, which gains an optional `title` (what the layer holds, "Reference
   diagram"). In `diagram`'s editor the reference and the starter each get
   their own button, and the text tab works inside the layer; in
   `circuit`'s, the reference circuit (its only canvas). The inspectors
   stay where they are.
4. **One layer in `apps/web`, two bars.** The layer's mechanics
   (`ui/expand.tsx`, `ExpandPanel`: the 16 px margin, the focus trap, the
   Escape rule) are one component; the student's bar
   (`student/ExpandLayer.tsx`) keeps the server's clock, the save state,
   "Back to the questions" and Alt+←/→; the teacher's
   (`question/EditorExpandLayer.tsx`) shows the title of what is edited, the
   draft's save state where the screen autosaves (the question editor's
   Edit tab, through a context), and one primary action, "Close" — no
   Alt+←/→, there is no question to move to.
5. **Where a teacher plays a question, the teacher's layer too.** Every
   editor host lends it (`QuestionEditorHost`), and so do the Try tab and
   the previews (`PlayedQuestion`: the preview page, the pool's reading
   pane, the picker, an evaluation item's preview). The grading panel,
   which shows a read-only statement, lends none, and there the players
   still show no Expand button.

## Alternatives considered

- **Embedded Excalidraw, as planned.** Free-form: no notion of an element or
  a link, so no text form, no structured review and no computed proposal
  ever; its look is its own (Q11).
- **Mermaid or PlantUML as the answer, typed by the student.** A student
  who draws is tested on the notation; one who types is tested on a syntax.
  It also makes the server parse student text.
- **The text as the stored form.** Needs the server to parse three grammars
  from untrusted input, and loses the layout the student chose.
- **One type per notation** (`classdiagram`, `statemachine`, ...). Eight
  types with one editor, one config shape and one grading rule; the kind is
  a field.
- **Moving `circuit` onto the engine in the same change.** Puts a type in
  production at risk (its stored polylines decide its grades) for no gain to
  the new type.
