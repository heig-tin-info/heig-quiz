# What's new: one entry per pull request

After an update, students and teachers are shown what changed on the
platform, from their point of view (ADR-087). Each entry is one file of this
directory, added by the pull request that makes the change. This README is
not an entry.

**Every pull request adds one** (`checks` refuses a branch without one,
`node scripts/check-changes.mjs --base origin/main` runs the same check
locally). A change nobody sees — a refactoring, a test, a dependency, the
documentation — still adds one, with the audience `none`.

## Format

`changes/<slug>.md`, frontmatter only, nothing after it:

```markdown
---
audience: teacher     # student | teacher | none
kind: moved           # new | changed | moved | deprecated | removed
en: Evaluation conditions now live in the course **Settings**.
fr: Les conditions d'évaluation se trouvent désormais dans les **Réglages** du cours.
---
```

- **The slug** (the file name) is lower-case words joined by hyphens, and it
  is the entry's identity: once merged it never changes. Rename it and
  `checks` refuses the branch; deleting an entry is allowed.
- **`audience`**: `student` is shown to everyone; `teacher` to teachers and
  admins only; `none` to nobody.
- **`kind`**: `new`, `changed`, `moved`, `deprecated` or `removed`.
- **`en` and `fr`**: both required unless the audience is `none`. One line
  each, at most 300 characters, inline markdown (`**bold**`, `*italic*`,
  `` `code` ``, a link); no raw HTML. A value may be quoted (`"…"` or `'…'`)
  — quote it when it holds ` #`, which otherwise starts a comment.

## Writing an entry

- Write for the person using the platform, in their words: what they can do
  now, or what changed for them. Not how it was built.
- Say where they see it: the screen, the menu, the button, by the name the
  interface gives it in that language.
- No module names, no table or route names, no PR or issue numbers, no
  version numbers.
- One change per entry. A pull request with two visible changes for two
  audiences may add two files.
- A fix is an entry when a user could notice it ("The grade of a retake is
  now the best one, not the last one."); otherwise it is `none`.
