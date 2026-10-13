# ADR-109 — Each question type draws its own answer key for the debrief

## Status

Accepted (2026-10-13, issue #828; its shape decided by the product owner).
Amended the same day by the
[amendment](#amendment-2026-10-13-the-program-and-the-essay-draw-their-key)
(the program and the essay draw their key; §7 reversed for them), then by
the [second amendment](#amendment-2026-10-13-the-three-canvases-draw-their-key)
(diagram, circuit and blocks draw theirs; every type that counts test cases
now has a key).

Scope: the optional `Key` surface of the question-type client contract
(`packages/core/src/client.ts`) and its host, the correction projection and
the Results "Questions" tab (`apps/web/src/results/CorrectionQuestion.tsx`).

Relations: amends [ADR-033](ADR-033-projection-de-la-correction.md) (who
draws the key on the wall and on the page); depends on
[ADR-056](ADR-056-questions-parametrees.md) §9 (the example caption stays
the host's).

## Context

The debrief draws each question's key: an mcq's choices, a cloze's blanks in
its text, a short or math answer's expected answers, a categorize board, a
program. The web host did it with a table keyed by type id, importing the
solution types of six `qt-*` packages and copying pieces the types already
own (the categorize board, the math answers). diagram, circuit and blocks
still have no key on the wall, because their renderer is in their package
and out of the host's reach. A type's look should live with the type.
The host's copies of the categorize board and the math answers move into
their packages as they are, not merged with the types' own pieces, which
render differently: that duplication is deferred, not solved.

## Decision

1. **An optional `Key` surface.** `QuestionTypeClient.Key` is a
   `React.lazy` component, wired through `@quiz/registry/client` like
   `Review`. `drawsKey(type)` is "the type's client has a `Key`"; the host's
   table by type id is gone. A type without one gets the host's prompt and
   answer groups, as before.
2. **Staff only.** It reads the solution the per-question view serves the
   course's staff (`GET /evaluations/:id/results/by-question`), which never
   goes through `toStudent`. It must never be mounted on a student surface;
   `apps/web/src/results/keyGuard.test.ts` holds one reader of `.Key` in the
   app, two staff screens importing it, and no student directory importing
   anything of `results/`.
3. **Structural props.** `KeyProps` names the student view, the solution,
   `revealed`, the `density` (`wall` or `page`) and `stats`: the outcomes,
   the answer groups and the parameterized flag — the part of `ByQuestion`
   the keys read, written structurally because `@quiz/contracts` depends on
   `@quiz/core`. The host passes its `ByQuestion` as `stats`, so a contract
   change a key would not survive fails to compile there.
4. **Slots from the host.** The host draws the generic pieces and lends
   them: `prompt` (the statement, inside the host's frame) and `rows` (the
   answer groups), and `statement(body)`, the frame itself — the example
   caption of a parameterized question (ADR-056 §9) above it and, on the
   wall, the explanation after it. A key places, replaces or omits them: an
   mcq and a categorize board keep the prompt and draw instead of the rows;
   a cloze draws its text through `statement` and no rows; a short and a
   math answer put "Expected answer" above the rows.
5. **Renderers lent by the host**, as `renderMarkdown` already is: the thin
   segmented bar (`Bar`, `SegmentedBar` of `apps/web/src/ui/bar.tsx`), the
   inline markdown, and a cloze's `renderText`. A package never imports
   `apps/web`. The Suspense fallback is the statement itself, so nothing
   above the key moves when its chunk arrives.
6. **Density split.** The sizes the host and several keys share live in
   `CORRECTION_SCALE` of `@quiz/ui` with the `Density` type; those only the
   host draws stay in its `SCALE`; those only one type draws live in its
   `Key.tsx`. The words move with them, under `qt.<type>.k.*`; a cloze's
   "correct" and "wrong" stay the head's `correction.outcome.*`, mapped.
7. **`code` and `rich` wait** (reversed by the
   [amendment](#amendment-2026-10-13-the-program-and-the-essay-draw-their-key)
   for `code`, `codeimage` and `rich`; ended by the
   [second amendment](#amendment-2026-10-13-the-three-canvases-draw-their-key)
   for the three canvases). The program (template, reference, test cases)
   and an essay's model answer stay in the host for now: they have their own
   treatment on the Results tab beside the type's review, and moving them is
   a separate change. diagram, circuit and blocks gain a `Key` next.

## Consequences

- The host no longer imports a type's solution shape for mcq, cloze, short,
  math or categorize; a type's key is tested in its package.
- The first projection of a type fetches one more chunk; the statement
  stands meanwhile.
- A short or math key wraps the host's answer groups in one more flex
  column of the same gap: the same pixels, one more element.

## Alternatives considered

- **Keep the host's table and import more `qt-*` internals** for diagram,
  circuit and blocks: the duplication the issue names, growing by type.
- **Two surfaces, a statement and an answers piece**: the host would still
  decide which type replaces what. One component with slots lets the type
  decide and keeps the host type-blind.
- **Move `SegmentedBar` into `@quiz/ui`**: it reads the app's i18n and
  tooltip layer; lending it keeps one bar and no new package dependency.

## Amendment 2026-10-13: the program and the essay draw their key

Settled with the product owner on 2026-10-13 (#828, second part). It
reverses §7 for `code`, `codeimage` and `rich`; diagram, circuit and blocks
still wait (ended by the
[second amendment](#amendment-2026-10-13-the-three-canvases-draw-their-key)).
The rest stands.

1. **A third slot, `cases`.** `KeyProps.cases` is the host's bars of the
   test cases (`ByQuestion.casePassRate`), beside `prompt` and `rows`, and
   `null` when the type counts no case. The host keeps drawing them, so the
   rules of ADR-033 stay in one place: a case reads by its `label`, never its
   `name`, and the papers it never ran on are "not run". `KeyStats` does not
   carry the pass rates. A type without a `Key` still gets them from the
   host, in the program's two columns (`blocks`, until it draws its own key;
   ended by the
   [second amendment](#amendment-2026-10-13-the-three-canvases-draw-their-key),
   §6).
2. **One program key for `code` and `codeimage`**, in `qt-code`
   (`ProgramKey`): the reference solution, or hidden the code the class
   started from, with the cases beside it and the answer groups under it (a
   code image's accuracy buckets). It takes over what the host drew; the
   target image of a code image stays out of the debrief. Its words are
   `qt.code.k.*`, read by both types.
3. **The essay's key, `rich`:** its model answer, once revealed, after the
   statement. Several paragraphs, lists and formulas need a block renderer:
   `KeyProps.renderBlock`, lent by the host as `renderMarkdown` is, at each
   density's size.
4. **No key draws a rubric**, the grading criteria, at either density. They
   are the grader's (ADR-037) and stay on the grading screen; the wall is
   read by a class. The `Key` doc comment in `@quiz/core/client` says so,
   and the essay's key is tested for it.
5. **The Results "Questions" tab changes for these three types.** Drawing a
   key, they leave the type's own review (`QuestionReviewHost`): the card
   shows the statement, the key and the cases, no longer the empty student
   copy ("no answer", a score of "—") nor an essay's criteria. The wall is
   unchanged, markup for markup.

## Amendment 2026-10-13: the three canvases draw their key

Settled with the product owner on 2026-10-13 (#828, last part). `diagram`,
`circuit` and `blocks` gain a `Key`, which ends §7; the rest stands.

1. **The reference, drawn by the type's read-only renderer**: a diagram's
   (`DiagramView`, [ADR-046](ADR-046-type-diagramme.md)), a schematic
   (`SchematicView`), a program of blocks
   ([ADR-103](ADR-103-type-blocs.md)). The host lends the canvas's words
   (`canvasStrings`) as it lends `strings`.
2. **Hidden, nothing hints at the reference.** A diagram shows its starter,
   or a hatched block — never the counts of elements and links its review
   prints beside the reference. A circuit, whose students start from an
   empty box, shows a hatched block. A program of blocks shows its starter,
   the warehouses the class could see and the host's bars of their passes.
   A hidden warehouse's map (`solution.cases`) never appears, revealed or
   not: the key reads the student view's visible ones only.
3. **One frame per density** (`KeyFrame` of `@quiz/ui`): one element of a
   fixed height, hatched while hidden, measured for the renderer's height in
   pixels. The reveal changes what is inside it, never its size; on the wall
   it follows the screen, so a diagram is read across a room. No Expand.
4. **A program of blocks is text on the wall**, in the canvas's words
   (`pseudoCode`): a Blockly workspace would take the focus, and with it the
   arrows and the space bar the projection's stepper answers to. The page
   keeps the read-only workspace. Each key stays a chunk of its own; the
   engine and Blockly load with it, never before.
5. **No rubric**, a diagram's included, at either density; nor a diagram's
   text forms (ADR-046 §4). They stay on the grading screen.
6. **The Results "Questions" tab changes for these three types**, as the
   first amendment's §5 did for its own: their review leaves the card, and a
   circuit gains a key there (its review with no answer showed none). The
   host's bars of test cases for a type without a key (first amendment, §1)
   go: every type that counts cases now draws a key and places them.
