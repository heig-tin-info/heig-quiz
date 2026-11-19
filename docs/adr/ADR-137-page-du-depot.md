# ADR-137 — A repository's own page replaces the row's sheet

## Status

Proposed (2026-11-19). The page, its primary action by state and its
previous and next are the product owner's (2026-11-19, mockup approved);
the route, the order of the walk and the figures picked are the
implementer's, within them.

Scope: what a row of a project's Repositories tab opens, for the staff.

Relations: amends [F-PROJ-13](../spec/02-exigences-fonctionnelles.md) (a
row opens the repository's page, no longer a sheet); keeps
[ADR-129](ADR-129-depot-ouvert-par-l-equipe-dans-l-espace-de-travail.md) §11
(*Open in workspace* secondary) and reads the per-member access of
[ADR-070](ADR-070-repartitions-de-groupes.md) (amendment of 2026-11-19) and
the per-member commits of
[ADR-136](ADR-136-attribution-des-commits-par-membre.md); leads to the
grading screen of [ADR-106](ADR-106-notation-des-projets-par-criteres.md) §8.

## Context

A row of the Repositories tab opened a side sheet (`RepoSheet`): the
repository's flags, collection and sync, its invitation and Resend, its
scores and the teacher's score form, its own deadline and lock, its runs.
Since ADR-070's per-member access and ADR-136's per-member commits, a group
repository has more to say than a sheet holds: who is in, who did the work,
and when. The owner found the sheet cramped and asked for a full page,
from an approved mockup.

## Decision

1. **A page, not a sheet.** `/projects/:id/repos/:rowId`, staff only. Every
   row opens it, by a click or Enter, a row not accepted yet included:
   `rowId` is the repository's id, else the group's or the student's
   roster line's. The page reads the project's own detail (cached,
   refetched as the project page is, never waiting for GitHub) and finds
   its row there: no new API route. Every fact and action of the sheet
   moves to the page; the sheet is removed.
2. **Its one primary follows the state.** During the project: none,
   *Open in workspace* staying secondary (ADR-129 §11). Once the repository
   is frozen for good: **Grade** under criteria, which opens the grading
   screen on it; the **teacher's score** under the CI's score, its form in
   a dialog. Grade exists in criteria mode only; a project graded `none`
   and the staff's test repository have no primary. Re-enabling the
   protection is the overflow menu's; the own deadline and the lock appear
   once, in the rail's deadline card.
3. **Previous and next** walk the rows in the Repositories tab's own order
   (groups by name, then students as the server orders them; a column's
   sort is not carried), narrowed by the tile filter the page was opened
   under (`?filter=`, which the project page now keeps in its address too).
   The staff's test repository (ADR-077) is never a step, though its row
   still opens its page, which has no steps.
4. **What it shows.** Four figures (commits, last commit, CI checks, the
   final score — or, ungraded, how many joined); the members with their
   access tag while not in, the commits they authored and their share of
   the repository's count (the unattributed included in it, on a row of
   their own when there are any), and Resend for one whose invitation
   waits or expired; the commits per member and per week on the heat
   ramp, from the project's start to its deadline or today; the runs.
   A rail: the deadline and the lock, the scores, the place of the final
   score in the class (from the detail's rows, the CI's share under
   criteria excluded), the repository's facts. No per-member last commit:
   the detail does not carry one. A row not accepted yet shows its members
   and nothing of GitHub.

## Consequences

- One more route, under the project; the Repositories tab's filter is in
  the address, so Back from a repository's page finds it.
- The heatmap primitive takes any columns (`HeatTable`), the hour grid
  being its 24-column case.
- Resend reaches every member still out (the route's rule): each member out
  shows it, and any of them sends the same request.

## Alternatives considered

- **A wider sheet.** Still a layer over the table, no address to share or
  reload, and no room for a heatmap beside the rail.
- **A new API route for the repository.** The detail already holds the row,
  per-member series included; a second read would only drift from it.
- **Walking the table's sorted order.** The sort is local state of the
  table; carrying it would tie the page to a component's memory for little.
