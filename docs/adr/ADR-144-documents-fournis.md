# ADR-144 — Documents provided: a course library of PDF and Markdown files, read by the students of an evaluation

## Status

Accepted (2026-11-24, product owner in conversation for the product rules;
the orchestrator of the feature for the technical ones, after a spec
challenge and an architect's plan). Delivered in three pull requests: the
library (PR1), a viewer and the staff preview (PR2), the documents an
evaluation provides (PR3). Check the code for what has shipped.

Scope: the `library` module (`apps/api/src/modules/library/`), the table
`course_documents` and the column `courses.documents_quota_bytes` (migration
`0159_course_documents`), the store `ASSETS_DIR/documents/`, the course
page's Documents tab; from PR2 the viewer; from PR3 an evaluation's provided
documents and the player's panel. F-ORG-18, F-ADMIN-10, N-SEC-24.

Relations: amends [ADR-003](ADR-003-postgresql-drizzle.md) §1 (scoped
amendment below); extends the provided tools of an evaluation, after the
calculator ([ADR-069](ADR-069-calculatrice-fournie.md)) and the notepad
([ADR-090](ADR-090-calepin-fourni.md)); reads [ADR-088](ADR-088-journal-d-integrite.md) (the integrity
journal), [ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) (the roles of a course) and [ADR-117](ADR-117-pseudonymisation-d-un-compte-sur-demande.md) (an account is
pseudonymized, never deleted). PR3 amends invariant 4 of `CLAUDE.md`.

## Context

Under Safe Exam Browser or on a kiosk station a student opens nothing but
Quiz. A teacher who wants a datasheet, an extract of a standard or a
formula sheet on the desk of an exam has paper as the only way. Quiz already
holds files: the images of the pools (`assets`, readable by any teacher of
the instance through `/app/api/assets/:id`), the scans of paper copies
(`ASSETS_DIR/paper/`, ADR-125 §15) and the journal's assets. None of them is
a course's material, and the first is deliberately readable instance-wide.

The word *document* is taken in the code: `apps/api/src/documents/`,
`EvaluationDocumentRecord` and `/evaluations/:id/document.*` are the exports
of [ADR-121](ADR-121-fabrique-d-exports.md). The module is therefore named
`library`, its types `CourseDocument` and `CourseLibrary`.

## Decision

### 1. One library per course (product owner)

A course has one library, shown as a **Documents** tab of its page. Not
several vaults, not one per teacher. Any member of the course staff uploads
and renames. A document is deleted by its uploader or by an owner of the
course; anyone else gets `403 owner_required` ([ADR-068](ADR-068-roles-de-l-equipe-du-cours.md)). There is no
"replace": upload the new file, delete the old one. The student's own
material (old labs, notes) is out of scope.

### 2. Quota per course (product owner)

A course's documents share a quota, 100 MiB by default
(`courses.documents_quota_bytes`), raised by an administrator only, up to
10 GiB, from the course's Documents tab: an administrator who reaches the
course (a seat or Super Powers) types it in; there is no administration list
of courses. The same file in two courses is stored once on disk and counts
in full in each course's quota. The check runs inside a transaction that
locks the course row `FOR UPDATE` and sums `bytes`: over the quota is
`409 quota_exceeded { usedBytes, quotaBytes }`. `413` stays the per-file
cap.

### 3. Kinds and sizes, by the bytes (N-SEC-24)

A document is a PDF or a Markdown file, decided by its bytes, never by the
declared type: `%PDF-` is a PDF; otherwise valid UTF-8 without NUL, named
`.md` or `.markdown` and at most 500 kB, is Markdown; anything else `415
document_unsupported`. A file is at most `DOCUMENT_MAX_BYTES` (default
50 MB, at most 100 MB); a Markdown file past 500 kB is `413` with that
limit in the body. No text is extracted from a PDF.

A Markdown document is rendered at upload by `@quiz/docrender`'s
`renderStandalone` (`renderPage` with no page and no asset beside it): raw
HTML shown as text, a relative image becomes its alt text and a warning, an
external one is dropped with a warning; a document carries no image in v1.
The HTML, the table of contents, the warnings and the `RENDERER_VERSION`
are stored; a row rendered by an older version is rendered again from its
file when it is next read. The staff list shows the warnings.

### 4. Its own store, streamed in, never unlinked by a request

The library never reuses the pool's `assets` table nor
`/app/api/assets/:id`. Its files live at
`ASSETS_DIR/documents/<sha256[0:2]>/<sha256>`, rebuilt from the hash,
through the file primitives of `modules/pool/assets.ts`. An upload is
streamed to a temporary file of the same file system while it is hashed,
then renamed into place: a 50 MB upload never sits whole in the memory of
the process that serves live exams. The same bytes uploaded twice in one
course answer `200` with the existing document; the reply never depends on
whether another course holds the same bytes, so an upload learns nothing
of other courses.

A request never unlinks a file. A delete removes the row and sets the
file's time to the server's; the daily task `library.blob_sweep` removes the
files under `documents/` that no row names and whose time is older than
48 hours. The grace covers a delete racing an upload of the same bytes and
a database restored from an older dump.

### 5. Inert files, staff routes (N-SEC-24)

Every route of PR1 is a staff route: `teacherGuard`, then the course
through `accessibleCourse` (invariant 6), a document of another course
being the 404 of a missing one. The file is streamed from disk with one
`Range` (`206`, `416` past the end, a multi-range or malformed header
answered `200` whole), always with `accept-ranges`, `content-length`,
`content-disposition: attachment`, `x-content-type-options: nosniff`,
`cache-control: no-store` and `content-security-policy: default-src
'none'; sandbox` (`sendRanged`, `modules/http.ts`). The audit log records
`course.document_upload`, `course.document_rename`,
`course.document_delete` and `course.documents_quota`.

### 6. The viewer (PR2)

PR2 adds a viewer for both kinds and a staff preview, with the route that
serves a Markdown document's HTML. The PDF viewer is pdf.js, hardened: no
`eval`, no scripting, no XFA, forms and annotation editing off, external
links inert, the worker and its assets served from Quiz's own origin, the
file read in range chunks of 1 MiB. The panel that shows a document is
never an `iframe`.

### 7. Documents provided by an evaluation (PR3, product owner)

- An exam or an exercise may provide documents of its course's library,
  ticked in its advanced options; a poll is refused.
- The selection is frozen like every setting once an attempt exists.
- A document is not deleted while a non-finished evaluation or a template
  of the course references it.
- A copy of an evaluation into another course drops the selection, and
  the copy dialog says so.
- On an exam, the documents are served only for the official attempt
  while the exam runs: not in the lobby, not during a pause, not to a
  blank practice after the release. On an exercise, while an attempt is
  open.
- The student reads them in a panel of the player. Invariant 4 of
  `CLAUDE.md` gains a named exit for provided documents: the student
  reaches a document only through it, under the rules above.
- A copy made from the in-page viewer is one of the page's own copies for
  the integrity journal (ADR-088), as the notepad's is (ADR-090 §6).

### 8. Licensing

The licence of a standard or a datasheet is the teacher's and the school's
responsibility. The platform reminds it at upload, in one line under the
library, and checks nothing.

### 9. Backups, staging and retention

*Scoped amendment of [ADR-003](ADR-003-postgresql-drizzle.md) §1.* The
stateful scope is PostgreSQL **and** the content-addressed file store under
`ASSETS_DIR`, which has been true since the pool's images and the paper
scans. The store is covered by the off-site borg copy and the VM backup, not
by the on-VM database dumps: that is why a document is a file, not a
`bytea` row that would swell every dump.

`scripts/staging-export.sh` leaves `documents/` out of the staging copy:
staging holds the rows without their files, and the Documents tab says
"File missing" on each.

A deleted document leaves the backups on their own schedule (N-DATA-03),
as a deleted paper scan does (open question 64).

### 10. Out of v1

Images in Markdown, replace, text extraction (and so search inside a PDF),
an MCP tool, a line on the System status page.

### 11. Owed before production

pdf.js inside a real Safe Exam Browser on Windows and on macOS with
`SEB_CONFIG_KEY_ENFORCE=1` (its range requests must carry the Config Key
header); on a kiosk station; and a load test of 30 simultaneous searches
in a document.

## Consequences

- A course carries its exam material, and an exam under SEB can hand it
  out without paper.
- The file store grows by up to the sum of the quotas, minus what courses
  share. The borg copy and the VM backup must keep covering `ASSETS_DIR`.
- The upload path holds no file in memory; the sweep is the only code that
  unlinks a document's file.
- Staging cannot open a document of production.
- PR3 adds a third student exit to invariant 4, with its own leak test.

## Alternatives considered

- **The pool's `assets` table and route**: any teacher of the instance can
  read any asset there; a course's licensed standard must not be.
- **Files as `bytea` rows**: every on-VM dump would carry them, and the
  dumps are kept for months.
- **A library per teacher, or several vaults per course**: refused by the
  product owner; the course is the unit its staff shares.
- **Unlinking the file on delete**: races an upload of the same bytes into
  another course, and a restored dump would name files already gone.
- **Extracting the text of a PDF for search**: out of v1; pdf.js searches
  the text layer in the browser.
