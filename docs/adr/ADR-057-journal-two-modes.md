# ADR-057 — The journal in two modes: in Quiz, or in a GitHub repository

## Status

Accepted (2026-10-01, product owner; `docs/merge/08-decisions.md` D29).
Supersedes D25; amends D24, D27 and [ADR-049](ADR-049-journal-source-github.md):
its body point 2 holds for the GitHub mode only, its addendum points 2 and 7
are replaced. Amended 2026-10-09: ADR-049 is folded into this record (§7, and
the [correspondence table](#correspondence-with-adr-049) at the end).

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
  what "Move to GitHub" commits (§3). Explicit order and nesting are not
  built (see the note at the end of §3).
- **Assets** live in `journal_assets` under a relative path beside the page
  (`images/…`), referenced from the markdown by that relative path, never
  `asset:<id>` (F-JRN-11). Their `blob_sha` is the sha256 of the content,
  still the ETag of N-SEC-13. The set of assets a page references
  (`asset_paths`) is recomputed in the transaction of every save and every
  delete, so an asset of a draft never reaches a student (J1, N-SEC-13).
  Assets are append-only and kept until the journal is removed, like the
  revisions, so a restored revision finds its images again (amended with
  M4-08: no collection).
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
  (VS Code, git). The rules kept from ADR-049 for this mode are §7,
  *GitHub mode*.
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

Not built: the product owner dropped explicit ordering and nesting, the two
mode switches and the copy of a journal (M4-10–M4-13) on 2026-10-08, to be
implemented on demand ([merge progress](../merge/PROGRESS.md)).

### 4. Schema

- `classroom_journals.mode` (`'quiz' | 'github'`). The repository columns
  (`github_repo_id`, `full_name`, `ref`) become nullable under a CHECK:
  set in GitHub mode, null in Quiz mode. Existing rows migrate to
  `github`.
- `journal_pages` gains a `version` (the lock, M4-07). The Quiz-mode
  explicit order among siblings and parent page are columns of their own,
  added by M4-10 (rename, reorder, nest); `parent_path` keeps its meaning,
  the directory of the file.
- A revisions table, one row per Quiz-mode save, ordered by its
  `created_at` (no revision number).

### 5. Access and audit

Every new route goes through `accessibleClassroom` / `staffAccess`
(invariant 6); an impersonation session never writes; `seb` and `kiosk`
sessions never reach the journal. The audit union gains, task by task:
the mode on `journal.create`, the Quiz-mode page writes, `journal.restore`,
`journal.reorder`, `journal.export` (Move to GitHub) and `journal.import`
(Bring back into Quiz). The last three come with M4-10 to M4-13, not built
(see the note at the end of §3).

### 6. Not in the first version

Copying a journal from another classroom of the course (next semester):
later, M4-13.

### 7. The rules kept from ADR-049 (folded 2026-10-09)

ADR-049 was heig-classroom's journal decision (its ADR-015), ported with an
addendum on 2026-09-30. What still holds, by mode:

- **Both modes.**
  - **One journal per classroom** (D03): one `classroom_journals` row per
    classroom, keyed by `classroom_id`; `journal_pages` and
    `journal_assets` keyed by (`classroom_id`, `path`). There is no shared
    copy and no "attach the journal of another classroom". An asset is
    served at `JOURNAL_ASSETS_PATH` (`/app/api/classrooms/:id/journal/assets/*`)
    behind the classroom's own access check.
  - **Rendering happens once, on the server**, when a page is ingested or
    saved, never on read: the reading path carries no markdown library.
    Raw HTML in the markdown is **escaped into visible text**, not
    sanitised (D15): the output is safe by construction. The questions
    keep their own rule (a sanitised allow-list, N-SEC-05).
  - **One renderer, in this repository** (`packages/docrender`): the
    renderer, the page tree, the repository naming and the code tokenizer,
    importable by the API and the web mock; `packages/domain` stays free of
    marked and KaTeX.
  - **Assets** are `bytea`, at most `JOURNAL_ASSET_MAX_BYTES` (5 MB) each
    (D14); in GitHub mode only the ones a page references are downloaded.
  - **Access and the student's exit** (invariants 4 and 6): a
    `readableClassroom` loader; the course's staff read everything, a
    claimed enrollment reads the student view, anyone else gets the 404.
    The student view is the journal's one exit (no draft, no page before
    its `visible_from`, no markdown, blob sha nor warning). The staff get
    the staff payload unless the request asks for the student payload (a
    teacher in the student view, ADR-018), which only narrows; an
    impersonation session (ADR-034) gets the student payload whatever it
    asks.
  - **The defects of heig-classroom's journal stay fixed**: J1, an asset
    reaches a student only if a page visible to students references it;
    J2, an ingestion holds no lock while it reads GitHub: it snapshots the
    row's `version`, fetches outside any transaction, then writes the copy
    in one short transaction that locks the row (`SELECT … FOR UPDATE`) and
    commits only if the `version` is unchanged, bumping it; a stale result
    runs again from a fresh snapshot. The `journal.ingest` queue is a
    standard one, with no deduplication: the compare-and-set is the
    safety (`modules/journal/ingest.ts`, `jobs.ts`); J3, each row has its own root path;
    J4, a ticker sweep (every 60 s) emits the hint when a page's
    `visible_from` passes; J5, warnings are codes with parameters,
    translated in the web app (N-I18N-01); J6, the long-form styles are a
    `.md-body.md-doc` modifier; J7, development runs without webhooks nor a
    queue, with Refresh as its path, and the mock serves rendered HTML
    fixtures.
  - **Removing a journal** removes the classroom's row and the platform's
    copy, never a repository.
- **GitHub mode (§2).**
  - **The repository is the content**: one markdown file per page, the
    repository's layout is the navigation (alphabetical order, numeric
    prefixes for control, `README.md` as a directory's landing page), no
    manifest and no identifier injected into the markdown. Postgres holds
    a rendered copy, never what the teacher edits; a page view is one
    `SELECT`, never a GitHub call, so a GitHub outage leaves the journal
    readable.
  - **Nothing is cloned**: the Contents and Trees APIs only.
  - **Which repositories** (D27): any repository of the classroom's
    organization, through Quiz's own GitHub App (D23; staging has its own).
    The product owner accepted on 2026-09-30 that any member of a course's
    staff can thereby make the App read a repository of the organizations
    linked to that course's classrooms; every choice is audited
    (`journal.*`). Since this record the App writes only the seed
    `README.md` of a repository it creates (and would write the initial
    commit of Move to GitHub, §3).
  - **Creation never adopts an existing repository**: creating a journal
    makes a new repository; choosing an existing one is a separate,
    deliberate action (F-JRN-02, F-JRN-03). Move to GitHub targets a new
    or empty repository only (§3).
  - Two classrooms may name the same repository when both are linked to
    the same organization (D02): each keeps its own copy, and a push
    reaches every row that holds the repository.
  - The course's staff who linked a GitHub account at that moment are
    invited as collaborators when a journal repository is created or
    chosen, with `push` only, never `admin` nor `maintain`, each invitation
    audited; a member who joins the staff or links an account later is not
    invited automatically (F-JRN-02, F-JRN-03). Students never are.

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
- **Content in Postgres, exported to a repository later** (rejected by
  ADR-049 for the journal's single model): two sources of truth and a
  conflict semantics invented after the fact. Quiz mode (§1) adopts it for
  the novice only, with Move to GitHub (§3) as the deliberate export.
- **Cells with identifiers, Notion-style, serialised to markdown**
  (ADR-049): `<!-- cell -->` markers illegible in the repository and
  destroyed by the first hand edit; an editor provides cells without
  persisting them.
- **Rendering on read, in the client** (ADR-049): a markdown parser, KaTeX
  and a sanitiser in every student's bundle, the same page re-rendered on
  every view; rendering at ingestion costs the work once.
- **Cloning the repository to render it** (ADR-049): disk and a git process
  per classroom on a VM that has neither to spare.

## Correspondence with ADR-049

[ADR-049](ADR-049-journal-source-github.md) (heig-classroom's journal,
imported 2026-09-30) was folded here on 2026-10-09. Its body was
classroom's, read through two addenda; code and documents that cite it
resolve as follows. (ADR-049 said in one place that this record replaced
"points 2 and 7" of its first addendum and in another "points 2, 3 and 7":
points 2 and 7 are replaced, point 3 is amended.)

| ADR-049 | This record |
| --- | --- |
| Body point 1 (the repository is the content) | §7, GitHub mode |
| Body point 2 (Postgres is a read model) | §7, GitHub mode; §1 for Quiz mode, where the database is the content |
| Body point 3 (rendered once, on the server; raw HTML escaped) | §7, both modes |
| Body point 4 (nothing cloned) | §7, GitHub mode |
| Body point 5 (writes go to GitHub first, with an optimistic lock) | superseded: GitHub mode is read-only (§2); Quiz mode locks on a page `version` (§1) |
| Body point 6 (creation never adopts) | §7, GitHub mode, and §3 (Move to GitHub); its last sentence (one journal for several classrooms) is dropped |
| Body point 7 (one copy per repository and ref) | dropped: one journal per classroom (§7) |
| Body Consequences (read-only during a GitHub outage; reorder is a rename; assets capped; staff invited) | §7; an explicit order for Quiz mode, §1 |
| Addendum point 1 (one journal per classroom, D03) | §7, both modes |
| Addendum point 2 (set up in Settings, D24) | replaced by the mode choice (Decision, §2) |
| Addendum point 3 (any repository of the organization, D27) | amended: §7, GitHub mode, and Consequences |
| Addendum point 4 (Quiz's own App, D23) | §7, GitHub mode |
| Addendum point 5 (assets in `bytea`, 5 MB, D14) | §7, both modes |
| Addendum point 6 (escaped HTML, D15) | §7, both modes |
| Addendum point 7 (the WYSIWYG editor, D25) | replaced by §1 (the standard editor) and §2 (read-only) |
| Addendum point 8 (one renderer, `packages/docrender`) | §7, both modes |
| Addendum point 9 (access and the student's exit) | §7, both modes; §5 |
| Addendum point 10 (defects J1–J7) | §7, both modes |
| Alternatives considered (content in Postgres, cells with ids, render on read, cloning) | Alternatives considered (the last four) |
| Second addendum (two modes) | this record |
