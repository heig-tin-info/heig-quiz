# 4. The journal

The journal is a classroom's course documentation, written by the staff,
read by the students. It is **not an activity**: no assessment, no
tracking, no deadline. Classroom commit `ab98cc0` (52 files, +10 044 lines),
classroom ADR-015 (imported as [ADR-049](../adr/ADR-049-journal-source-github.md),
with an addendum on how the port differs). Since 2026-10-01 a journal has
two modes ([ADR-057](../adr/ADR-057-journal-two-modes.md), D29, §4.5):
§4.1 to §4.3 describe the GitHub mode, which the port shipped first.

## 4.1 How it works

**GitHub is the source of truth**: a private repository in the classroom's
organization, one markdown file per page. The layout is the navigation,
MkDocs-style (`C:packages/domain/src/journalTree.ts`): pages sorted by raw
file name with numeric prefixes in steps of ten (never displayed);
`README.md` is the landing page of its directory; a directory without one
is a non-navigating heading; the title comes from front matter `title`, else
the first `#` heading, else the prettified file name; links are relative,
so the same markdown reads correctly on github.com. Front matter: `title`,
`date`, `draft: true` (staff only), `visible_from` (hidden from students
until then). Broken YAML ⇒ a warning, the page still renders.

**Postgres is a read model.** A page view is one SELECT, never a GitHub
call: a GitHub outage leaves the journal readable. Nothing is cloned: the
Trees, Blobs and Contents APIs through the installation token
(`C:journal/repo.ts`: `readTree`, `readBlob`, `putFile`, `deleteFile`,
`commitMoves`, `createJournalRepo`, `resolveRepo`).

| Table | Key columns | Role |
| --- | --- | --- |
| `journals` | `org_id`, `github_repo_id`, `full_name`, `ref`, `root_path`, `last_commit_sha`, `sync_status` (pending/ok/error), `sync_error` | one mirror per (repo, ref); unique on `(github_repo_id, ref)` and `(lower(full_name), ref)` |
| `classroom_journals` | PK `classroom_id`, `journal_id`, `attached_by` | attachment; several classrooms may share a journal |
| `journal_pages` | unique `(journal_id, path)`, `parent_path`, `sort_key`, `title`, `front_matter`, `blob_sha`, `markdown`, `html`, `toc`, `draft`, `visible_from`, `warnings` | rendered mirror |
| `journal_assets` | unique `(journal_id, path)`, `blob_sha`, `content_type`, `size`, `data bytea` | referenced assets only, ≤ 5 MB each |

**Ingestion** (`C:journal/ingest.ts`): list the tree → fetch changed blobs →
re-render every page (links depend on neighbours) → upsert and delete pages
→ download changed referenced assets, drop unreferenced → set
`last_commit_sha`, `sync_status=ok` → SSE hint `journal` to every attached
classroom. Triggers: the push webhook (`journal.ingest`, singleton per
journal in heig-classroom — see the note under J2 —, skipped when
`after == last_commit_sha`), a synchronous re-ingest
after each browser write, the staff Refresh button, the `repository`
webhook (renamed ⇒ follow; deleted ⇒ `sync_status=error`, pages kept).

**Writes** go to GitHub first with the `baseSha` the editor opened as an
optimistic lock: a concurrent push ⇒ 409, never merged, the draft kept.
Commits are authored as the teacher. Creation never adopts an existing
repository on a name clash (it proposes a deterministic alternative);
**Attach** (same org) is a separate explicit action — how one journal is
shared between classrooms or semesters. Both invite the staff who have a
linked GitHub login as collaborators.

