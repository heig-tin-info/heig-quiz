# ADR-044 — The grading table: one question at a time, anonymous by default

## Status

Accepted (2026-09-29, decided by the teacher who owns the product, on the
mockup `mockups/grading.html`). Rewrites F-GRADE-03 (docs/spec/02), amends
decision D20 of `docs/PLAN-MVP.md` (pseudonyms now belong to the live
dashboard only) and the grading shortcuts of docs/spec/08 §8.5. Implemented
by `apps/web/src/grading/`, the optional `grading` member of
`QuestionTypeClient` (`packages/core/src/client.ts`), the `grading.tsx` of
every `qt-*` package (the mcq, short and cloze columns first, the other
five in a second step), and the grading contracts
(`packages/contracts/src/grading.ts`). The return from the question editor
to the grading table came in a third step (addendum below).

## Context

The grading panel was a traversal: a path of steps — questions, or students
on demand — and, for each step, a list of answers beside ONE answer shown at
a fixed place, walked with Previous / Next. It had grown a step picker, a
"show parts" menu, pseudonyms, a batch banner and a strip of shortcuts, and
still asked thirty clicks to look at thirty answers to one question.

What a teacher does on that screen is compare: thirty students' answers to
one question, to see which ones are alike, which one the key got wrong,
which ones need a closer look. A list of labels beside one answer hides
exactly that. The by-student walk served a dispute with one student — which
the results page already answers, per student and per question.

The names were hidden behind a stable pseudonym (D20). On the live
dashboard a pseudonym names a row a teacher points at in front of a class;
in the grading panel it named nothing useful, and it leaked order: rows
sorted by pseudonym, or by the server's attempt order, are the same order
every visit, and a teacher learns that the third row is Alice.

## Decision

### 1. One table per question

The screen grades ONE QUESTION AT A TIME. A card names it (a menu of every
question with what each still asks for, the chevrons, and the evaluation's
questions as the student player's stepper, `ProgressSegments` reused as it
is). Under it, a table: a row per answer, the verdict first, the answer
spread over columns, the points, the row's actions. The question's key is
pinned as the first row. A row opens a side panel (a `Sheet`) with the
answer in full — the type's own `Review`, the explanation, the history — and
the adjustment form inline, where the one comment the student may read is
written.

The by-student traversal is removed everywhere: `?by=student`, the steps
per student, `GradingQueue.order`, `GradingSteps.order`. The API keeps its
endpoints; `GET …/grading/steps` is one entry per question with two
counters (answers, validated), and the queue has no state filter any more:
the table filters in the browser.

### 2. The columns belong to the question type

`QuestionTypeClient` gains a REQUIRED member, `grading.columns(student,
solution, strings)`, returning columns that each carry a short plain-text
label (the whole text as its title), `cell({ answer, details })`,
`expected()` for the key, and `sortKey(answer)`. The key reaches a column
once, through `columns()`. A column is keyed by CANONICAL identity — a choice's
canonical index, a blank's index — which holds because the grading queue
sends every view with `shuffle: false`. The cells are functions returning
nodes: `@quiz/core/client` stays type-only for React, and the type's client
module already imports it. The marks a cell is drawn with (a chip tinted by
its verdict, a tick box, "no answer") live in `@quiz/ui`, once for all
types.

`sortKey` is a NORMALISED string (`gradingSortKey`: NFC, case folded,
whitespace collapsed). It sorts the table today; it is the key that will
group identical answers tomorrow — grade once, apply to every identical
answer — so it never depends on the student, the grading or the rows.

There is no host fallback. The first step had one — the answer as one
column of text — while five types had no columns yet; once every type gave
its own, the member became required (owner decision, 2026-09-29): a type
without columns is a compile error, and the host keeps no second reading of
an answer to drift from the type's. What each type chose, where a column
per part would not do:

- `mcq` a column per choice, `cloze` per blank, `short` one column.
- `categorize` a column per CARD, headed by the card, the cell naming the
  column the student chose, tinted by that card's verdict in the details.
  Past EIGHT cards, one summary column instead ("5/9 right"): nine columns
  of chips is a table nobody reads, and the side panel shows the board.
- `code` ONE wide column: what the student wrote (the editable regions,
  dedented, a blank line for the locked code between two), in a box as
  wide as the column, CLAMPED to five lines with a fade and "⋯ N more
  lines"; a click unfolds it in place and never opens the panel. A chip
  beside it counts the tests passed. The expected row holds the reference
  solution. The clamped box is one primitive of `@quiz/ui` (`ClampedCode`).
- `codeimage` the same, with the PICTURE the grading stored
  (`details.image`, the field the review reads) as a 56 px thumbnail,
  drawn only once its row nears the viewport (`IntersectionObserver`): a
  class is a hundred canvases. "runner…" stands in for a picture the runner
  still owes; the expected row shows the target.
- `circuit` one column summarising the schematic ("3 parts · 4 wires") and
  a chip counting the stimuli passed (the failed ones in its tooltip); the
  drawing stays in the panel.
- `rich` one column, the essay as plain text (markdown marks stripped,
  never rendered) clamped to three lines; the expected row holds the model
  answer, else the rubric.

### 3. Anonymous by default, without pseudonyms

**Anonymise** is ON at every visit and never stored. Anonymised, the server
sends `label: null` and nothing else that names the student (no user id, no
name, no address); the Student column is absent; and the rows stand in an
order drawn ONCE PER VISIT: each row's place is a hash of a seed drawn when
the page opens, the item and the attempt — of the row, never of its position
— so a validation, a refetch or a filter moves no row, and the next visit
shows another order. Sorting overrides it, and ties keep it. Named
(`?anonymous=0`, a different request, never a client-side unmasking), the
rows are ordered by name.

