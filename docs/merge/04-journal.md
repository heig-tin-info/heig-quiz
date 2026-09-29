# 4. The journal

The journal is a classroom's course documentation, written by the staff,
read by the students. It is **not an activity**: no assessment, no
tracking, no deadline. Classroom commit `ab98cc0` (52 files, +10 044 lines),
classroom ADR-015 (to be imported as ADR-038).

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
`journal` (classroom-wide), nine audit actions `journal.*`.

## 4.2 What the port requires

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
  registry (M2-04), the classroom↔org link (lazy "Connect to GitHub").
- **Access (invariant 6)**: a `readableClassroom` loader in
  `Q:modules/guards.ts` — staff = `staffAccess(user, classroom.course_id)`;
  student = an enrollment with `user_id = me`. This is Quiz's first
  student-readable classroom route: the staff test seat (ADR-018) and
  impersonation (ADR-034) must get the **student payload**, not the staff
  one (classroom hides the teacher's buttons in student view but still
  returns drafts).
- **Contracts (invariant 7)**: zod bodies and payloads in
  `packages/contracts/src/journal.ts` (classroom declared TS interfaces and
  inline zod).
- **i18n**: warnings become codes with parameters, translated on the web
  side; every teacher string through `t()`.

## 4.3 Defects found in classroom's journal (fix in the port)

| # | Defect | Fix |
| --- | --- | --- |
| J1 | Assets of draft or not-yet-visible pages are readable by any enrolled student (the asset route checks membership, not the referencing page's visibility) | serve an asset to a student only if a page visible to students references it |
| J2 | Concurrent ingestions: `singletonKey` dedups queued jobs only; save and Refresh call `ingestJournal` directly; mirror writes not transactional | every ingestion through the queue or under an advisory lock per journal; `mirror()` in one transaction |
| J3 | `attach` ignores `rootPath` when it reuses an existing (repo, ref) mirror | key the mirror on (repo, ref, root_path) or refuse a different root |
| J4 | No SSE hint when `visible_from` passes | a ticker sweep (`everyMs` 60 s) that emits the hint when a page becomes visible |
| J5 | Warnings are server-built English sentences | codes + parameters |
| J6 | `.md-body` collides with Quiz's question prose styles | `.md-body.md-doc` modifier (long-form: h1 28 px, 72-ch measure, 1.75 leading) |
| J7 | Quiz dev runs on PGlite without webhooks nor pg-boss | Refresh is the dev path; the mock serves rendered HTML fixtures |

Note on J2 (quiz #273): in pg-boss 12 a `singletonKey` without
`singletonSeconds` dedupes nothing on a `standard` queue, which is what a
queue created with no policy is, and a policy cannot be changed after
creation. Quiz's `SendOptions` (`apps/api/src/jobs.ts`) no longer offers
`singletonKey`. A port that needs a dedupe must choose a queue policy
(`singleton`, `stately`, …) in `createQueue`, and add it to the in-process
queue too, so that development and production behave alike.

## 4.4 Open points (in `08-decisions.md`)

- D03 — journal attached to a classroom (shareable, as in classroom) or to
  the course.
- D14 — asset storage: `bytea` (as ported, a rebuildable read model) or
  Quiz's disk `ASSETS_DIR`.
- D15 — HTML policy: the journal escapes raw HTML; Quiz questions sanitise
  an allow-list (N-SEC-05). Suggested: keep both, per surface.
- The planned WYSIWYG editor (Quiz's Tiptap `RichText`) writes `asset:`
  images and normalises markdown (`_x_` ⇒ `*x*`): noisy git diffs, images
  that do not render on GitHub. The source editor with server preview ships
  first; the adapter is phase L.