**Rendering** happens on the server, once per ingestion
(`C:journal/render.ts`): marked 18 (GFM), KaTeX (`trust:false`,
`throwOnError` ⇒ a warning + `<code class="md-math-error">`), `yaml`.
**Raw HTML is escaped into visible text** (safe by construction, no
DOMPurify). Images: repository paths only, served at
`/app/api/journals/<jid>/assets/<path>`; external images dropped (alt kept,
warning). Links: anchors kept; external `http(s)`/`mailto` in a new tab with
`noreferrer`; relative `.md` ⇒ in-app href; other relative files ⇒ asset
URL; unresolvable ⇒ text only (no path for `javascript:`). Unique heading
ids, stored TOC, code fences coloured by a tokenizer copied from Quiz
(`Q:apps/web/src/markdown/highlight.ts`). Preview reruns the same renderer.
The student bundle carries no markdown library (journal chunk: 13 kB).

**Access** (`readableClassroom`, `C:modules/guards.ts`): staff ⇒
`staff: true`; a claimed enrollment ⇒ `staff: false`; anyone else ⇒ 404.
`staff: false` hides drafts, future `visible_from` pages (DB `now()`), the
markdown, blob sha, warnings and hidden counts. Asset route: ETag = blob
sha, `private, max-age=0, must-revalidate`, CSP `default-src 'none';
style-src 'unsafe-inline'`, `nosniff`. `safeJournalPath` rejects `..`,
leading `/`, backslashes, control characters, > 400 characters.

