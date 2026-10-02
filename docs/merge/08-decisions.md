# 8. Decisions

The decisions that belong to the product owner. Each has a suggested answer;
none is taken until its **Status** says so. A task blocked by an open
decision says so in `PROGRESS.md`. When a decision is settled, write the
answer, the date and where it was settled (issue, PR, conversation), and
carry it into the spec or the ADR it belongs to (task M0-03 / M0-04).

Status values: `open`, `settled`, `superseded`.

## Blocking phase M1 (settle first)

### D01 — The name of the new activity kind
- **Suggested**: *Project* (FR *Projet*); "assignment" stays forbidden;
  covers a lab as well as a semester project.
- Blocks: M0-04 (glossary), every contract name.
- **Status**: settled 2026-09-28 (product owner, planning conversation): *Project*.

### D02 — Where a GitHub organization attaches
- **Options**: per classroom (as classroom does; one link table) or per
  course (inherited by its classrooms).
- **Suggested**: per classroom (`github_classroom_links`), the connect sheet
  proposing the org of the course's other classrooms. Migration is 1:1 and a
  course may legitimately change org between years.
- Blocks: M2-01.
- **Status**: settled 2026-09-28 (product owner, planning conversation): per classroom.

### D04 — Staff model
- **Questions**: (a) is widening from classroom staff to course staff
  acceptable (every staff of the course reaches every classroom, owner-only
  actions become staff actions)? (b) Quiz gains pending e-mail invitations
  of staff? (c) the assistant label?
- **Suggested**: (a) yes; (b) decide after M0-02 counts pending seats — if
  few, report and re-invite by hand; (c) dropped (display-only in
  classroom).
- Blocks: M1-06 (migration of staff), M0-04.
- **Status**: (a) settled 2026-09-28 (product owner, planning conversation):
  widening accepted. Noted risks, accepted: a teacher who has different
  assistants per class cannot keep them apart, and any staff of the course
  sees every classroom (risk of acting in the wrong one). A per-classroom
  restriction of staff is a possible later refinement, not part of the
  merge. (b) moot: M0-02 found 0 pending seats; (c) dropped as
  suggested.

### D08 — Identity key for the migration
- **Suggested**: the cascade `swiss_edu_id` → `sub` (only if shared) →
  verified e-mail → new user with `classroom:<sub>` + login adoption.
  Final shape after M0-02 measures the overlap.
- Blocks: M1-06.
- **Status**: settled by measurement 2026-09-28 (`measures-2026-09-28.md`):
  0 of 55 shared people have the same `sub` — edu-ID subjects are pairwise.
  Cascade `swiss_edu_id` → verified address → new user; **login adoption is
  required** (M1-06, with its ADR).
- **Addendum** (2026-10-01, product owner, conversation; implemented by
  M1-06 and [ADR-061](../adr/ADR-061-adoption-des-comptes-importes.md)):
  - **Adoption by address**: when `swiss_edu_id` finds no imported
    (`classroom:`) account, a login address from the institutional
    affiliation is accepted; a private address only if unique on both sides
    (exactly one imported account holds it and no other Quiz account does).
    One hit adopts (a conditional UPDATE of `oidc_sub`, audited), none
    inserts, several insert and audit the ambiguity. Adoption is permanent;
    it never touches a non-`classroom:` row nor a `dev:` one.
  - **Users of dropped classrooms**: not imported. The import brings the
    people a mapped classroom reaches (roster, staff seats) and their
    teachers (owners), nobody else.
  - **The mapping key**: each heig-classroom classroom (by name or id) maps
    to an EXISTING Quiz classroom designated by course code + classroom
    name — resolved to ids in the dry-run report for the teachers to
    check — or is dropped. The import creates no course, no classroom, no
    organization nor classroom link; it refuses a mapped classroom not
    connected to the organization its heig-classroom classroom used.
  - **The cutover waits for M8-01**: M1-06's import (people, rosters, GitHub
    account links) switches nothing; the switch is the complete import
    (spec 06 no. 46), with projects, journals, webhooks and the legacy
    audit.
  - **Still open before the first `--apply`** (the script refuses until
    each is given): (3) a student on the heig-classroom roster but missing
    from the Quiz roster — suggested: add a claimed line and report it
    (`--missing-students enroll|report`); (4) an assistant becoming staff
    of the course widens their access to the whole course (D04 (a)) —
    suggested: yes, listed in the dry run (`--assistants staff|skip`).

