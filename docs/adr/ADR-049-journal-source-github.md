# ADR-049 — The classroom journal: GitHub holds the content, Postgres holds a read model

## Status

For current journal behavior read [ADR-057](ADR-057-journal-two-modes.md)
first. Quiz-mode writes/revisions and GitHub read-only mode are implemented;
rename/reorder/nest and mode switches remain M4-10–M4-13. See
[merge progress](../merge/PROGRESS.md), `modules/journal/quiz.ts` and
`modules/journal/mode.ts`. The imported body is rationale, subject to both
addenda; it is not an instruction to restore browser writes into GitHub.

**Imported from heig-classroom** (2026-09-30, merge task M0-03, ADR-035),
where it is ADR-015 — Quiz's own ADR-015 is browser run and server grade,
so it takes the next free number, 049. The body below is classroom's,
verbatim. Read it with the renames of the merge: *assignment* ⇒
**project** ("assignment provisioning" is project provisioning); "the
quiz" and `~/heig-quiz` ⇒ this repository. **The port differs from the
body on the points of the [addendum](#addendum-2026-09-30-how-quiz-ports-it)
at the end** (one journal per classroom, no shared mirror, no attach of
another classroom's journal, Quiz's own GitHub App, the WYSIWYG editor
from the start, the defects J1–J7 fixed): where the body and the addendum
disagree, the addendum is the decision for Quiz.

**Amended by [ADR-057](ADR-057-journal-two-modes.md) (2026-10-01)**: a
journal has a mode, In Quiz or In a GitHub repository. Point 2 of the body
holds for the GitHub mode only; points 2 and 7 of the addendum are
replaced (see [the second addendum](#addendum-2026-10-01-two-modes-adr-057)).

Status in heig-classroom: Accepted (2026-09-27, issue #45). Reading, writing and ingestion implemented on the same day;
the rich WYSIWYG editing surface is deferred, see "Consequences".

## Context

A classroom needs a place for course material — lecture notes, code examples, figures,
formulas, handouts. Until now the only content a classroom carried was its assignments, so
everything else lived outside the platform and students had two addresses for one course.

The platform already stores plenty *about* repositories: their provisioning state, their head
commit, their grades. The journal is the first time it would store **content**, and that
raises a question the rest of the product never had to answer: where does a page actually
live?

Two teachers were in the room, and they are not the same person:

- the one who wants a Notion-like editor and does not care that there is a git repository
  under it;
- the one who would rather clone the thing, write in their own editor, and push.

Serving only the first is what Moodle does, and it locks the material inside the platform.
Serving only the second is a static-site generator, which the students would have to be sent
to. Serving both from two content models would be two sources of truth and a merge problem.

## Decision

**The journal is a private GitHub repository of the classroom's organization. GitHub is
authoritative for the content; Postgres holds a rendered read model, rebuilt from a push or
from a browser save.**

1. **The repository is the content.** One markdown file per page, the repository's own layout
   is the navigation (MkDocs-style: alphabetical order, numeric prefixes for control,
   `README.md` as the landing page of a directory). No manifest file, no cell records, no
   identifiers injected into the markdown — a file a human edits in `vim` must stay a file a
   human edits in `vim`.
2. **Postgres is a read model, never the thing a teacher edits.** `journal_pages` holds the
   markdown, the rendered HTML, the table of contents and the blob sha it was rendered from.
   A page view is one `SELECT` and never a GitHub call, which is what makes the feature
   affordable on a 1 vCPU / 2 GB VM shared with the production database.
3. **Rendering happens once, at ingestion, on the server.** The reading path carries no
   markdown library at all. Raw HTML in the markdown is **escaped into visible text** rather
   than sanitised, so the output is safe by construction and the image needs no DOM-based
   sanitiser.
4. **Nothing is cloned server-side.** The Contents and Trees API only. Assignment provisioning
   shells out to `git` into a temporary directory, which is right for pushing a history; a
   journal only needs single files and one tree listing.
5. **Writes go to GitHub first, with an optimistic lock.** The blob sha the editor opened the
   page at travels with the save; GitHub answers 409 if someone pushed in between. The platform
   never compares contents and never merges: the loser of a race is told, and their draft is
   kept in their browser.
6. **Creation never adopts an existing repository.** `provisionStudentRepo` treats a 422 as
   "step already done" and adopts, which is right for a repository it alone writes to. Here it
   would hand a classroom whatever material sat under that name. Attaching an existing
   repository is a separate, deliberate action — and it is also how one journal serves several
   classrooms.
7. **One mirror per (repository, ref).** Two classrooms sharing a journal share the row; a
   classroom pinned to last semester's branch gets its own row on the same repository.

## Alternatives considered

- **Content in Postgres, with an export to a repository later.** Cheaper to write, and wrong
  in the long run: retrofitting git-as-truth onto database-as-truth means two sources of truth
  and a conflict semantics invented after the fact. If git is the destination, going there
  first is the cheaper path.
- **Cells with identifiers, Notion-style, serialised to markdown.** The "cells" of the feature
  request are an *editing* affordance, and an editor provides them without persisting them.
  Serialising them would mean `<!-- cell:a3f -->` markers throughout the file: illegible in the
  repository and destroyed by the first hand edit.
- **Rendering on read, client-side.** It would put a markdown parser, KaTeX and a sanitiser in
  the bundle of every student and re-render the same page on every view. Rendering at ingestion
  costs the same work once per push.
- **Cloning the repository to render it.** Disk and a git process per classroom on a VM that
  has neither to spare.

## Consequences

- A GitHub outage degrades the journal to **read-only** instead of breaking it: the mirror
  answers every read.
- The rendering pipeline is a **second markdown implementation** in the organization, next to
  the one in `~/heig-quiz`. The pure pieces are shared by copy (`codeHighlight.ts` is vendored
  into `packages/domain`), the rest is not. This is accepted, with the seam named: the editing
  component takes `value` / `onChange` / `onUploadImage`, which is exactly the shape of the
  Tiptap surface of the quiz. Vendoring that surface requires decoupling it *there* first, in
  another repository, so this change ships the source editor plus a server-rendered preview and
  leaves the WYSIWYG one to a follow-up.
- Reordering a page is a **rename**, because the order lives in the file names. Steps of ten
  make it rare; when it happens the Trees API applies it as one commit.
- A repository is a poor blob store: every revision of an image stays in it forever. Assets are
  capped at 5 MB, and only the ones a page actually references are downloaded and cached.
- The staff must be collaborators on the journal repository for the expert path to work. The
  platform invites them; students never are — the repository is private and the platform is its
  only reader.

## Addendum (2026-09-30): how Quiz ports it

The decision above — GitHub holds the content, Postgres a rendered read
model, rendering once on the server, no clone, writes to GitHub first with
an optimistic lock, raw HTML escaped — is ported as it stands. What differs
was settled by the product owner on 2026-09-30
(`docs/merge/08-decisions.md`); the plan is `docs/merge/04-journal.md`.
Where the body and this addendum disagree, this addendum is the decision
for Quiz.

1. **One journal per classroom, and a journal is a repository (D03).**
   Points 6 (its last sentence) and 7 are dropped: there is no shared
   mirror and no "attach the journal of another classroom". The model is
   one `classroom_journals` row per classroom (primary key `classroom_id`,
   with `github_repo_id`, `full_name`, `ref`, `root_path`,
   `last_commit_sha`, `sync_status`, `sync_error`, `created_by`), and
   `journal_pages` and `journal_assets` are keyed by `(classroom_id, path)`.
   A teacher may point two classrooms at the same repository, provided
   both are linked to the same organization (D02); each classroom then
   keeps its own mirror, and a push fans out to every row holding that
   repository. Routes lose the journal id: an asset is served at
   `/app/api/classrooms/:id/journal/assets/*`, behind the classroom's own
   access check. The first half of point 6 holds: creation never adopts
   an existing repository.
2. **Where it is set up: the classroom's Settings (D24).** Its Journal
   section, enabled once the classroom is connected to an organization,
   creates a journal repository, chooses an existing repository of the
   organization (what "attach" was), or removes the journal — the
   classroom's row and its mirror, never the repository. There is no
   separate switch: the classroom has a journal exactly when it has a
   repository, and the Journal tab exists exactly then.
3. **Which repositories (D27): any repository of the classroom's
   organization**, as in classroom. Combined with D04 (staff widened from
   the classroom to the whole course), this means **any staff member of a
   course can make Quiz's App read and write any repository of the
   organizations linked to that course's classrooms** (by choosing it as
   a classroom's journal, then editing in the browser), whatever their own
   rights on GitHub. The product owner accepted this risk (2026-09-30). It
   is mitigated by the audit trail — every choice and every write is
   audited (`journal.*`, in Quiz's closed union) — and by the commits
   being authored as the teacher who made them.
4. **Quiz's own GitHub App (D23).** The journal reads and writes through
   Quiz's App, not classroom's; a separate staging App serves a test
   organization. The journal therefore goes live in Quiz's production
   when it ships, for each classroom whose teacher connects it, before
   the cutover. At the cutover classroom's journals become rows as in
   point 1 (a journal attached to several classrooms becomes several
   rows) and are re-ingested through Quiz's App
   (`docs/merge/02-data-and-migration.md`).
5. **Asset storage (D14)**: `bytea`, at most 5 MB per asset, a read model
   rebuilt from the repository — the body's choice, confirmed.
6. **HTML (D15)**: the journal keeps its rule (raw HTML escaped into
   visible text, point 3); Quiz's questions keep theirs (a sanitised
   allow-list, N-SEC-05). Each surface keeps its rule.
7. **The editor (D25)** reverses the "deferred" of the Consequences: the
   journal is edited with Quiz's WYSIWYG markdown editor (Tiptap,
   `apps/web/src/markdown/`) from its first version, with its source mode
   beside it. Conditions, each a test: a round trip (markdown ⇒ editor ⇒
   markdown, no edit) over classroom's production journals changes
   nothing but documented whitespace; front matter (`title`, `date`,
   `draft`, `visible_from`) is kept out of the editor and edited as
   fields; an image is committed into the repository and inserted with a
   relative path, never as `asset:<id>`; relative links between pages and
   KaTeX survive; a page that was not edited is never written. If the
   round trip fails on real journals, the source editor ships first and
   the gap is reported.
8. **One renderer, in this repository.** The "second markdown
   implementation" of the Consequences now lives beside Quiz's own: the
   renderer, the tree, the repository naming and the code tokenizer move
   to a pure package (`packages/docrender`), importable by the API and
   the web mock, so the tokenizer is shared rather than vendored.
   `packages/domain` stays free of marked and KaTeX.
9. **Access and the student's exit.** A `readableClassroom` loader
   (invariant 6): the course's staff read everything, a claimed
   enrollment reads the student view, anyone else gets the 404. The
   student view is the journal's one exit (no draft, no page before its
   `visible_from`, no markdown, blob sha nor warning). The staff get the
   staff payload unless the request asks for the student payload (a
   teacher in the student view on their staff seat, ADR-018); that
   parameter can only narrow, never widen. An impersonation session
   (ADR-034) gets the student payload whatever it asks (spec 05 §5.7).
10. **The defects found in classroom's journal are fixed in the port**
    (`docs/merge/04-journal.md` §4.3):
    - **J1** — an asset is served to a student only if a page visible to
      students references it (classroom checks membership only, so assets
      of drafts and not-yet-visible pages leak).
    - **J2** — every ingestion goes through the queue or under an advisory
      lock per classroom row, and the mirror is written in one
      transaction. A dedupe needs a queue policy chosen at queue creation
      (a `singletonKey` dedupes nothing on a `standard` pg-boss queue,
      quiz #273), the in-process queue included.
    - **J3** — `attach` ignoring `rootPath` on a reused mirror disappears
      with point 1: no mirror is shared, each row has its own root path.
    - **J4** — a ticker sweep (every 60 s, on the bare ticker) emits the
      SSE hint when a page's `visible_from` passes.
    - **J5** — warnings are codes with parameters, translated in the web
      app (N-I18N-01), not server-built English sentences.
    - **J6** — the long-form styles are a `.md-body.md-doc` modifier, so
      they do not collide with the question prose styles.
    - **J7** — development runs without webhooks nor pg-boss: Refresh is
      the development path, and the mock serves rendered HTML fixtures.

## Addendum (2026-10-01): two modes (ADR-057)

The authoritative mode decision is [ADR-057](ADR-057-journal-two-modes.md):
read its §§1–3 for storage, editing and migration between modes. It amends
this record's body point 2 and the first addendum's points 2, 3 and 7.
The remaining port rules and security fixes J1–J7 still apply.
