# ADR-087 — What's new: one entry file per pull request, shown once after an update

## Status

Accepted (2026-10-09, decided by the product owner). Migration `0093_changelog`.

Scope: the changelog entries under `changes/`, their parser
(`scripts/changes.mjs`) and the `checks` guard (`scripts/check-changes.mjs`),
the API's bundle (`apps/api/scripts/changelog.mjs`, `dist/changelog.json`),
the `changelog` module (`apps/api/src/modules/changelog/`, table
`changelog_entries`), `users.changelog_seen_at` and its acknowledgement
(`POST /app/api/me/changelog`, auth plugin), and the web's dialog and
history page (`apps/web/src/changelog/`).

Relations: adds F-NOTIF-14; extends N-I18N-03's exemption from translation
to the entries' texts; leaves F-ADMIN-03's announcement message as it is;
sits beside the coach marks (`apps/web/DESIGN.md`, "Coach marks"), which
wait for it.

## Context

Production is updated several times a week, and nothing tells a student or a
teacher what changed: a screen moved (the course's conditions went to its
Settings), a button appeared, an old path went away. The coach introduces a
NEW control in place, the first time a screen is reached, but it says
nothing about what moved or disappeared, and nothing about a release as a
whole.

Some twenty pull requests are open at once (AGENTS.md), so a single
`CHANGELOG.md` would conflict on every merge. There is no version number
yet: a deploy is a commit (ADR-028), which the user menu already names by
its short sha and date.

## Decision

1. **One file per pull request.** `changes/<slug>.md`, frontmatter only:
   `audience` (`student`, `teacher` or `none`), `kind` (`new`, `changed`,
   `moved`, `deprecated`, `removed`), `en` and `fr` (required unless the
   audience is `none`; one line, inline markdown, no raw HTML).
   `changes/README.md` holds the format and the writing guide (the user's
   words, where they see it, no module names, no PR numbers) and is not an
   entry. **The slug is the entry's identity** and never changes once
   merged: the database keys the entry's release date on it.
2. **One parser.** `scripts/changes.mjs`, plain Node with no dependency (a
   restricted frontmatter: `key: value` lines, values bare or quoted, `#`
   comments), is the only reader of the format: the `checks` guard and the
   API's build both import it.
3. **The guard.** The always-running `checks` job runs
   `scripts/check-changes.mjs`: every entry must parse, on every run; on a
   pull request, the branch must add an entry and may rename none (deleting
   one is allowed). Dependabot's pull requests are exempt from the "add"
   rule (by the pull request's author, not the actor of the run). The same
   command runs locally:
   `node scripts/check-changes.mjs --base origin/main`.
4. **Bundled at build.** The API's build writes `dist/changelog.json`, every
   entry whose audience is not `none`; an invalid entry fails the build.
   The bundle is then parsed with `ChangelogSource` of `@quiz/contracts`,
   the schema the server reads it with, so the parser and the contract
   cannot drift apart unnoticed. The image carries the bundle, not
   `changes/`. A server that cannot read its bundle logs it at boot and
   serves no entry.
5. **Dated at boot, on the database's clock.** Each boot inserts a row per
   bundled entry into `changelog_entries(id, first_live_at, commit_sha)`
   with `ON CONFLICT DO NOTHING`: `first_live_at` is the database's `now()`
   the first time a deploy served the entry, `commit_sha` that deploy's
   `COMMIT_SHA`. A later deploy never moves either. A row whose entry left
   the bundle is ignored.
6. **Seen per account.** `users.changelog_seen_at` (`NOT NULL DEFAULT
   now()`: an existing account starts at the migration, a new one at its
   creation, so no one is shown a history from before they arrived). An
   entry is unseen when `first_live_at > changelog_seen_at`. `POST
   /app/api/me/changelog` sets it to the database's `now()`; it belongs to
   the auth plugin, since `users` is the auth module's, and the changelog
   module only reads it by join.
7. **Filtered by the server.** `GET /app/api/changelog/unseen` and `GET
   /app/api/changelog` send a student the `student` entries and a teacher
   or an admin both audiences, by `users.role`, newest first; an entry
   carries its kind, texts, date and commit, not its audience. The history
   is the same text for everyone of a role, so any signed-in caller reads it,
   an impersonation and a Bearer token included. The
   unseen list and the acknowledgement are the account's own state: the own
   portal session's only (`ownSessionGuard`; an impersonation or a Bearer
   token gets `403 session_required`). A `seb` or `kiosk` session reaches
   none of them (ADR-027's default deny).
8. **A dialog, once.** After an update the web opens a dialog of the unseen
   entries, grouped by release ("2026-10-09 · ad87b7d"), each with its kind,
   and one action, "Got it", which holds the focus. Closing it by any means acknowledges. It opens
   only on the screens whose route says so (`whatsNew: true` in `ROUTES`,
   `apps/web/src/router.ts`: the home, the
   courses, a course, a classroom, the classrooms, the pools), never on an
   attempt, a lobby, a live run, a poll, a drill, a correction, a preview
   or an editor, and never in the student view, which is a teacher's
   preview of their own seat (ADR-018).
9. **The coach waits.** While unseen entries load or wait to be read, no
   coach bubble starts. Turning the coach off does not silence What's new.
   The coach introduces one control in place, the first time its screen is
   reached; What's new summarises a release, once. Neither replaces the
   other.
10. **History.** "What's new" / « Nouveautés » in the account menu opens a
    page of every entry the reader may see, grouped the same way.
11. **Language.** The interface around the entries goes through `t()`
    (N-I18N-01). The entries' texts are bilingual content written in the
    entry file and picked by the reader's language, English when the
    French is missing: like question content (N-I18N-03), they are not
    keys of the dictionary.

### A version number, later

A release is labelled by its date and short sha because there is no version
yet. When there is one, it slots in as a `version` column of
`changelog_entries`, filled at boot from the configuration like
`commit_sha`, and the label shows it in place of the sha; nothing else
changes. It is not added now.

### Out of scope

F-ADMIN-03's announcement message (an administrator's free text, for
everyone, now) is a different thing — an operator speaking, not a release
summarised — and stays unsettled.

## Consequences

- Every pull request carries one more file, and its author must say, in the
  user's words, what changed for whom. A change no user sees says so with
  `none`, which costs one line.
- The release date is the first boot of the entry on that database:
  staging and production date the same entry differently, which is right
  (each shows what changed on it). An entry merged and then deployed in two
  steps is dated by the first deploy that carried it.
- A renamed slug would read as a new entry and show again: the guard
  refuses it. A deleted entry disappears from the history at the next
  deploy; its row stays, ignored.
- An account created before the migration starts with nothing unseen: the
  first dialog is the first release after this one.

## Alternatives considered

- **One `CHANGELOG.md`**: conflicts between concurrent pull requests on
  every merge.
- **Entries in the database, written by an administrator**: a second place
  to remember, after the merge, by someone who did not make the change.
- **Generated from commit messages or PR titles**: written for reviewers,
  not for students; no audience; no French.
- **A toast or a banner instead of a dialog**: the owner chose the dialog —
  read once, one action, closed for good.
- **The coach for everything**: it points at a control that exists; it
  cannot say that something moved away or was removed.
- **Version numbers now**: nothing assigns them yet; the sha already names a
  deploy (ADR-028).
