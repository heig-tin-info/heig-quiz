# ADR-070 — Group sets: a classroom's reusable groups, which a project follows until its deadline

## Status

Accepted (2026-10-04, product owner). The four forks of the design (how a
project is tied to its set, the UI words, the place of student
self-formation, the guard of a drag and drop) were settled by the product
owner on 2026-10-04, and the record as a whole accepted the same day.

Scope: where a classroom's groups of students live, who forms them and how,
and how a group project uses them. The GitHub side of a group repository
(created at the first acceptance, every member invited, a revocation before a
departure) stays [ADR-048](ADR-048-projets-de-groupe.md)'s lot 2.

Relations: amends [ADR-048](ADR-048-projets-de-groupe.md) decisions 1, 2, 4
and 5 and its rejected alternatives 1, 2 and 5 (the scope of a group, who
forms it, the rename lock, where the maximum size lives, the reconciliation
of a membership change). Amends in `docs/spec/02-exigences-fonctionnelles.md`
F-PROJ-01 (the form names a set), F-PROJ-03 (a draft's set, not its groups,
freezes at publication), F-PROJ-06 (rewritten on sets), F-PROJ-13 (the
"access to revoke" flag, the drift of a stopped copy) and F-PROJ-17 (decision
5 below), and adds F-PROJ-22 (decision 8); N-SEC-20 in `docs/spec/03-exigences-non-fonctionnelles.md` (the
set's student view, lot 2); the glossary's *Project group*
(`docs/spec/01-glossaire-et-domaine.md`); the cards M3-15 and M3-16
(`docs/merge/09-tasks.md`). The import of F-PROJ-20 (M8-01) maps onto it.
Delivery: cards M3-15, M3-16 (lot 1) and M3-17 (lot 2) of the
[merge progress](../merge/PROGRESS.md); until M3-15, no group route exists
and Accept answers `409 no_group` for any group project (M3-03).

Amended 2026-10-05 (product owner, merge task M3-15b-1): decisions 4 and
5 — the first deadline stops a group, and what "nothing to revoke" means;
see *Amendment of 2026-10-05* at the end of the Decision. Amended again the
same day (product owner, merge task M3-15b-2): decisions 4 and 6 — *Resync*
after the deadline, and a confirmation for every move touching a group with
a repository; see *Second amendment of 2026-10-05*. Amended a third time the
same day (product owner, merge task M3-17): decision 8 — where the students
form their groups, which sets they see, how they learn a set is open, and
the unplaced students (S1–S4); see *Third amendment of 2026-10-05*.

## Context

ADR-048 came from heig-classroom with three choices: a group belongs to one
assignment, only the staff forms it, and its members are frozen once the
group has a repository. The port to Quiz has not begun (M3-15, M3-16), and its
tables (`project_groups`, `project_group_members`, migration `0054`) hold no
row, so the model can still change at the price of a migration.

The product owner describes a wider practice:

- some teachers form groups once for the whole semester, others per piece of
  work, and groups break up or change during the semester;
- groups are formed by the teacher, at random by the platform, or by the
  students themselves, who like to name their group;
- groups have from two to N members, and an odd remainder goes either to a
  smaller group or to larger ones, at the teacher's choice;
- a teacher moves a student from one group to another by dragging them, and
  a mistaken drop must not cost anything;
- the project form chooses the groups a group project uses, or leads to
  forming new ones.

heig-classroom rejected classroom-wide groups because "teams change from one
lab to the next". That holds against ONE list of groups per classroom; it
does not hold against several named lists, of which a project picks one.
heig-classroom's split is not random either: it cuts the roster in
alphabetical order and leaves a remainder of one (7 by 3 gives 3, 3, 1).

The word matters too. "Team" collides twice in Quiz's interface: French
*Équipe* already names a course's staff (`courses.staff`), and English
*Teams* already names Microsoft Teams (ADR-030). GitHub teams are a third
meaning, which ADR-048 deliberately does not use.

## Decision

1. **Words.** The unit is a **group** (fr *groupe*); a named list of groups of
   one classroom is a **group set** (fr *répartition*). Code says `group_set`,
   `group`; "team" is not used, in the interface or in the code. A group's name
   is free text; the default is "Group k" (fr "Groupe k"), the first free k.

2. **A group set belongs to a classroom**, in a module of its own
   (`apps/api/src/modules/group/`), not to the roster: the roster says who is
   in the classroom; a set says who works with whom. A classroom holds any
   number of sets. A new set is named "Groups of <date> <time>"
   (fr "Groupes du <date> <heure>") in the school's time zone unless the staff
   names it; it can be renamed, duplicated (groups and members) and deleted.
   Its tables, owned by the module:
   - `group_sets` — `classroom_id` (cascade), `name`, `max_size` (null: none),
     `open_until` (lot 2), `created_by`, `created_at`;
   - `student_groups` — `set_id` (cascade), `name`, `position`, unique
     (set, name) (`groups` is a reserved word in PostgreSQL);
   - `student_group_members` — `set_id`, `group_id` (cascade),
     `enrollment_id` (cascade), unique (set, enrollment): a student is in at
     most one group of a set, and adding them to another group moves them.
   Membership is by roster line, as in ADR-048 decision 3: a student is placed
   before they ever sign in. **The students of a set** are the classroom's
   roster lines, claimed or not, except staff seats (ADR-018), which are never
   placed. The set's `max_size` replaces `projects.group_max_size`, which the
   migration drops. An archived classroom's sets are read-only
   (`409 classroom_archived`) and cannot be opened to its students.

3. **Three ways to form groups, on the same set.**
   - **By hand**: create, rename, delete a group; move a student into a group
     or out of every group.
   - **At random**: the students of the set who are in no group are shuffled
     (`crypto` randomness) and cut into groups of the chosen size `s`, from 1
     to their number. The remainder rule is the staff's choice, and in both
     the sizes differ by at most one: **smaller** makes ⌈n/s⌉ groups (some of
     size s − 1), **larger** makes ⌊n/s⌋ groups (some of size s + 1). 23 by 3:
     smaller gives seven of 3 and one of 2, larger gives five of 3 and two of
     4; 10 by 4: smaller gives 4, 3, 3 (never 4, 4, 2), larger gives 5, 5.
     At the edges a size lies further than one from `s`, the sizes still
     balanced: 5 by 3, larger, gives one group of 5; 7 by 5, smaller, gives
     4 and 3 (M3-15a).
     Groups already formed are never touched. The rule is pure, in
     `@quiz/domain`, with its tests; the whole formation is one transaction.
   - **By the students** (lot 2): see decision 8.
   A group has one member or more, with no upper bound but the set's
   `max_size`: a group of one is how a student works alone in a group
   project. `max_size` is advisory for the staff (a warning, never a refusal,
   as ADR-048 decision 5) and binding for the students (decision 8).

4. **A group project follows its set until its deadline** (product owner).
   - A project in group mode names one set of its classroom
     (`projects.group_set_id`), chosen or changed while it is a draft, like
     `group_mode`. A set named by a project that is not archived cannot be
     deleted (`409 set_in_use`, the projects named).
   - The project keeps its own **copy** of the set: ADR-048's
     `project_groups` and `project_group_members` stay, and `project_groups`
     gains `source_group_id` (set null). The copy is made when the project
     names the set and replaced when it names another. It is what the publish
     guard already reads (`409 unassigned_students`, M3-02, unchanged) and
     what Accept, the hints, the project page and the student view will read
     (M3-15, M3-09): the project's fact of who is in which of its groups,
     hence whom GitHub has been asked to let in.
   - **What follows.** A group of the copy follows the set while the project
     is not archived and its deadline has not been applied, and, once the
     group has a repository, while that repository's own deadline (ADR-064)
     has not been applied either. A change of the set reaches the copy where
     it touches only groups that follow: a move reaches a project's copy only
     when both the group the student leaves and the group they join follow
     there; otherwise that copy keeps the student where they were. A rename
     follows; in the copy a name or slug that clashes is disambiguated like a
     repository name (ADR-048).
   - **What stops.** After the deadline the copy no longer moves: a move in
     December never changes who was graded in October. A copy that has
     stopped does not follow again by itself — not when its deadline is moved
     later (F-PROJ-09), nor when the project is unarchived. The project page
     then shows that the set has drifted, and *Resync with the set* applies
     the whole difference through the confirmation of decision 6.
   - **How it is applied.** A change that touches no repository is applied to
     the copy in the set's own transaction. A change that touches a
     repository is applied by a job (`group.sync`, pg-boss, one lease per
     project like `deadline_job_at`, ADR-064), which re-reads the deadlines
     in its transaction and works from a pure diff of the set and the copy
     (`groupSyncPlan`, `@quiz/domain`). **A departure waits for GitHub**: the
     collaborator seat is revoked and a pending invitation cancelled, and only
     then does the student leave the copy's group. A revocation GitHub refuses
     leaves them in it, flags the repository's row *access to revoke* on the
     project page (F-PROJ-13), and is retried by the job and by the
     reconciliation (M3-06). **An arrival waits only for the same student's
     pending departure**: it is written to the copy, then invited, or invited
     when they link their GitHub account (ADR-048). Each GitHub write is
     audited.
   - **Whose repository.** A group repository is a student's only through
     the copy's membership, never through `project_repos.user_id`, which
     only records who created it (N-SEC-20; tested with the creator moved
     out). The work does not follow a moved student: what they pushed stays in
     their former group's repository, which they no longer reach.
   - A group's display name follows the set; its slug, hence its repository's
     name `<project slug>-<group slug>`, is fixed once the repository exists.
     ADR-048 decision 4's rename lock is lifted: renaming a group never
     renames a repository.
   - Deleting a group of the set is refused while a following copy of it has
     a repository (`409 has_repo`); emptying it is allowed, with the
     confirmation of decision 6.

5. **Leaving the roster** (F-PROJ-17) does not wait for the job: removing a
   student calls the group module first, which revokes their access to every
   repository of the classroom's projects, a group's or their own, before the
   roster line is deleted, and refuses with `502 revoke_failed`, the roster
   unchanged, when GitHub refuses (as ADR-048). The cascade then takes them
   out of every set and every copy, frozen ones included: like the rest of
   the gradebook, a student who left the roster leaves the project's grades;
   the repositories, runs and scores stay (F-PROJ-17). A seat whose account
   changes (unclaim, adoption, ADR-061) is a departure of the former
   account's GitHub login followed by an arrival of the new one.

6. **A membership write is guarded by its consequences, decided by the
   server** (product owner). Every membership write (add, move, remove,
   delete or empty a group, *Resync with the set*; a random formation only
   fills new groups, which have no repository yet, so it never needs it) that
   has GitHub consequences answers `409 needs_confirmation` with them — which
   repositories each student loses, which invite them — and a digest of
   them. The request is applied when it sends that digest back
   (`confirm: <digest>`); a digest that no longer matches answers a fresh
   `409 needs_confirmation`. A write with no GitHub consequence takes effect
   at once, and the page offers *Undo* (the reverse write, itself a write
   that may meet the 409) for a few seconds; a write with consequences opens
   a confirmation that names them. The client never guesses the consequences.

7. **The project form** offers, under group work, the classroom's sets
   (name, number of groups, students placed / not placed, date) and
   *Create new groups*, which opens a new set and comes back to the draft.
   Publishing a group project without a set answers `409 no_group_set`; at
   publication the set chosen freezes with the groups mode (F-PROJ-03,
   `409 not_draft`), while the groups themselves keep following (decision 4).
   The project page shows the set it follows and a link to it.

8. **Student self-formation** (lot 2). The staff opens a set to its students
   until a date (`open_until`, the server's clock; a `max_size` is then
   required). While it is open, and as long as no group of the set has a
   repository in any project, a student holding a claimed seat of the
   classroom may create a group and name it, join a group below `max_size`,
   leave their group, and rename the group they are in; the staff keeps
   every right. When it closes, nothing happens by itself: the staff places
   the remaining students (by hand or at random), and a project's publish
   guard still refuses anyone left out. These are the first student writes of
   a classroom besides Accept: they go through the student routes of the
   module on `readableClassroom`'s student branch, refuse an impersonation
   session and the `seb` and `kiosk` sessions, and each is audited.
   **What a student reads** goes through the module's student view, a new
   exit listed in N-SEC-20: while the set is open, its groups' names, sizes
   and members' first and last names; once closed, only their own group of it
   (name and members). Never a set that is not open nor used by a project
   they see, never another classroom's, never an e-mail, a GitHub login or a
   staff note. Tested like the other student views: a second classroom's set,
   a closed set, and another group's members after closing, searched for in
   every student response.

9. **Who and what.** Every route of the staff is loaded through
   `staffAccess` (invariant 6): a set of a classroom one does not reach is a
   404. Every input and answer has its schema in `packages/contracts`
   (`group.ts`). Every write is audited under closed names (`group_set.*`,
   `group.*`, `project_group.repo_invite|repo_revoke`, invariant 9). Its
   refresh hints go to the course's staff and to the `user:` topic of each
   student whose group changed — in lot 2, while a set is open, to the
   `user:` topics of the classroom's claimed students — and never to the
   classroom's topic (N-SEC-20).

10. **The import** (F-PROJ-20, M8-01): each heig-classroom group assignment
    becomes one set of its Quiz classroom, named after the project, with its
    groups and members; the project names it, and its copy is the imported
    groups, `source_group_id` set. An imported project past its deadline has
    a stopped copy (decision 4).

11. **Delivery.**
    - **Lot 1** — M3-15a (API: sets, by hand, at random, a project's set and
      its copy), M3-15b (the follow's job, ADR-048 lot 2's group
      repositories, the revocation on leaving the roster) and M3-16 (web: the classroom's
      *Groups* tab, a set's page with drag and drop and a keyboard
      equivalent, the project form's choice).
    - **Lot 2** — M3-17: self-formation (decision 8, F-PROJ-22), the
      student's screen of it.
    - ADR-048 lot 3 (per-member invitation follow-up, a per-member
      adjustment of the group's score) is unchanged and still later.

### Amendment of 2026-10-05 (product owner, M3-15b-1)

- **§4, the first deadline stops a group.** A group of the copy stops
  following at the FIRST of its deadlines: the project's (already
  `groups_stopped_at`) or, earlier, its repository's own (ADR-064). A
  repository whose deadline is extended past the project's does not keep
  its group following. (The per-group stop is stored by M3-15b-2.)
- **§5, nothing to revoke.** When GitHub cannot be asked — the App not
  installed or uninstalled, the organization or the repository deleted on
  GitHub (`deleted_at`), the member never had an account invited — there is
  nothing to revoke: the removal proceeds, and the audit records the
  revocation as skipped with its reason. Only a refusal by a repository
  GitHub can reach refuses the removal (`502 revoke_failed`: roster, sets
  and copies unchanged). The account revoked is the one Quiz INVITED,
  recorded at each invitation (`project_repo_access`), never the user's link
  of today. The same revocation runs before an unclaim, an e-mail change
  that detaches the seat's account, and a self-enroll that turns the seat
  into a staff seat.
- **Delivery split** (orchestrator): M3-15b-1 delivers the group
  repositories at Accept, the record of invited accounts, the invitation on
  a link and the synchronous revocations; until M3-15b-2 (the `group.sync`
  job, the per-group stop, `needs_confirmation`, *access to revoke*,
  *Resync*), a set's write whose step would reach a copy group with a
  repository is refused whole, `409 has_repo`, and a rename still follows.

### Second amendment of 2026-10-05 (product owner, M3-15b-2)

- **§4, *Resync with the set*** is allowed after the deadline — its
  confirmation names every frozen repository it touches — and refused once
  the project is released (`409 released`). (Delivered by M3-15b-2b.)
- **§6, what needs a confirmation.** Every place or unplace touching a
  following group that has a repository needs the confirmation, even when
  GitHub will have nothing to do (no account invited, the App gone): it
  changes whose repository and grade it is. The `group.sync` job then audits
  the revocation skipped (§5's P1).
- **How it is built** (orchestrator, M3-15b-2a): a move touching a group
  with a repository is always the job's; the set's transaction applies the
  rest, marks the departures on the copy (`departing_at`, which no
  invitation passes) and the project due (`group_sync_due_at`, a third
  lease `group_sync_job_at`). The consequences confirmed are those the
  write ADDS to the ones already waiting, by a SHA-256 digest of their
  sorted (project, group, roster line, kind). A failed pass retries after a
  backoff doubling from 30 s up to an hour. Each copy group's stop is
  stored (`project_groups.stopped_at`). An access is revoked only once
  GitHub confirmed it (`project_repo_access.revoking_at` while asking): a
  roster write meanwhile is refused (`502 revoke_failed`), a crashed job's
  next pass asks again, and an access GitHub kept on a group repository
  whose line is no longer its member (a *stray grant*) is the job's to
  revoke and flags the repository *access to revoke*.

### Third amendment of 2026-10-05 (product owner, M3-17)

Decision 8, the students' side, settled before it was built:

- **S1, where.** The student's classroom page gets a *Groups* tab (fr
  *Groupes*), at the same address as the staff's, `/classrooms/:id/groups`,
  role-dispatched like `/classrooms/:id` (F-ORG-15). It is drawn only while
  a set reaches the classroom's students (the page's `hasGroups`, like
  `hasJournal`).
- **S2, which sets.** A student sees a set that is OPEN (its `open_until`
  ahead by the server's clock, the classroom not archived), or one a
  published project of the classroom that is not archived names. A closed
  set no such project names is invisible.
- **S3, how they learn of it.** An open set is a row in *Open now* of the
  student's Activities, on the classroom page and the home: "Form your group
  until …" (fr "Formez votre groupe jusqu'au …"), leading to the tab. It
  never takes the urgent accent, and nothing is notified.
- **S4, the unplaced.** While the set is open, the students also see the
  students of the set in no group, by first and last name only.

How it is built (orchestrator, M3-17):

- **The student view** is one service of the module (`studentGroupSets`),
  each field picked by hand: the set (`name`, `maxSize`, `openUntil`,
  `open`), `serverNow`, `writable`, `myGroupId`, the groups (`name`,
  `size`, members' names) and, while open, `unplaced`; closed, the reader's
  own group alone. Never a roster line's id, a claim, an e-mail, a GitHub
  login, the projects naming the set. `writable` is the server's: open, no
  group of the set with a repository, the classroom not archived, the
  reader's own portal session on a claimed student seat.
- **Routes.** `GET /app/api/classrooms/:id/group-sets/student` through
  `readableClassroom`'s student branch, the student payload forced (a
  teacher in the student view and an impersonation read it, `writable`
  false); the writes `POST /app/api/group-sets/:id/student/groups` (create
  and name, the creator moved in; the default name in the student's
  language), `PUT|DELETE …/student/membership` (join by group id, leave),
  `PATCH …/student/groups/:gid` (rename their own), each answering the set
  as its writer reads it. A write takes the caller's own portal session on a
  claimed student seat of a set that reaches them (`studentGroupSet`,
  `guards.ts`): an impersonation (in every environment), a teacher in the
  student view, a staff seat, a `seb` or `kiosk` session, a token get the
  404 of a missing set. Group ids only, never a roster line's.
- **The checks**, under the set's lock (`writeSet`), BEFORE anything is
  written or stepped: open by the server's clock (`409 set_closed`, no
  grace); no group of the set with a repository in any project naming it,
  stopped copies and archived projects included (`409 set_frozen`, the
  same repository predicate as the copy's slug), so a student's write never
  reaches `needs_confirmation`; `409 group_full` at the maximum or above
  (a group the staff filled past it is full to the students), the lock
  serialising the last seat. An emptied group stays; a student never
  deletes one. The audit reuses `group.create`, `group.rename`,
  `group.member_move` with `self: true` and the student's line.
- **The staff.** `GroupSetPatch.openUntil`: a date opens the set until then
  (a date already past leaves it closed), null closes it, reopening is
  allowed, an archived classroom refuses it (`409 classroom_archived`); the
  set open after the write needs a maximum size (`422 max_size_required`,
  also for clearing it while open). The summary and the detail say
  `openUntil` and `open`; a duplicate is born closed. The set's page opens
  it from its menu (a date and the maximum, the risk said: a published
  project on an open set can be accepted once everyone is placed, and its
  first repository freezes the set) and says until when it is open, with
  *Close to students*.
- **Hints.** A write on a set that reaches the students, before or after it
  (an opening, a closing), hints `groups` to the `user:` topic of every
  claimed student of the classroom besides the course's staff; never
  `classroom:`. Nothing ticks at the closing: the client reads the set again
  when `openUntil` passes, by `serverNow`.

## Consequences

- One teacher action serves the whole semester: a set formed once is named
  by every project of the semester, and a student who drops out is removed
  once; every open project follows, closed ones keep their history.
- A single drag can now reach several repositories. The cost is a job, a
  pure diff, a lease and a flag on the project page instead of ADR-048's
  synchronous `502 revoke_failed`: with N projects on one set, an
  all-or-nothing call to GitHub is no longer possible. A student whose
  revocation failed keeps their access until the retry succeeds, and the
  staff sees it. Leaving the roster keeps the synchronous refusal.
- The copy's unique constraints stay true by construction: a move reaches a
  copy only where both its ends follow, and a departure completes before the
  arrival.
- Downstream code keyed on `project_repos` (deadline, freeze, review,
  scores, release) does not change; the questions "who is in this group" and
  "whose repository is this" read the copy.
- A migration adds three tables, `projects.group_set_id` and
  `project_groups.source_group_id`, and drops `projects.group_max_size`;
  nothing holds a row yet.
- The spec follows with the record (see Relations), with a new card for
  lot 2.
- Lot 2 opens a student write surface on a classroom, and a student view of
  its own.

## Alternatives considered

1. **Groups per project only** (ADR-048 as written, with *Copy from…*):
   correct for one lab, wrong for a semester — a student who drops out is
   removed project by project. Group sets keep its economy (a new set, or a
   duplicated one, per lab) without that cost.
2. **One list of groups per classroom**: the false invariant heig-classroom
   rightly rejected; several named sets are its fix.
3. **A frozen copy at publication** (the set is only a template): simpler,
   and the semester case again needs one edit per project; rejected by the
   product owner.
4. **Projects that always read the set live**: a late move would rewrite who
   was graded on a closed project.
5. **A stopped copy that follows again on its own** after a reopen: the next
   change would replay, without a word, every move made since the freeze;
   the explicit *Resync* shows them first.
6. **A synchronous, all-or-nothing membership change** (ADR-048 alternative 5
   kept): impossible to keep atomic across several repositories; the copy
   that loses a member only when GitHub has revoked them keeps its honesty
   instead — the copy never claims a revocation that did not happen.
7. **A confirmation on every drop**: safe and slow when forming ten groups by
   hand; *Undo* covers a mistaken drop with no consequence, the confirmation
   stays for a drop that reaches GitHub.
8. **Unbalanced remainders** (10 by 4 as 4, 4, 2): one group carries the whole
   shortfall; balanced sizes spread it.
9. **"Team" (fr *équipe*) as the word**: the students' word, and a collision
   with the course's staff in French and with Microsoft Teams in English.
10. **GitHub teams for group repositories**: students are outside
    collaborators, and a team only grants access to members of the
    organization (ADR-048, lot 2).