**Routes** (base `/app/api/classrooms/:id/journal`): `GET base` (tree, home
path, repo info), `GET base/pages/*`; staff: `POST base` (create repo with
seed README, attach, invite, ingest), `POST base/attach`, `DELETE base`
(detach; drop the mirror if unread), `POST base/refresh`,
`POST base/preview`, `PUT base/pages/*` (save with `baseSha`),
`POST base/pages`, `DELETE base/pages/*`, `POST base/assets/*` (raw ≤ 5 MB,
content type matches the extension); `GET /app/api/journals/:jid/assets/*`.
Plumbing: `/webhooks/github` dispatch, queue `journal.ingest`, SSE family
`journal` (classroom-wide), nine audit actions `journal.*` (in the port,
all of them staff writes of M4-03: the ingestion, the webhooks and the J4
sweep audit nothing, their outcome is the row's sync state).

## 4.2 What the port requires

- **One journal per classroom, a journal is a repository** (D03). The
  shared mirror and the attachment table collapse into one row per
  classroom; two classrooms on the same repository (same organization)
  each keep their own mirror, and a push fans out to every classroom row
  holding that repository:

  | Table | Key columns |
  | --- | --- |
  | `classroom_journals` | PK `classroom_id`, `github_repo_id`, `full_name`, `ref`, `root_path`, `last_commit_sha`, `sync_status`, `sync_error`, `created_by` |
  | `journal_pages` | unique `(classroom_id, path)`, the columns of §4.1, with `html` split in two (below) and `asset_paths` (the assets the page references, for J1) |
  | `journal_assets` | unique `(classroom_id, path)`, the columns of §4.1 |

  **Two renderings per page** (orchestrator, on the invariant review of
  M4-01): `html_staff` is rendered with every page linkable, `html_student`
  with only the pages visible to students at render time (not a draft,
  `visible_from` null or passed); in `html_student` a link to a hidden page
  is plain text, so the HTML a student receives never names a draft or a
  future page (N-SEC-12). Warnings, title, TOC and assets come from the
  staff rendering. Both are rendered by `renderPage` of
  `packages/docrender`, from the stored markdown (without NUL,
  `cleanSource`), so re-rendering needs no GitHub call.

  Routes lose the journal id: assets are served at
  `/app/api/classrooms/:id/journal/assets/*`, behind the classroom's own
  access check. "Attach" becomes "choose a repository of the
  organization" (the classroom's Settings, D24); "Detach" removes the
  classroom's row and its mirror, never the repository. As ported (M4-03):
  `POST base/use` replaces `POST base/attach`, `DELETE base` removes, and
  the nine audit actions are `journal.create|use|remove|refresh|save|add|delete|upload|invite`
  (the routes and their refusals: card M4-03, "As delivered").
- **Module** `Q:modules/journal/` (routes, service, ingest, render wiring,
  repo, events, jobs), schema `Q:db/journal.ts`; tests ported as
  `*.db.test.ts` (ingest, journal) and unit (render, tree).
- **A pure renderer package.** `renderPage`, `journalTree`, `repoName` and
  the code tokenizer move to a new pure package (suggested
  `packages/docrender`), importable by the API and the web mock; this also
  removes the duplicated highlighter. `packages/domain` stays free of
  marked/KaTeX. Keep the server-side design (small student bundle, survives
  a GitHub outage).
- **Prerequisites from the GitHub side**: `github_organizations` with the
  installation, account linking (staff invitations), the webhook handler
  registry (M2-04), the classroom↔org link (the GitHub section of the
  classroom's Settings, D24).
- **Access (invariant 6)**: a `readableClassroom` loader in
  `Q:modules/guards.ts` — staff = `staffAccess(user, classroom.course_id)`;
  student = an enrollment with `user_id = me`. This is Quiz's first
  student-readable classroom route: the staff get the staff payload
  unless the request asks for the **student payload** (a teacher in the
  student view on their staff seat, ADR-018), a parameter that can only
  narrow, never widen; an impersonation session (ADR-034) gets the student
  payload whatever it asks (spec 05 §5.7; classroom hides the teacher's
  buttons in student view but still returns drafts).
- **Contracts (invariant 7)**: zod bodies and payloads in
  `packages/contracts/src/journal.ts` (classroom declared TS interfaces and
  inline zod).
- **i18n**: warnings become codes with parameters, translated on the web
  side; every teacher string through `t()`.

## 4.3 Defects found in classroom's journal (fix in the port)

| # | Defect | Fix |
| --- | --- | --- |
| J1 | Assets of draft or not-yet-visible pages are readable by any enrolled student (the asset route checks membership, not the referencing page's visibility) | serve an asset to a student only if a page visible to students references it |
| J2 | Concurrent ingestions: `singletonKey` dedups queued jobs only; save and Refresh call `ingestJournal` directly; mirror writes not transactional | every ingestion through the queue or under an advisory lock per classroom journal row; `mirror()` in one transaction |
| J3 | `attach` ignores `rootPath` when it reuses an existing (repo, ref) mirror | disappears with D03: no mirror is shared, each classroom row has its own root path |
| J4 | No SSE hint when `visible_from` passes | a ticker sweep (`everyMs` 60 s, on the bare ticker) that, when a page becomes visible, re-renders the `html_student` of every page of that classroom's journal from the stored markdown (no GitHub call: links to the newly visible page appear) and emits the hint |
| J5 | Warnings are server-built English sentences | codes + parameters |
| J6 | `.md-body` collides with Quiz's question prose styles | `.md-body.md-doc` modifier (long-form: h1 28 px, 72-ch measure, 1.75 leading) |
| J7 | Quiz dev runs on PGlite without webhooks nor pg-boss | Refresh is the dev path; the mock serves rendered HTML fixtures |

As ported (M4-02, after review): `journal.ingest` is a `standard` queue
with no dedupe, and J2 is optimistic, with no lock held while GitHub is
read. (1) A snapshot: the row's `version`, the stored pages' blob shas and
markdown, the cached assets' shas. (2) Outside any transaction: the head,
the tree, the blobs that moved, every page rendered, each GitHub call
bounded (no retry, no rate-limit wait, 30 s; a rate limit or a timeout is
`github_unavailable`, retried by the queue). (3) One short transaction:
`SELECT … FOR UPDATE` on the `classroom_journals` row, the copy written
only if `version` is unchanged, `version + 1`. A failure is its own
compare-and-set on `version`. Every writer of the row bumps `version` (an
ingestion, its failure, a rename, a deletion), so a result built from a
stale snapshot is never committed: the ingestion runs once more from a
fresh snapshot, then re-sends its job. The J4 sweep locks the row with
`FOR UPDATE SKIP LOCKED` and skips a journal being written; it bumps
nothing, since an ingestion re-renders every student page when it writes.

Note on J2 (quiz #273): in pg-boss 12 a `singletonKey` without
`singletonSeconds` dedupes nothing on a `standard` queue, which is what a
queue created with no policy is, and a policy cannot be changed after
creation. Quiz's `SendOptions` (`apps/api/src/jobs.ts`) no longer offers
`singletonKey`. A port that needs a dedupe must choose a queue policy
(`singleton`, `stately`, …) in `createQueue`, and add it to the in-process
queue too, so that development and production behave alike.

## 4.4 Decisions (in `08-decisions.md`)

- D03 — one journal per classroom, a journal is a repository (settled).
- D14 — asset storage: `bytea`, a rebuildable read model (settled).
- D15 — HTML policy: the journal escapes raw HTML; Quiz questions sanitise
  an allow-list (N-SEC-05); each surface keeps its rule (settled).
- D25 — the editor is Quiz's WYSIWYG (Tiptap) from the start, with its
  source mode, under a byte-exact round trip (settled, met by M4-06;
  **superseded by D29**).
- D29 — the journal's two modes (settled 2026-10-01, ADR-057, §4.5).

## 4.5 Two modes (ADR-057, D29)

A journal's `mode` is chosen at its creation, in the Journal section of
Settings ("In Quiz" / "In a GitHub repository"). Same tables, same
`@quiz/docrender` pipeline, same student view in both.

| | In Quiz (`quiz`, the default) | In a GitHub repository (`github`) |
| --- | --- | --- |
| Needs | nothing: no organisation, no App | a connected classroom, Quiz's App |
| Content | `journal_pages.markdown`, `journal_assets.data` | the repository; the tables are a copy |
| Editing | the platform's standard Tiptap editor (normalisation accepted), front matter as fields | the teacher's tools; the platform is read-only, each page links to "Edit on GitHub" (primary action of the staff bar; Refresh secondary) |
| Update path | a save, in one transaction | push webhook, Refresh (§4.1) |
| Order | stable path, explicit order among siblings, parent page | file names, numeric prefixes (§4.1) |
| History | a revision per save (markdown + front matter, no limit) | the repository's |
| Lock | page `version`, `409 conflict` keeps the draft | none: nothing is written |
| Remove | deletes the only copy: typed confirmation with pages | drops the copy, keeps the repository |

**Schema** (M4-07, one additive migration):

- `classroom_journals.mode` (`quiz` | `github`); `github_repo_id`,
  `full_name`, `ref` nullable under a CHECK (set in `github`, null in
  `quiz`). Existing rows become `github`.
- `journal_pages`: a `version` (the save's lock) and, for Quiz mode, an
  explicit order among siblings and a parent page (the path is set at
  creation and never changes). The exact columns are M4-07's choice.
- `journal_page_revisions`: one row per Quiz-mode save (`classroom_id`,
  `path`, `revision`, `markdown`, `created_by`, `created_at`). No student
  route joins it; the student-exit tests search for a former revision's
  content.
- Assets in Quiz mode: a relative path beside the page (`images/…`),
  `blob_sha` = sha256 of the bytes (the ETag of N-SEC-13); `asset_paths`
  recomputed in the transaction of every save and delete (J1);
  append-only, collected when no page references them.

**What goes.** The browser's writes into a repository (M4-03's save, add,
delete and upload refuse a GitHub-mode journal, M4-07), and the D25
round-trip machinery of M4-06 — `apps/web/src/journal/editor/reconcile.ts`,
`apps/web/src/markdown/journalSchema.ts`, the `journal: true` mode of
`richTextExtensions` — deleted by M4-09. The relative-path image upload of
`journal/editor/images.ts` stays.

**Mode switch** (M4-11, M4-12): Move to GitHub, into a new or empty
repository only, one initial commit with numeric prefixes from the order
and the relative links rewritten; Bring back into Quiz, from the copy, the
repository detached and never deleted, after showing what is left behind.
Writes are frozen while either runs. Copying a journal from another
classroom of the course comes later (M4-13).
