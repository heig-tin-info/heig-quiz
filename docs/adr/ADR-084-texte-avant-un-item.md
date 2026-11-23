# ADR-084 — A text before an item: the intro of an evaluation item

## Status

Accepted (2026-10-08, issue #455; the design in the issue was accepted by the
product owner, who asked for it to be built as written). Requirement
F-EVAL-34. Delivered in one pull request: migration `0085_item_intro`, the
contracts, the builder's "+ Text" and the player's passage screen.

Amended 2026-11-23 (product owner), scope §6 and the builder band of the
Consequences, web only (nothing stored, no contract changed): the question
list shows an entry for the text, just before its question — a smaller dot,
no number, no mark, named by the text's first heading ("Text" without one),
current while the passage is up. Under `free` navigation it opens the
passage, from anywhere; under `forward_only` and `milestones` it leads where
its question's entry would until the text is passed, then it is closed. It
replaces "Read the text again", which is gone. The heading is in the list
for the whole attempt — before the text is reached and after it is closed —
so a teacher must not put what is to be memorised in it. A single question
with a text has a list while the text can still be opened (two screens);
once it is closed, under `forward_only` or `milestones`, the list goes.
Alt+←/→ still step from question to question; a passage is not a stop of
its own. The builder's band folds
to the text's title and first paragraph and unfolds, on a click, to the
text as the student reads it.

Scope: the column `evaluation_items.intro`, the item routes of an evaluation
and of a template (`ItemPatch`), the copies of an item list (duplicate,
*Save as template*, *Instantiate*, pull), the template's revision and pull
summary, `AttemptItem` (the attempt and the teacher's preview) and the zen
player.

Relations: extends [ADR-031](ADR-031-modeles-d-evaluation.md) (an intro is
item content, like the milestone flag and the bonus flag of
[ADR-052](ADR-052-questions-bonus.md)); reads F-EVAL-07 and F-LIVE-08 as they
stand, and changes neither.

## Context

A teacher wants text that is not a question inside an evaluation: the
instructions at the start ("read chapters 8 and 9 of the handout, then
answer"), a transition mid-exam ("end of part 1; the next questions are
code"), a passage to memorise that disappears once the student moves on. A
reading task with a deadline is an `exercise` with such a text and two or
three comprehension questions (heig-classroom#52), which also tells the
teacher who actually read.

## Decision

1. **An intro is a property of an item, not a question type.** An item may
   carry `intro`, optional markdown of at most 10 000 characters, shown to
   the student as a **passage screen before that item**. A blank text is
   stored as none (`null`). It is the teacher's own content for this
   evaluation: never translated, never written into a pool. The item stays
   one question; an intro adds no item, no points, no answer.
2. **Written through the item routes, under the item list's lock.** `PATCH
   …/items/:itemId` with `{ intro }` (a string, or `null` to remove it), on
   an evaluation and on a template alike. It is part of what a student is
   shown, so it is frozen exactly like the points and the milestone flag
   (`assertItemListEditable`: no attempt, `draft` or `scheduled`).
3. **Carried by every copy, and a change of it is a change of the item.**
   A duplicate, *Save as template*, *Instantiate* and a pull copy it with
   the item. On a template, a write that changes an intro moves the
   revision (it is part of `contentOf`). A pull's summary lists an item
   whose intro differs as `changed` ("text before the question changed"),
   and the pull replaces it with the template's.
4. **It reaches the student with the item, through the one builder of the
   attempt.** `AttemptItem.intro` is filled in `attemptItems`
   (`live/views.ts`), beside `milestone` and `bonus`: the attempt, its
   restore and the teacher's preview (ADR-018) all come through it. It is
   not question content and does not pass `toStudent`; it is an item
   property the teacher wrote for students to read, and nothing of a
   question's key, concepts (tags before ADR-081's cut-over) or explanation
   travels with it.
5. **Not in grading, feedback, results nor the dashboard.** None of those
   payloads carries it: they are about answers, and the intro asks none.
   The teacher reads it in the builder.
6. **The passage screen.** In the zen player, arriving on an item that has
   an intro shows the text first, with one primary action, **Continue**,
   which shows the question. The question list (F-LIVE-09) gives the intro
   an entry of its own just before its question (amended 2026-11-23; it
   listed questions only before): a smaller dot with no mark and no number,
   named by the text's first heading, or "Text"; the current entry while
   the passage is up. The questions keep their numbers.
   - **When it shows.** On arriving at the item, unless this player already
     passed it — or, on loading the attempt, unless the item is already
     started (an answer, "Leave unanswered", or validated). A student who
     reloads mid-question is not shown the text again.
   - **`free` navigation:** it can be reopened at any time from its entry
     in the question list (until 2026-11-23, from a "Read the text again"
     button beside the question's heading, now removed).
   - **`forward_only` and `milestones`:** Continue is one way: the text is
     not reopenable once passed, which is what makes "memorise this, then
     answer" work. Its entry leads where its question's would until then,
     and is closed after. The lock of a passed milestone is unchanged and
     generated by the platform (F-LIVE-08): "you won't be able to go back"
     is never the teacher's to write. A transition with a lock is a
     `milestone` on the item before plus an `intro` on the item after.
7. **Shuffled items carry their intro.** Under `shuffleItems` an intro
   travels with its item, as the milestone flag already does: it is the
   item's, not a position's. The builder says nothing more; whether a
   shuffled paper should pin its intros was left open in 06 no. 55, settled 2026-10-08: it travels with its item.

## Consequences

- One nullable column and one optional field; no special case in the total,
  the grading table, the summary, the statistics, the drill, the debrief,
  the "answered" counter, the flag or the validation — an intro is none of
  those things.
- The "passed" fact is held by the player, not stored: a student who
  reloads before starting a question sees its text again, even after a
  milestone. Acceptable for instructions and transitions; for "memorise",
  it is the limit recorded in 06 no. 55, accepted by the product owner on 2026-10-08.
- The builder reads as sections: a recessed band above the item it
  precedes, and a "+ Text" control in each gap between items (and above
  the first). The band is folded to the text's title and first paragraph,
  never its code, and a click unfolds it to the text as the student reads
  it (amended 2026-11-23; it showed the first lines of the raw text).

## Alternatives considered

- **A "Description" question type worth 0 points (Moodle).** Rejected: it
  would have to be excluded from the total, the grading table, the
  student's summary, the statistics, the discrimination, the drill, the
  debrief, the "answered" counter, the progress, the flag, "Leave
  unanswered" and "Validate and continue" — a dozen special cases — and
  evaluation-specific text would end up in pools.
- **A separate list of sections on the evaluation.** Rejected: an intro
  then needs an anchor that survives reorders, deletions, copies and
  pulls, which the item already is.
- **Recording the passage on the server.** Not done (06 no. 55, settled 2026-10-08 by the product owner): it needs a
  write per passage and a column on the answer, for a guarantee no teacher
  has asked for yet.