This departs from D20 for the grading screen: a pseudonym is kept on the
live dashboard, where a row is pointed at in front of a class, and dropped
here, where it was an identity in disguise.

Named, a guest of a poll (ADR-014) is sent as its number among the guests
(`GradingEntry.guest`), never as an English "Guest 2": the web words it.

Two facts stay visible anonymised, because they are not names and hiding
them would mislead: a retake's number (`GradingEntry.attemptNumber`, the
" · #2" once glued to the label; ADR-025), with the attempt that counts
marked (`kept`), so two answers of one student do not read as two students;
and a **Teacher** badge on a teacher's own test run (`staff`, ADR-018).

### 4. One primary action

The screen has ONE accent button, at the end of the filter row: **Validate
N** validates the proposals the table shows (the existing batch endpoint,
scoped to the item and the source / confidence filters, `isBatchable` as
ever); once the question is fully validated it becomes **Next question**,
and on the last one **Results**. While what is left cannot go in a batch (a
runner verdict pending, an essay's 0-point placeholder) it stays in place,
disabled, its tooltip saying why. A row waiting for a decision wears no fill:
its verdict glyph and its visible Validate say it. "Run grading" is a banner
above the table, present only while THIS question has answers the pass still
owes — ungraded, or a machine's proposal saying why it could not grade
(`MACHINE_REASONS`, `@quiz/contracts`) — and it reruns this question only
(`itemIds: [item]`). The evaluation-wide pass stays in the command palette.

### 5. Keys in the sidebar

← / → change the question, ↑ / ↓ the row (the key's row first), Enter opens
it, V validates it, A adjusts it; Escape closes the panel. They are
registered in the app's shortcut strip, not drawn on the page.

## Consequences

- The per-answer walk, its step picker, the "show parts" menu, the
  pseudonyms of the panel and the batch banner are gone; a teacher sees a
  question's answers side by side and sorts them.
- The panel is keyed on the ENTRY (attempt and item), never on a row index:
  an answer validated under "To validate" leaves the table, and the panel
  keeps showing it rather than the next student's.
- The remembered view keeps the state filter, the source and the
  confidence; an older stored view (with `order` and `parts`) reads
  gracefully.
- Every type implements one function to have a grading table, and must:
  a new type without it does not compile.

### Residual risk

The queue of one question is still one unpaginated response (open question
23); with the answers now sorted and filtered in the browser, pagination
will have to take the sort over when it comes.

## Addendum — fix the question, come back, re-grade (2026-09-29)

The expected row's two buttons exist for one errand: the key is wrong, fix
the question, grade again with the fix. It is now one round trip.

- **The question on screen is in the URL.** `?item=<item id>` on
  `/evaluations/:id/grading` (`Route` `{ view: "grading", evaluationId,
  item? }`, the same name as the parameter and as the editor's `item`); the panel reads it, starts on that question (the first when
  the id is not the evaluation's), and writes it back as the teacher moves,
  so a reload stays on the question.
- **Edit question opens the editor with its way back.** `?fromGrading=<evaluation>&item=<item>`,
  like `?from=` (issue #127) and `?fromTemplate=`: the header reads **Back
  to grading** and leads to that question's table. Opened from there,
  **Publish is the way back**: the version published, the editor returns to
  the table at once — the fix was made to re-grade with it. Opened from
  anywhere else, publishing stays in the editor as before. The editor's
  origins are one table keyed by their parameter (`ORIGINS` in
  `QuestionEditor.tsx`: how the way back is worded and fetched, where it
  leads, `returnOnPublish`), and the route writes the same parameter list
  (`QUESTION_ORIGIN_PARAMS`) in one loop. The grading origin's words name no
  title, so it fetches nothing.
- **Edit question is the pool's decision.** Grading asks `staffAccess` on
  the evaluation; editing asks `contributor` in the question's pool. An
  assistant on the staff may grade without writing the pool, and then sees
  no Edit. The rule is not re-derived: the grading screen reads
  `EvaluationDetail.editableQuestionIds`, computed by the server with the
  pool list's own role resolution (`editableQuestionIdsOf`, issue #127), the
  evaluation page's own source.
- **A newer version is said where it is acted on.** When the question has a
  published version newer than the one the evaluation froze — the server's
  `EvaluationDetail.staleItems` (`staleOf`), the evaluation page's own stale
  badge, never re-derived — Re-grade becomes a filled SECONDARY button, "New
  version" (tooltip "A newer version is published — re-grade"); never the
  accent, which stays Validate N. It names NO number (owner decision): the
  newest version may be deprecated, and the sheet's preselection
  (`defaultVersion`, issue #106) is the one rule for which version a
  re-grade starts on, so the button never names one the sheet would not
  pick. Publishing invalidates the evaluation and its grading reads,
  so the button is there on return without a reload.
- **After release, the sheet warns first** (F-GRADE-09): re-grading updates
  the grades the students see and marks the results modified after
  publication.

No field was added to the grading contracts: the evaluation's payload
already carried the rights and the stale items.

## Alternatives considered

- **Keep the traversal and add a table view beside it.** Two ways through
  the same work, two sets of keys; the table is what the teacher asked for.
- **Keep pseudonyms, shuffle them.** A stable pseudonym is an identity a
  teacher learns within a session; no label at all hides it better.
- **Columns decided by the host** (a switch on the type id in `apps/web`).
  Every new type would edit the app; the contract keeps the knowledge of an
  answer's shape in the type, as `Review` already does.
