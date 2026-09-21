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

## Writing the statement

The statement and the explanation are written as you would in a word
processor. Markdown is what is stored underneath, so `**bold**`, `$math$`
and fenced code blocks work if you prefer typing them. A pasted image is
uploaded and referenced by a stable id.

## Publishing

**Publish** validates the draft against the type's schema and creates the
next version, with an optional change note. A published version never
changes: fixing an answer key means publishing again. **Student preview**
shows the draft exactly as a student receives it — no key, no explanation.

## Shortcuts

`Ctrl+S` saves, `Ctrl+Enter` tries the question, `Ctrl+Shift+P` publishes,
`Ctrl+Shift+M` toggles the student preview. `Ctrl+K` opens the command
palette, which carries the same three actions.
