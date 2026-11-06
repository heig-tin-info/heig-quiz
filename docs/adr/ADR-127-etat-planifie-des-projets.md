# ADR-127 — A project's `scheduled` state: armed by Schedule, announced, opened by the ticker

## Status

Accepted (2026-11-06, the product owner's decisions after the "Labo-05
Pneus" incident). Delivery progress lives in `changes/`.

Scope: a GitHub project's lifecycle (F-PROJ-03), its staff's actions
(F-PROJ-13), what its students see and may do before it opens (F-PROJ-04,
F-ORG-15, N-SEC-20), the `project_scheduled` notification (F-NOTIF-13).

Relations: amends [ADR-104](ADR-104-badges-d-etat-unifies.md)'s amendment
of 2026-10-13 item 2 and its amendment of 2026-10-14 (a dated draft is no
longer `scheduled`); [ADR-070](ADR-070-repartitions-de-groupes.md) §12
(the ticker no longer keeps an incomplete group project a draft) and §8 (a
scheduled project shows no closed set); [ADR-030](ADR-030-canaux-de-notification.md)
rule 12 (a new kind); [ADR-022](ADR-022-jetons-api-et-serveur-mcp.md)'s
addendum of 2026-10-13 (its rationale for a manual-only `create_project`).
Mirrors evaluations' `scheduled` (F-EVAL-04, ADR-030 §13). Invariants 4, 5, 6.

## Context

A draft whose publish mode was `scheduled` was armed by itself: the ticker
published it at its start (`publishScheduled`), and its page showed a
primary "Publish" that published it at once, keeping its dates. Nothing
said so. A teacher planned "Labo-05 Pneus" for 16:30, pressed Publish 23
seconds later, and 27 students were told "Accept it" five hours early.
Evaluations already had the model wanted: a draft opens on its own only
once a teacher has scheduled it, a scheduled evaluation is announced and
listed under Upcoming, and Open now is a deliberate second action.

## Decision

1. **Four states**: `draft` (nothing visible, nothing told, autosaved) →
   `scheduled` (a real state, armed by an explicit **Schedule**) →
   `published` → `locked`. The archive is unchanged. `published` and
   `locked` are **live** (`PROJECT_LIVE_STATES`); every state but `draft`
   is **visible** to the students (`PROJECT_VISIBLE_STATES`); `draft` and
   `scheduled` are edited alike (`projectBeforePublication`). The three
   are named predicates of `@quiz/domain` (`projectView.ts`), with their SQL
   twins `liveProject()` and `visibleProject()` in `guards.ts`; no site tests
   `!== "draft"` any more (`checkpointPass` included).
2. **One primary button whose label follows the start choice**: Publish
   when the start is now, Schedule when a date still ahead is set
   (`draftStartsLater`; `primaryAction` `publish` or `schedule`). The
   publish mode stays the column behind the choice (`manual` = now,
   `scheduled` = a date).
3. **Scheduled is announced, not open.** The students see the project under
   Upcoming with its start, on the same bare card as before (name, classroom,
   course code, dates, status, `githubLinked`; no repository, group, work
   mode, source or distribution); its view carries no workspace mode, and
   the workspace start and the `.seb` of an online project answer the 404
   of a missing project until it opens, before any test of its mode. Accept
   answers `409 not_started` until the state is `published`, its start come
   or not. The ticker publishes it at its start, and `project_published`
   ("accept it") goes out then.
4. **Editable like a draft**, the start choice locked to "a date": a
   patch back to manual is `409 publish_mode_frozen` (Publish now is the
   way), a start moved to the past `422 start_past`. Two secondary actions,
   no primary: **Publish now** (`POST …/publish`) and **Cancel the
   schedule** (`POST …/unschedule`: back to `draft`, off Upcoming, nobody
   told, audited `project.unschedule`).
5. **No draft is armed by itself any more.** Migration `0129` moves to
   `scheduled` every row `state = 'draft' AND publish_mode = 'scheduled'
   AND distribution_full_name IS NOT NULL AND deadline_at > now()`, archived
   ones included (hidden by `archived_at`, re-armed by an unarchive), and
   tells nobody (the marker stays null). An unarchived scheduled project
   whose deadline has passed meanwhile comes back a `draft`: the ticker
   would never publish it, and it would stay scheduled for ever.
6. **A scheduled project opens at its start whatever happened since**
   (product owner's choice, diverging from ADR-070 §12's "stays a draft
   silently"): a student in no group, a group project left without a set,
   a late claim — the ticker publishes it (`autoPublishProject`), and a
   student in no group meets `409 no_group` on Accept until placed.
   Schedule itself (`POST …/schedule`, audited `project.schedule` with the
   dates) refuses what Publish refuses — `distribution_missing`,
   `no_group_set`, `unassigned_students` with `{ students }`,
   `deadline_past` — plus `422 start_past` (no date ahead), `409
   not_draft`, and `409 project_archived` or `409 classroom_archived` (its
   students could not load it, and the once-ever announcement of §7 would
   be spent for nothing), so the teacher is told at planning time. The
   ticker re-judges the start and the deadline under the row's lock, so a
   start moved later between its scan and its publication is never
   published early.
7. **`project_scheduled`**: the classroom's claimed student seats are told
   it opens on its start, once per project EVER — the marker
   `projects.scheduled_announced_at`, claimed by a conditional UPDATE and
   never cleared, as evaluations' (ADR-030 §13); a cancelled and renewed
   schedule or a moved date tells nobody again. Bell on, e-mail and Teams
   off by default (as `project_published`); an unlinked GitHub account
   reads a sentence asking to link it. A GitHub kind (hidden without the
   App). The Teams package declares it: `TEAMS_APP_VERSION` 2.5.0.
8. **A closed group set stays hidden.** `scheduled` does not count in the
   student visibility rule of a set (`studentVisibleSet`, ADR-070 §8,
   N-SEC-20): no group on the card, no Groups tab, before the opening.
9. **Publish always starts now.** `POST …/publish` publishes a draft or a
   scheduled project with its start now, its absolute deadline kept or a
   duration counted from now (no more "published early keeps its dates").
   Published rows with a start ahead are left as they are; no code assumes
   `published ⇒ start ≤ now` (the card's Upcoming still reads `startAt`).
10. **`start_past` moves to Schedule and to the patches of a scheduled
    project.** A creation and a draft may hold a past date; its button then
    reads Publish (start now, deadline kept, `deadline_past` if it passed).
    Back to manual still resets a draft's start to now.
11. **The phase reads the state**: `draft` → `draft`, `scheduled` →
    `scheduled`. A draft holding a date is badged "draft".
12. **The criteria reload at the effective publication**, by hand (in the
    request, as before) or by the ticker (a `project.criteria` job, since
    the ticker never calls GitHub).
13. **The MCP**: `create_project` stays manual-only (a draft); its 2026-10-13
    rationale ("a scheduled one would be published by the ticker") is
    obsolete — a draft is never published by the ticker. `list_projects`
    shows the new state.

Not the gradebook, the checkpoints (`checkpointPass` and its SQL twin), the
deadline reminders nor the invitations on a GitHub link: each reads
`PROJECT_LIVE_STATES` (`projectIsLive`, `liveProject()`), so a scheduled
project is none of their business before it opens.

## Consequences

- One more state on every switch over `ProjectState`; the web gets the
  scheduled face (status line, two secondary actions) and the rail's
  Published step done only from `published`.
- A teacher can no longer publish by accident what they meant to plan, and
  the students learn of a planned project the moment it is planned.
- A scheduled group project may open with students in no group (§6): the
  staff sees them on its page and places them; their Accept waits.
- The Teams app is re-uploaded once (2.5.0).

## Alternatives considered

- **Keep `draft` + publish mode and only relabel the button**: the
  ambiguity that caused the incident stays in the data — a draft armed by
  itself, a phase derived from a mode — and students learn nothing before
  the opening.
- **Keep the ticker's group guard (ADR-070 §12)**: a project announced to
  the class would silently fail to open at the announced time; the owner
  prefers it opens and the stragglers wait for their group.
- **Notify "opens on …" at each date change**: noise for a class told once
  already; evaluations' once-ever rule is kept.
