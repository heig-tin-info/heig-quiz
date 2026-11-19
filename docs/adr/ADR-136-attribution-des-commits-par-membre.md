# ADR-136 — Per-member commit attribution: the author GitHub names, resolved at receipt, staff only

## Status

Proposed (2026-11-19). Decisions 1 to 5 below are the product owner's
(2026-11-19); the storage (§6) and where the weekly series lives (§7) are the
implementer's, within them.

Scope: who authored the commits a project repository's count counts, and who
reads it.

Relations: amends [F-PROJ-13](../spec/02-exigences-fonctionnelles.md),
[N-DATA-02 and N-DATA-07](../spec/03-exigences-non-fonctionnelles.md);
meets in part the attribution prerequisite of
[open question 71](../spec/06-questions-ouvertes.md) (the per-member split
excludes a staff push; the repository's total still counts it, and the
staff's write path stays deferred); amends ADR-117 §8's per-account wipe
list (migration 0147); reads the count's rule of F-PROJ-04 (M3-14i, N-SEC-20),
the collection's receipt of [ADR-130](ADR-130-releve-de-l-espace-de-travail-a-l-echeance.md) §6,
the groups of [ADR-070](ADR-070-repartitions-de-groupes.md) and the commit
graph of [ADR-119](ADR-119-criteres-v3-preuves-de-la-ci.md) §8.

## Context

A group repository has one commit count (F-PROJ-04, F-PROJ-13): the distinct
commits of the pushes no bot made, received by the effective deadline, from
`push_receipts.commits`. The staff cannot tell from it whether one member did
all the work. The grading screen's commit graph (ADR-119 §8) colours each
commit by its member, but it reads GitHub on demand, one repository at a time,
and never says how many. Open question 71 also waited for a rule saying that a
push by a staff member never counts as a student's work.

## Decision

1. **Recorded at push receipt.** The intake (`modules/github/deliveries.ts`)
   reads the push payload's `commits[]` and counts exactly the commits
   `commits` counts — distinct, neither the App's nor a workflow's
   (`pushedBy`). Each one's author is its `author.username` as GitHub reports
   it, resolved at receipt time through the linked accounts
   (`github_accounts`, case-insensitively, as GitHub's logins are) to the
   account's immutable GitHub id. Never the pusher (`sender`), never a
   `Co-authored-by` trailer. A commit whose author has no login, no linked
   account, or a login two linked accounts hold (a rename not yet followed)
   is unattributed, and nothing of that author is stored: no login, no
   e-mail.
2. **The week is the receipt's.** A commit's week is the week of its push's
   `received_at` (the server's clock), named by its Monday in the school's
   time zone (`weekStart`, `weekOf` of `@quiz/domain`, as the drill's
   weeks), never the commit's own date, which the author's machine writes.
3. **The count's own rule.** The per-member counts read the same receipts as
   the repository's count: by the effective deadline, no bot's push, no
   collection's receipt. A member's count is the commits attributed to their
   linked GitHub account's id. **Unattributed** is the total minus the
   members' counts: receipts written before this record (no backfill: a
   running project shows its earlier commits as unattributed), authors with
   no linked account, and anyone who is not a member — a staff member
   included. A commit by a non-member is never counted as a member's. The
   members' counts and the unattributed sum to the repository's count, which
   does not change.
4. **Staff only.** The figures are in the staff's project detail
   (`GET /app/api/projects/:id`, loaded under `staffAccess`) and nowhere a
   student reads: not the project page, the home's cards, Grades, nor the
   classroom page. A student sees their group's total, as before, and never a
   teammate's figure.
5. **Shown in the Repositories tab.** Each member line of a group row gives
   that member's count; the group's commit figure keeps its total and its
   GitHub-total tooltip, with a muted "N unattributed" line under it when N
   is not zero.
6. **Storage: a nullable `authors` jsonb on `push_receipts`**
   (`[{ id, n }]`, migration 0146): the resolved accounts only, the
   unattributed being what `commits` leaves. Null on a receipt written
   before, `[]` when none resolved. The receipt stays the single source of
   both the count and the week; the intake writes one row as before, and
   the reading costs no extra query.
7. **The weekly series lives on the detail row.** `ProjectDetailRow.authored`
   (the member's count and weeks) and `ProjectRepoView.unattributed` (the
   rest, as its own series) are computed by `commitAttribution` of
   `@quiz/domain` over the receipts the detail already reads for the count
   (`attributedReceipts`; the student's loader reads `countedReceipts`,
   which never selects `authors`).
   The repository screen that draws the heatmap reads the same detail.

## Consequences

- One pure rule, `commitAttribution` (`packages/domain/src/projectStudent.ts`),
  shares the deadline filter with `studentCommitCount`; the count and its
  split cannot drift.
- The intake makes one more read inside its transaction when a push names
  authors: `github_accounts` by lowered login, a table of one row per linked
  user. No index is added for it.
- A member who unlinks and links another GitHub account loses the commits of
  the old one to unattributed. A pseudonymized account (ADR-117 §8) keeps
  its counts: `quiz_pseudonymize_account` (migration 0147) renumbers the
  person's GitHub id inside `push_receipts.authors` as it does in
  `github_accounts` and `project_repo_access`, so the real id leaves the
  receipts and the member is still matched, by the new negative id; the
  staging copy's numbering (`scripts/staging-pseudonymize.sql`) covers the
  authors too, an account unlinked since included.
- The detail payload grows by one small series per row (a semester has some
  fifteen weeks). A page of a hundred repositories stays within tens of
  kilobytes.
- The figure is a measure of who pushed work under their own account, not a
  proof of contribution: git's author is declared, and GitHub matches it by
  e-mail. The staff read it with the commit graph (ADR-119 §8).

## Alternatives considered

- **A `push_receipt_authors` table** (receipt, account, count): the same
  content in more rows and a join, for no query this record needs.
- **Resolving the author at read time** from a stored login: it would keep a
  login of authors who are no members, which decision 1 forbids, and would
  follow later renames inconsistently.
- **The pusher (`sender`) as the author**: a member pushing a teammate's
  commits would take them. Rejected by the product owner.
- **A staff-only route for the weekly series**
  (`GET /app/api/projects/:id/repos/:rid/commit-weeks`): a contract, a loader,
  a client query and a second read of the same receipts, to save a few
  kilobytes on a payload that already carries the count.
- **A backfill from GitHub's history**: the commits' dates are the author's,
  not the receipt's, and the deadline rule reads the receipt. Rejected.
