# ADR-057 — The journal in two modes: in Quiz, or in a GitHub repository

## Status

Accepted (2026-10-01, decided by the product owner in conversation;
`docs/merge/08-decisions.md` D29). Not implemented yet: task cards M4-07 to
M4-13 of `docs/merge/09-tasks.md`. It supersedes D25 (the journal's WYSIWYG
editor over git). It amends [ADR-049](ADR-049-journal-source-github.md):
point 2 of its body (Postgres is never what a teacher edits) holds for the
GitHub mode only, and points 2 (Settings, enabled once connected) and 7
(the editor) of its addendum are replaced by this decision. D24 and D27
are amended accordingly.

## Context

ADR-049 made the journal a GitHub repository, and D25 asked Quiz's WYSIWYG
editor to write into it without changing a byte the teacher did not edit.
M4-06 (#417) met that condition, at a price:

- `apps/web/src/journal/editor/reconcile.ts` cuts the editor's output into
  blocks and matches them (LCS) against the source, block by block, so an
  unedited block is written back as read;
- `apps/web/src/markdown/journalSchema.ts` and the `journal: true` mode of
  `richTextExtensions` keep the spellings markdown allows twice (`_` and
  `*`, bullet markers, setext headings, raw HTML as atoms…);
- an edited block is still normalised, and the list of accepted
  normalisations is a test of its own.

This is a second editor schema next to the questions' one, and every
markdown construct a teacher writes is a new case for the reconciler. It
passed on five real pages; it is fragile by nature, not by defect. GitLab
abandoned the same approach ("preserve unchanged markdown" in its rich text
editor) in 2025, for the same reason (gitlab-org/gitlab#584484).

The round trip exists only because the browser writes into git. And the
browser writes into git only because the journal must live in a
repository, which means a novice teacher needs a GitHub organisation,
Quiz's App installed on it, and a classroom connected before writing one
page of course notes. The two teachers of ADR-049's context are better
served by two modes than by one mode that has to satisfy both.

## Decision

**A journal has a mode, chosen when it is created: In Quiz, or In a GitHub
repository.** The mode is a segmented control in the Journal section of
the classroom's Settings, each option with a one-line explanation. UI
words: "In Quiz" / "In a GitHub repository" (fr: "Dans Quiz" / "Dans un
dépôt GitHub"); never "local".

### 1. In Quiz (`mode = 'quiz'`, the default, the novice)

- **No GitHub at all**: no connected organisation, no App. A Quiz-mode
  journal exists on a platform without the `GITHUB_*` configuration.
- **The database is the source of truth**: `journal_pages.markdown` and
  `journal_assets.data` are what the teacher edits. Same tables, same
  `@quiz/docrender` pipeline, same student view (invariant 4 unchanged).
- **Edited with the platform's standard Tiptap editor**, as a question
  statement is. Its normalisation of the markdown is accepted: nobody diffs
  it. The round-trip machinery of D25 goes: `reconcile.ts`,
  `journalSchema.ts` and the `journal: true` mode are deleted with the web
  task (M4-09), not before. An image upload hook that inserts a relative
  path stays.
- **Paths are stable, order is explicit.** A page's path is set when it is
  created and never changes when the page moves, so links between pages
  and students' bookmarks stay valid. The order among siblings is a field
  of its own, and nesting is a parent page. Numeric prefixes exist only in
  what "Move to GitHub" commits (§3).
- **Assets** live in `journal_assets` under a relative path beside the page
  (`images/…`), referenced from the markdown by that relative path, never
  `asset:<id>` (F-JRN-11). Their `blob_sha` is the sha256 of the content,
  still the ETag of N-SEC-13. The set of assets a page references
  (`asset_paths`) is recomputed in the transaction of every save and every
  delete, so an asset of a draft never reaches a student (J1, N-SEC-13).
  Assets are append-only and collected when no page references them.
- **Revisions**: one per save, the markdown with its front matter, no
  limit; assets are not versioned. The staff list a page's revisions and
  restore one; a restore is a save, audited. No student route ever reads
  the revision table.
- **Concurrency**: an optimistic lock on a page `version`. A save against a
  stale version is a `409 conflict`; the draft stays in the editor, as
  today.
- **Removing** the journal (F-JRN-04) or deleting the classroom (F-ORG-09)
  destroys the only copy. The confirmation says that the pages are deleted
  and how many; when there are pages, the teacher types the classroom's
  name.

### 2. In a GitHub repository (`mode = 'github'`, the expert)

- **The repository is the content**, edited in the teacher's own tools
  (VS Code, git). ADR-049 holds for this mode as written, with its
  addendum, except for the browser writes.
- **The platform is read-only for it.** No editing in the browser: the
  page, asset and add/delete routes of M4-03 refuse a GitHub-mode journal.
  The push webhook and Refresh update the copy, as today.
- **Edit on GitHub**: each page links to github.com's editor for its file
  on the journal's branch. It is the primary action of the staff bar in
  this mode; Refresh stays secondary.
- Creating a repository and choosing one of the organisation (F-JRN-02,
  F-JRN-03), the collaborator invitations and the `409` of disconnecting a
  classroom that has a journal (D28) concern this mode only.

### 3. Changing mode is an action, never a toggle

- **Move to GitHub**: into a NEW repository, or an EMPTY one, of the
  classroom's organisation (ADR-049 point 6: never adopt). One initial
  commit holds every page and asset; file names get numeric prefixes from
  the explicit order, and relative links are rewritten to match. The
  journal is then in GitHub mode, read-only in the platform.
- **Bring back into Quiz**: the copy becomes the content and the repository
  is detached, never deleted. Before confirming, the teacher sees what is
  left behind (files of the repository the copy does not hold) and that
  the first save will normalise the markdown. This is also the way back
  for the journals that exist today, which migrate to GitHub mode.
- Writes are frozen while a switch runs.

### 4. Schema

- `classroom_journals.mode` (`'quiz' | 'github'`). The repository columns
  (`github_repo_id`, `full_name`, `ref`) become nullable under a CHECK:
  set in GitHub mode, null in Quiz mode. Existing rows migrate to
  `github`.
- `journal_pages` gains a `version` (the lock) and, for Quiz mode, an
  explicit order among siblings and a parent.
- A revisions table, one row per Quiz-mode save.

### 5. Access and audit

Every new route goes through `accessibleClassroom` / `staffAccess`
(invariant 6); an impersonation session never writes; `seb` and `kiosk`
sessions never reach the journal. The audit union gains, task by task:
the mode on `journal.create`, the Quiz-mode page writes, `journal.restore`,
`journal.reorder`, `journal.export` (Move to GitHub) and `journal.import`
(Bring back into Quiz).

### 6. Not in the first version

Copying a journal from another classroom of the course (next semester):
later, M4-13.

## Consequences

- A novice writes course notes with no GitHub, no App and no connected
  classroom, in the editor they already know from question statements.
- The platform has one markdown editor again. About 800 lines of
  reconciler, journal schema and round-trip tests leave the web app.
- The expert keeps the repository as it is, untouched by the platform: no
  normalisation can ever reach a file, since the platform never writes one.
- The accepted risk of D27 shrinks: Quiz's App no longer writes into a
  journal repository from the browser. It still writes a seed `README.md`
  on creation and the initial commit of Move to GitHub, both into a
  repository that is new or empty.
- In Quiz mode the database holds the only copy. Backups (N-DATA-03)
  cover it like answers and gradings; deletion is irreversible, hence the
  typed confirmation.
- Revisions grow without limit. They are markdown only, a few kilobytes per
  save; a cap can come later without a migration of its meaning.
- The staff bar's primary action depends on the mode: Edit in Quiz mode,
  Edit on GitHub in GitHub mode. Students see no difference.

## Alternatives considered

- **Keep the Tiptap editor and harden the reconciler.** It works on the
  corpus we have, but every construct a teacher writes is a new case, the
  second schema stays forever, and the novice still needs GitHub. GitLab
  tried this and stopped.
- **A source-first editor with live preview (CodeMirror, as Obsidian
  does).** Byte-exact by construction, but the novice edits markdown
  syntax, and it is a second editor beside the questions' Tiptap.
- **Lexical with an mdast bridge.** A third editor framework; it moves the
  round-trip problem into another serialiser instead of removing it.
