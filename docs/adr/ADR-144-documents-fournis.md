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

Relations: amends [ADR-003](ADR-003-postgresql-drizzle.md) §1 and
[ADR-110](ADR-110-version-du-client-apres-un-deploiement.md) §1–2 (scoped
amendments below); extends the provided tools of an evaluation, after the
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

A course's documents share a quota, 100 MB by default
(`courses.documents_quota_bytes`), raised by an administrator only, up to
10 GB, from the course's Documents tab: an administrator who reaches the
course (a seat or Super Powers) types it in; there is no administration list
of courses. The same file in two courses is stored once on disk and counts
in full in each course's quota. The check runs inside a transaction that
locks the course row `FOR UPDATE` and sums `bytes`: over the quota is
`409 quota_exceeded { usedBytes, quotaBytes }`. `413` stays the per-file
cap. Every size is in decimal units, as the interface shows them: 1 MB is
10^6 bytes.

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
are stored; a row rendered by an older version is rendered again, from
its file, by the library's daily task (`library.blob_sweep`), never by a
read. The staff list shows the warnings.

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
a database restored from an older dump. The delete sets the time before it
removes the row, and the sweep re-checks each file under a transaction-level
advisory lock on its hash, the lock an upload takes before it places the
file and inserts its row: a file an upload is about to name is never
removed under it.

A course's deletion takes its rows by the foreign key's cascade and does
not touch the files: they leave at the next sweep, without the 48-hour
grace (their time is their upload's). Accepted: a course's deletion is
rare, confirmed, and refused while its students have work
([ADR-141](ADR-141-refus-de-supprimer-le-travail-des-etudiants.md)).

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

PR2 adds a viewer for both kinds (`apps/web/src/documents/`) and a staff
preview: a document's title opens it in the app's expand layer. The viewer
takes a URL or HTML and knows nothing of courses, so PR3 mounts it with the
attempt's routes. A Markdown document's HTML is the one stored at upload,
served by `GET …/documents/:documentId/html` (`DocumentHtml`, the library's
guards; a PDF has none, the 404 of a missing document).

The PDF viewer is pdf.js, pinned, hardened:

- **Legacy build.** The modern one needs Safari 18; Safe Exam Browser on
  macOS runs the system's WebKit. The legacy build polyfills what it uses
  but `Promise.withResolvers` and `AbortSignal.any` (Safari 17.4): the
  viewer installs those two, in the page before pdf.js and in the worker
  before pdf.js's own code, which reaches the app's Safari 16.4.
- **No script.** No `eval` (pdf.js 6 has none left; the CSP refuses one),
  no document script (no scripting manager), no XFA, forms and annotation
  editing off; external links inert, internal links and the outline
  navigate.
- **Our origin only.** The worker is a build asset of Quiz's origin (a
  module worker, never `blob:`); the character maps, standard fonts, ICC
  profiles and decoders are copied under `/pdfjs/<pdf.js version>/`, and
  the viewer asks for the folder of the version it loaded. `useSystemFonts`
  is off: a font a PDF does not embed comes from those standard fonts, so
  a page reads the same on every machine. *Scoped amendment of ADR-110
  §1–2*: `pdfjs/` is kept across deploys and cached like `assets/` (its
  files never change under their version), so a tab opened before an
  upgrade of pdf.js keeps its worker and its own data.
- **Ranges.** `disableAutoFetch`, `disableStream`, chunks of 1 MiB: only
  what the pages on screen or a search need. pdf.js merges adjacent chunks
  into one request, and reads a file of 2 MiB or less in one request.

- **Links navigate nothing.** No link of a document, PDF or Markdown,
  keeps an `href` or a `target`: a click, a middle click, the context menu
  or a drag opens nothing, and a web address shows itself as a tooltip. A
  link within the document (a heading, a page, an outline entry) stays a
  keyboard link and moves the viewer.
- **A copy is the page's.** The viewer is never an `iframe`, and a copy
  made in it is one of the page's own copies (ADR-088): the viewer takes
  the copy from pdf.js's text layer, so the clipboard gets the selection as
  the journal reads it and the event reaches the journal's listeners, and
  pdf.js's "copy all" (a hidden element and a document-wide listener that
  writes the whole PDF's text after Ctrl+A) is taken out of the page.
- **Ids are the viewer's.** A Markdown document's ids are prefixed per
  viewer, so a heading never collides with an id of the page, nor with one
  of another document mounted beside it.

### 7. Documents provided by an evaluation (PR3, product owner)

- An exam or an exercise may provide documents of its course's library,
  at most 10, ticked in its advanced options; a poll is refused. The
  evaluation's conditions ([ADR-079](ADR-079-conditions-de-l-evaluation.md))
  gain an imposed line of kind *provided* naming them.
- The selection is frozen like every setting once an attempt exists.
- A document is not deleted while a non-finished evaluation or a template
  of the course references it.
- A copy of an evaluation into another course drops the selection, and
  the copy dialog says so.
- On an exam, the documents are served only for the official attempt
  while the exam runs; on an exercise, while an attempt is open. "Not in
  the lobby, not during a pause, not to a blank practice after the
  release" is the orchestrator's reading of the owner's "nothing
  afterwards", stated to the product owner on 2026-11-24 and not objected
  to.
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

`scripts/staging-export.sh` leaves `documents/` out of the staging copy to
save disk, the staging copy living on the same VM; it hides nothing:
staging keeps the rows, so a Markdown document's rendered HTML is there
like any other course content, and each document reads "File missing".

A deleted document leaves the backups on their own schedule (N-DATA-03),
as a deleted paper scan does (open question 64).

### 10. Out of v1

Images in Markdown, replace, text extraction at upload (a warning for a
scanned PDF, a search across documents), an MCP tool, a line on the System
status page. Searching inside one PDF is in v1: the viewer searches its
text layer.

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
- Staging holds production's document rows, rendered Markdown included,
  but not their files: a PDF cannot be opened there.
- PR3 adds one more student exit to invariant 4, with its own leak test.

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