### D16 — Rename Quiz's "attempt journal"
- **Suggested**: yes, "attempt log" in docs and comments (not in table
  names), so "journal" means one thing.
- Blocks: M0-04.
- **Status**: settled 2026-09-28 (product owner, on the suggestion).
  Scope: `attempt_events` and the spec/ADR prose calling it the attempt's
  "journal" (e.g. spec 05 §5.5, ADR-018) become "attempt log"; the French UI
  strings that say "journal" for it (`eval.resetAttempt.message`,
  `eval.logVisibility.desc`) become "historique" or similar so that the
  word "Journal" in the student UI means only the course journal.

## Blocking later phases

### D03 — Where the journal lives
- **Options**: attached to a classroom, shareable between classrooms (as
  classroom); or attached to the course.
- **Suggested**: classroom attachment with sharing, as ported; the "Create
  a journal" sheet offers "use the journal of <previous classroom>" first.
- Blocks: M4-01.
- **Status**: settled 2026-09-30 (product owner, conversation): **one
  journal per classroom, and a journal is a repository**. No shared mirror,
  no "attach the journal of another classroom". A teacher may point two
  classrooms at the same repository, provided both classrooms are linked
  to the same organization (D02); each classroom then keeps its own mirror
  of it. The model is one row per classroom (`04-journal.md` §4.2).

### D05 — Project grades
- **Questions**: are CI scores official? what do students see before the
  release? how does points/max map to 1–6 (classroom reads max = 6 as a
  mark)?
