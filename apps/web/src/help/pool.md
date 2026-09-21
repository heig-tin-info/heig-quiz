# A pool's questions

## Categories

While a pool is open, its categories appear in the left sidebar, under
**Question pools**: **All questions**, **Uncategorized**, then the tree.
Picking one narrows the table to it. The tree also creates a category or a
subcategory, renames one, moves it among its siblings, and deletes it —
deleting a category sends its questions back to the root, it never deletes
a question.

## Search and filters

The search field matches the internal name and the statement. **Filters**
opens type, difficulty, tag and **Show deleted questions**. Whatever is
active comes back as removable chips under the bar, with the number of
questions they leave.

The field also takes the filters as words, which is faster than the sheet
once you know the vocabulary:

| Written | Means |
| --- | --- |
| `tag:pointers`, `tag:#pointers` | the questions wearing that tag |
| `type:mcq`, `type:short`, `type:cloze`, `type:code` | that question type |
| `difficulty:3` | exactly 3 |
| `difficulty:>3`, `difficulty:>=2`, `difficulty:<3`, `difficulty:<=4` | a bound |
| `difficulty:2-4` | a range |
| `version:v2`, `version:2` | published version 2 |
| `version:>1`, `version:>=2`, `version:<3`, `version:1-3` | a bound, a range |
| `"a whole phrase"` | those words together |

Anything else is free text. Several `tag:` add up; two `version:` bounds
narrow each other. What you type and what you tick are the SAME filter: both
appear as chips, and removing a chip removes the word from the field too.
Right after `tag:` or `type:` a short list opens under the field — type to
narrow it, arrows to move, Enter to insert, Escape to close.

## The table, the cards and the grouping

One row per question: the type as an icon in front of the internal name
(hover it for its name), tags, difficulty as five dots, the published
version, the last change as a distance — hover it for the exact date. A
click opens the editor. Every row carries edit, duplicate and delete at its
end.

Clicking a column header sorts the whole pool by it, not just the questions
already loaded; clicking it again reverses the order. The default is the
last change, newest first.

Beside the filters, three controls change how the list is drawn: **cards or
table**, **group by** (nothing, type, tag or category) and the **sort**,
which is the only place the type can be sorted since it lost its column. A
question wearing three tags appears in each of the three sections. All of it
is remembered for the next visit.

## A pool someone shared with you

If your seat on the pool is **reader**, the screen shows the questions and
none of the actions: no new question, no edit, no duplicate, no delete, no
tick boxes. Opening a question still works — reading one means opening it.

## Several at once

Tick the rows and a bar appears at the bottom: add a tag, move them to a
category, delete them. It reports once, at the end.

## New question, versions

**New question** asks for the type and an internal name, then opens the
editor. Only a published version can be used in an evaluation — the draft
never is, and publishing creates the next number. Deleting a question hides
it from the pool; the results already recorded stay.
