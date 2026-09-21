# Question editor

## The draft saves itself

You always edit the draft. It is saved shortly after you stop typing, and
the badge beside the title is the answer to "did that save?". An incomplete
draft is stored as it is; publishing is what asks for the missing pieces.

## Three tabs

- **Edit** — the form of the question type, the explanation, and the
  properties on the right: internal name, category, difficulty, tags,
  whether the choices are shuffled per student.
- **Try** — answer your own question and see the correction. Nothing is
  recorded.
- **Versions** — every published version, with its change note. You can
  view one, restore it into the draft, or mark it deprecated with a reason.

## Tags

The tags field suggests the vocabulary already in use in the pool, with the
number of questions wearing each tag and the one-line description of what it
means. Pick one rather than typing a synonym: two spellings of the same idea
split the pool in two. A word nobody has used yet is offered as
**Create "..."**, and you are asked to describe it on the spot — that
description is what the next teacher reads. Click a tag to write or change
its description; press Backspace in the empty field to take the last one off.

## Writing the statement

The statement and the explanation are written as you would in a word
processor. Markdown is what is stored underneath, so `**bold**`, `$math$`
and fenced code blocks work if you prefer typing them. A pasted image is
uploaded and referenced by a stable id.

## Scoring a multiple-answer question

A multiple-choice question with several correct answers is scored by a
policy, and its default is **inherited from the evaluation** — you set it
once per quiz, or once for all the quizzes you create, and a question only
names its own when it really needs to. The five policies, and what each one
gives for a half-right answer, are explained under "Multiple-answer
scoring".

## A short-answer question

The kind of answer — text, number, date or time — decides what the student's
field is, and the constraints beside it decide what that field takes: a length
window, a numeric range, a window of dates. The student is stopped while
typing rather than told afterwards, and none of it gives the answer away.

The two **prefilters**, Trim and Lowercase, are decided once for the whole
question: they are applied to the student's answer and to every accepted text
before the comparison, so a key with five accepted answers no longer asks the
same question about the case five times. Only "Integer" also reaches the
grade: a non-integer answer to a whole-number question is wrong.

## Publishing

**Publish** validates the draft against the type's schema and creates the
next version, with an optional change note. A published version never
changes: fixing an answer key means publishing again. **Student preview**
shows the draft exactly as a student receives it — no key, no explanation.

## Shortcuts

`Ctrl+S` saves, `Ctrl+Enter` tries the question, `Ctrl+Shift+P` publishes,
`Ctrl+Shift+M` toggles the student preview. `Ctrl+K` opens the command
palette, which carries the same three actions.
