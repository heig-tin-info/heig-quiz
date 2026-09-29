# ADR-040 — The grading table: one question at a time, anonymous by default

## Status

Accepted (2026-09-29, decided by the teacher who owns the product, on the
mockup `mockups/grading.html`). Rewrites F-GRADE-03 (docs/spec/02), amends
decision D20 of `docs/PLAN-MVP.md` (pseudonyms now belong to the live
dashboard only) and the grading shortcuts of docs/spec/08 §8.5. Implemented
by `apps/web/src/grading/`, the optional `grading` member of
`QuestionTypeClient` (`packages/core/src/client.ts`), the `grading.tsx` of
`qt-mcq`, `qt-short` and `qt-cloze`, and the grading contracts
(`packages/contracts/src/grading.ts`). The other types get their columns in a
second step; the return from the question editor to the grading table, in a
third.

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

`QuestionTypeClient` gains an OPTIONAL member, `grading.columns(student,
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

A type without `grading` gets the host's fallback: one column holding the
answer as text (the reading the dashboard's tooltip already has), else the
type's `summarize`, else an invitation to open the row; its key reads "—".
`mcq`, `short` and `cloze` give columns now; `categorize`, `code`,
`codeimage`, `circuit` and `rich` fall back until they do.

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
- Every type that wants a real grading table implements one function;
  until then the fallback is honest, never wrong.

### Residual risk

The queue of one question is still one unpaginated response (open question
23); with the answers now sorted and filtered in the browser, pagination
will have to take the sort over when it comes.

## Alternatives considered

- **Keep the traversal and add a table view beside it.** Two ways through
  the same work, two sets of keys; the table is what the teacher asked for.
- **Keep pseudonyms, shuffle them.** A stable pseudonym is an identity a
  teacher learns within a session; no label at all hides it better.
- **Columns decided by the host** (a switch on the type id in `apps/web`).
  Every new type would edit the app; the contract keeps the knowledge of an
  answer's shape in the type, as `Review` already does.