- **Suggested**: a project score reaches the gradebook only after a teacher
  **release**; before it, students see it marked "indicative"; a per-project
  `grading_scale` (Quiz's `Scale`), with "max 6 ⇒ the score is the grade" as
  one preset.
- Blocks: M3-01, M3-08.
- **Status**: settled 2026-10-01 (product owner, conversation), on the suggestion.
  Addendum 2026-10-01 (product owner, with M3-01): the scale is a
  **project-only type**, `ProjectGradingScale` = `linear` |
  `score_is_grade` with the evaluation scale's rounding, stored in
  `projects.grading_scale`; the evaluations' `GradingScale` stays linear
  only (ADR-052 untouched). The release writes a **per-repository
  snapshot** (`project_repos.released_points`, `released_max`): any later
  difference is "changed after release". The student's **Grades page
  shows a project row only after the release**, with the final score and
  its grade, never the score's source, the teacher's comment nor the
  repository. No score without a repository in M3: the score of a student
  who never accepted, and the absence mark, are M5-03's. Projects imported
  from heig-classroom get `score_is_grade` (product owner, 2026-10-02), its
  own reading of a score out of 6, so that no released grade moves at the
  import (M8-01).

### D06 — Gradebook rules
- **Suggested**: exams and projects count by default, exercises opt-in,
  polls never; weighted mean rounded to the tenth; students see the mean
  only if the teacher publishes it; no ranking.
- Blocks: M5-03.
- **Status**: settled 2026-10-01 (product owner, conversation), on the suggestion.

### D07 — The student's door to the classroom page
- **Options**: (a) the classroom cards of the home always open the
  classroom page; (b) only when it has a journal or a project.
- **Suggested**: (a) — it is the target described by the product owner
  (activities, journal, grades); it is the one visible change before the
  cutover, shipped in M5.
- Blocks: M5-02.
- **Status**: settled 2026-09-30 (product owner, conversation): (a) — no
  longer the one visible change before the cutover, since the journal
  goes live early too — and
  the student navigation says it. **Courses** lists the student's
  classrooms; a classroom opens its page — the activities of that
  classroom, its journal when it has one, later its projects.
  **Activities** is the summary of the active activities across every
  classroom (today's home). `05-web.md` §5.2.
  2026-10-01 (product owner): the student's desktop sidebar carries the
  same entries as the bottom bar, Profile aside (`DESIGN.md`, "The
  student's bottom bar").
  2026-10-01 (product owner), addendum: **no separate "Welcome" page**.
  The logo leads to Activities, which answers "what do I do now". News,
  if ever, would be a strip at the top of Activities built from existing
  events (released grades, new journal pages), not a new page nor a new
  content type. **A calendar or week view is deferred** until the
  projects (M3) bring their deadlines; until then the agenda is the day
  grouping of Coming up — Today, Tomorrow, This week, Later — on the home
  and on the classroom page (F-ORG-14, F-ORG-15; `05-web.md` §5.2).

### D09 — Online workspace in the merge's critical path?
- **Question**: does production have assignments with `work_mode` ≠
  `free`? (M0-02 measures.)
- **Suggested**: if none, phase M6 runs after the cutover and the
  migration drops the codespace columns (reported); the portal is untouched
  meanwhile.
- Blocks: M6, M8-04.
- **Status**: measured 2026-09-28: 3 online assignments, all in test
  classrooms with a roster of 1. **Settled 2026-10-01** (product owner,
  conversation): off the critical path. The test classrooms are not
  imported (they are `drop` in the mapping), so no online assignment comes
  over and nothing of the codespace is imported. The online workspace is
  rebuilt in Quiz (M6) after the cutover, tested locally, tried by users,
  and only once it is confirmed to work is any migration of it looked at.

### D10 — Periodic tasks
- **Suggested**: port `scheduled_tasks` (restart-safe, admin-visible
  status, run-now); tasks seeded by code, period editable by admins.
- Blocks: M2-05.
- **Status**: settled 2026-09-30 (product owner, on the suggestion). The
  minutes-scale tasks move to the table (the housekeeping now, the GitHub
  reconciliations as they are ported); the clock-bound live tasks stay
  `TickTask`s of the ticker, neither configurable nor disableable
  (invariant 5). Spec 05 §5.4 (Clock), F-ADMIN-06.

### D11 — Classroom's audit history
- **Suggested**: imported into a read-only `legacy_classroom_audit_log`
  table (actors remapped best-effort), so Quiz's union stays closed and
  clean.
- Blocks: M8-01.
- **Status**: settled 2026-10-01 (product owner, conversation), on the suggestion.

### D12 — Language of text written into GitHub
- (Seed READMEs, sync PR bodies, bot commit messages, revert commits.)
- **Suggested**: English — they are development artifacts read in a
  developer tool; UI strings stay translated.
- Blocks: M3-07.
- **Status**: settled 2026-10-01 (product owner, conversation), on the suggestion: English. The journal's seed README, repository description and default commit messages already were (`modules/journal/writes.ts`).

### D13 — Accommodations on project deadlines
- **Suggested**: the time bonus does not apply to projects; the per-repo
  manual unlock and a per-student deadline extension (later) cover the
  cases.
- Blocks: M3-05.
- **Status**: settled 2026-10-01 (product owner, conversation), on the suggestion.

### D14 — Journal asset storage
- **Suggested**: `bytea` as ported (a rebuildable read model, ≤ 5 MB per
  asset); revisit if the backup grows noticeably.
- Blocks: M4-01.
- **Status**: settled 2026-09-30 on the suggestion (product owner,
  conversation): `bytea`, ≤ 5 MB per asset, a read model rebuilt from the
  repository.

### D15 — HTML in the journal
- **Suggested**: keep the journal's rule (raw HTML escaped to text) and
  Quiz's rule for questions (sanitised allow-list), each on its surface.
- Blocks: M4-01.
- **Status**: settled 2026-09-30 on the suggestion (product owner,
  conversation): each surface keeps its rule.

### D17 — LLM grading
- **Suggested**: the merge ports classroom's CI-dispatched LLM review as
  is; a platform `llm` module is phase L.
- Blocks: nothing on the critical path.
- **Status**: settled 2026-10-01 (product owner, conversation), on the suggestion, for now: classroom's CI-dispatched review is ported as is. Later, once the platform `llm` module is really in place (phase L), Quiz may run the review of a project itself instead of the student repository's CI.

### D18 — Notification kinds for projects
- **Suggested**: student `project_published`, `project_deadline_reminder`,
  `project_repo_invited`, `project_grade_final`; staff
  `project_deadline_applied`, `project_provision_failed`,
  `github_org_lost`; e-mail on by default only for must-not-miss kinds
  (ADR-030 defaults); `activity_*` payloads kind-neutral.
- Blocks: M3-09.
- **Status**: settled 2026-10-01 (product owner, conversation), on the suggestion.

### D19 — Deletion of a classroom or project
- **Suggested**: deletes database rows only; GitHub repositories are never
  deleted (classroom H11), and the confirmation says so.
- Blocks: M3-02.
- **Status**: settled 2026-10-01 (product owner, conversation), on the suggestion.
- **Addendum (2026-10-02, product owner)**: nothing at all is deleted on
  GitHub, not even the distribution repository the App just built for a
  creation that failed: the row goes, an empty leftover is adopted by the
  next attempt ([ADR-062](../adr/ADR-062-depot-de-distribution.md)).

### D20 — The cutover window
- **Suggested**: the intersemester (February 2027), a weekday morning with
  no deadline and no evaluation; announced a week and a day ahead.
- Blocks: M8-07.
- **Status**: settled 2026-10-01 (product owner, conversation): **during the semester, as soon as possible (target: the week of 2026-10-05)**, not at the intersemester — while classroom still holds little work. A student whose GitHub account is linked in heig-classroom has nothing to do: the import carries the link (spec 06 no. 45); the others link it in Quiz (F-GH-05); each teacher installs Quiz's App and connects their classrooms by hand from the classroom's Settings (F-GH-02), so the import creates no organization link. A deadline, a live evaluation or a live workspace session still excludes the hour of the switch.

### D21 — Unified SEB design
- **Suggested**: `packages/seb`; the platform builds every `.seb`; a `seb`
  session confined to an activity; BEKs optional per activity (Config Key
  only by default); proof B before the first SEB project (§6.3).
- Blocks: M6-02, M6-07.
- **Status**: settled 2026-10-01 on the suggestion (product owner,
  conversation), for M6: `packages/seb`; the platform builds every `.seb`;
  a `seb` session confined to one **activity** (an evaluation or a
  project); the Config Key alone by default, Browser Exam Keys optional per
  activity; proof B before the first SEB project. The evaluations' part was
  settled by ADR-051 (2026-09-30): the Config Key checked on every request
  of a `seb` session (audit-only until proof B), a new confined session
  superseding the previous one of the same student and exam.

### D22 — The classroom-to-course mapping
- **Question**: for each classroom-classroom in production, which Quiz
  course (existing or new) and whether it merges into an existing Quiz
  classroom.
- **Suggested**: the product owner writes the mapping file from the list
  produced by M0-02.
- Blocks: M8-06.
- **Status**: settled 2026-10-01 (product owner, conversation): the teachers create their classrooms in Quiz themselves; the merge produces a correspondence table *classroom name in heig-classroom → classroom name in Quiz*, the product owner has the teachers validate it, confirms, and the import runs on it. A classroom-classroom maps to an existing Quiz classroom (merged into it), never to a new one created by the import.

## Taken with the journal-first reordering (2026-09-30)

### D23 — Quiz's own GitHub App
- **Question**: the plan reused classroom's App at the cutover, which kept
  every GitHub feature dark in Quiz's production until then (one webhook
  URL per App). Should the journal reach Quiz's production before the
  cutover?
- **Answer**: Quiz registers **its own GitHub App** for production, beside
  a separate staging App on a test organization. Classroom's App is not
  touched and keeps serving classroom until the cutover. A teacher
  installs Quiz's App on an organization from the classroom's Settings;
  both Apps coexist on an organization without interfering. GitHub
  features go live in production as they ship, per classroom, once a
  teacher connects one.
- **Consequences**: supersedes "Reusing the GitHub App at the cutover"
  (`03-github-projects.md` §3.4), ADR-035's "the same App is reused", and
  the cutover's App URL switch (I45). At the cutover the organizations
  still used by classroom install Quiz's App (their owners approve its
  permissions once); installation ids change, account links do not
  (`github_user_id` is the person's, not the App's), collaborator seats
  and rulesets stay on the repositories. Bot detection recognises both
  bot logins for commits made before the cutover.
- Blocks: M2-06.
- **Status**: settled 2026-09-30 (product owner, conversation).

### D24 — The classroom's Settings tab
- **Answer**: the teacher classroom page gains a **Settings** tab. Its
  **GitHub** section connects the classroom to an organization (picker,
  install, the status of the checks of §5.3 of `05-web.md`); its
  **Journal** section, enabled once the classroom is connected, creates a
  journal repository, chooses an existing repository of the organization,
  or removes the journal. There is no separate "journal on" switch: the
  classroom has a journal when it has a repository, and the Journal tab
  exists exactly then. Using Quiz without GitHub stays the default.
- **Consequences**: replaces the lazy "Connect to GitHub" sheet opened
  from "New project" / "Create a journal" as the only door (the sheet is
  the same component, the Settings section its home). Rename, archive,
  delete and the drill switch move to this tab too (product owner,
  2026-09-30); the header keeps the name and the period.
- Blocks: M2-07, M4-05.
- **Status**: settled 2026-09-30 (product owner, conversation).

### D25 — The journal's editor
- **Answer**: the journal is edited with Quiz's WYSIWYG markdown editor
  (Tiptap, `apps/web/src/markdown/`) from its first version, with its
  source mode beside it. Conditions, each a test of M4-06: (1) a round trip
  (markdown ⇒ editor ⇒ markdown, no edit) over the journals of
  classroom's production changes nothing but whitespace the task
  documents; (2) front matter (`title`, `date`, `draft`, `visible_from`)
  is kept out of the editor and edited as fields; (3) an image is
  committed into the repository and inserted with a relative path, never
  as `asset:<id>`; (4) relative links between pages and KaTeX survive; (5)
  a page that was not edited is never written. If (1) fails on real
  journals, the source editor ships first and the gap is reported.
- **Consequences**: removes "the WYSIWYG journal editor" from phase L and
  from "what stays out" (`01-strategy.md` §1.4).
- Blocks: M4-06.
- **Status**: settled 2026-09-30 (product owner, conversation);
  **superseded by D29** on 2026-10-01. M4-06 met it in full; D29 removes
  the need, since the platform no longer writes markdown into a repository.

### D26 — Projects before the cutover?
- **Question**: with Quiz's own App (D23), projects too could go live in
  production before the cutover, classroom by classroom, instead of
  waiting for the migration.
- **Suggested**: decide when M3 starts, from how the journal's go-live
  went.
- Blocks: M3-14.
- **Status**: settled 2026-10-01 (product owner, conversation): **projects open in Quiz together with the import, never before it.** The day project creation is released in a classroom is the day classroom's data (projects, deadlines, repositories, grades) is imported: Quiz then mirrors classroom, and the teachers change nothing in classroom between that import and the final migration. No project is created in Quiz before the import; M3-14's pilot runs on staging only.
- **Addendum (2026-10-02, product owner, conversation; merge task M3-02)**:
  **project creation opens to every teacher now**, with no admin gate nor
  environment switch: any member of a connected classroom's staff may create
  and run projects in Quiz before the cutover, where Quiz's App is
  installed. The import (M8-01) still brings heig-classroom's projects, with
  their state, into the classrooms the correspondence table names (D22); a
  project created in Quiz meanwhile is Quiz's own and is not touched by it.
  The students see no project until the project's student view lands
  (M3-09), with its leak test (N-SEC-20): until then the staff alone see
  them. M3-14's pilot still runs on staging with the staging App.

### D27 — Which repositories a journal may use
- **Answer**: any repository of the classroom's organization, as in
  classroom. Accepted risk: any staff of a connected classroom makes Quiz's
  App read that repository and write into it (browser edits), whatever
  their own rights on GitHub. Every choice and every write is audited
  (`journal.*`), and the commits are authored as the teacher. Creating
  or choosing a repository also invites the staff with a linked GitHub
  account as collaborators, `push` only, each invitation audited
  (confirmed by the product owner 2026-09-30).
- Blocks: M4-03, M4-05.
- **Status**: settled 2026-09-30 (product owner, conversation).

### D28 — Disconnecting a classroom that has a journal
- **Question**: the journal is a repository of the classroom's organization
  (D03, D27). What happens to it when a teacher disconnects the classroom
  from GitHub, or connects it to another organization? Found by M0-04
  (journal track), spec F-GH-04 and 06 no. 33.
- **Options**: (a) refused while the classroom has a journal; (b) the
  journal is removed with the link (its copy dropped, the repository
  kept); (c) the journal stays, read-only, in error, until removed.
- **Suggested**: (a), `409` with a message that says to remove the
  journal first: nothing is lost by surprise, and (b) is one click away.
  Projects will raise the same question for their repositories.
- Blocks: M2-02 (disconnect route), M4-03.
- **Status**: settled 2026-09-30 (product owner, conversation): (a).

## Taken with the journal's two modes (2026-10-01)

### D29 — The journal's two modes
- **Question**: D25's byte-exact round trip holds (M4-06), but it costs a
  reconciler and a second editor schema that every new markdown construct
  can break, and a novice still needs a GitHub organisation, the App and a
  connected classroom before writing a page. Must every journal be a
  repository?
- **Answer**: a journal has a **mode**, chosen at its creation in the
  Journal section of Settings ("In Quiz" / "In a GitHub repository"; fr
  "Dans Quiz" / "Dans un dépôt GitHub"; never "local").
  **In Quiz** (default): no GitHub needed; the database is the content;
  edited with the platform's standard Tiptap editor, normalisation
  accepted; revisions. **In a GitHub repository**: the repository is the
  content, edited in the teacher's own tools; the platform is read-only
  for it (push webhook, Refresh) and each page links to "Edit on GitHub",
  the primary action of the staff bar there. Changing mode is an action,
  never a toggle. Four points settled in the same conversation:
  1. **Paths and order (Quiz mode)**: a page's path is stable (it never
     changes when the page moves), the order among siblings is an explicit
     field, nesting a parent page. "Move to GitHub" writes numeric prefixes
     into the file names it commits and rewrites the relative links.
  2. **Copy a journal from another classroom** of the course: later
     (M4-13), not in the first version.
  3. **Revisions**: one per Quiz-mode save, markdown and front matter only,
     no limit; assets are not versioned: append-only, and kept until the
     journal is removed (amended with M4-08: collecting the assets no page
     references would break a revision restored later). The staff restore a revision; restoring is
     audited. **Deleting a page keeps its revisions** (settled with M4-08,
     orchestrator): they live until the journal is removed, so a deleted
     page can be restored later — restoring a revision of a deleted path
     creates the page again. `author_id` keeps `no action` on user
     deletion, as the repository's other authored history rows
     (`questions.created_by`, `classroom_journals.created_by`).
  4. **Move to GitHub**: into a new repository or an empty one only, never
     one with content (ADR-049 point 6). "Bring back into Quiz" imports the
     copy and detaches the repository without deleting it, after showing
     what is left behind and that the first save normalises the markdown.
- **Consequences**: [ADR-057](../adr/ADR-057-journal-two-modes.md);
  supersedes D25; amends ADR-049 (body point 2 for Quiz mode, addendum
  points 2 and 7), D24 (the Journal section no longer waits for a
  connection), D27 (the App writes into a journal repository only to seed
  it and for Move to GitHub) and D28 (the `409` applies to a GitHub-mode
  journal only). Existing journals migrate to GitHub mode, read-only;
  Bring back into Quiz is their way back. Removing a Quiz-mode journal or
  deleting its classroom destroys the only copy: the confirmation names
  the number of pages and, when there are pages, the teacher types the
  classroom's name. `reconcile.ts`, `journalSchema.ts` and the
  `journal: true` mode of `richTextExtensions` are deleted by M4-09.
- Blocks: M4-07 to M4-13.
- **Status**: settled 2026-10-01 (product owner, conversation).
