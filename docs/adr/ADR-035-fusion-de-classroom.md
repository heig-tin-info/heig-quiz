# ADR-035 — Merging heig-classroom into Quiz: one platform, one roster, activities of several kinds

## Status

Accepted (2026-09-30). Proposed on 2026-09-28, asked for by the product
owner on issue #143; accepted once the decisions blocking phase 1 were
settled (`docs/merge/08-decisions.md`: D01, D02, D04, D08, D16 on
2026-09-28; D03, D07, D14, D15, D23, D24, D25, D27 on 2026-09-30, when the
journal was moved to the front of the plan and given Quiz's own GitHub
App). This ADR records the direction and the rules of the merge; the work
itself is planned and tracked in `docs/merge/` (strategy, task cards,
progress). The decisions still `open` there are not taken by this record:
where a paragraph below touches one, it names it.

It **supersedes ADR-029** (a UI library shared by two apps as an npm
package): the one alternative ADR-029 rejected — merging the two
products — is the decision here.

Classroom's ADRs imported with it: its ADR-011 as
[ADR-011](ADR-011-reconciliation-par-les-handlers.md), its ADR-013 as
[ADR-047](ADR-047-espace-de-travail-en-ligne.md), its ADR-014 as
[ADR-048](ADR-048-projets-de-groupe.md), its ADR-015 as
[ADR-049](ADR-049-journal-source-github.md).

Follow-up decisions: [ADR-057](ADR-057-journal-two-modes.md) for the journal modes, [ADR-061](ADR-061-adoption-des-comptes-importes.md)
for imported identities, [ADR-062](ADR-062-depot-de-distribution.md) for distribution repositories and
[ADR-064](ADR-064-echeance-des-projets-baux.md) for project deadlines. These refine their respective scopes,
not the whole merge decision.

## Context

Quiz started as a pruned copy of heig-classroom
(`docs/spec/07-reutilisation-heig-classroom.md`). Three months later the two
products serve the same people for the same courses:

- **The same students and the same classes.** A class that takes quizzes
  and polls is, as a rule, the class that delivers code in GitHub
  repositories. Today it is two rosters to import, two staff lists, two
  sign-ins, two places to find a grade.
- **The same substrate.** Identical identity tables (`users`,
  `user_emails`, `user_idp_claims`, `avatars`, `teacher_grants`,
  `audit_log` are copies of each other), the same edu-ID key, the same
  stack (Fastify, Drizzle, pg-boss, SSE, React 19, Tailwind 4), the same
  two-step grade freeze (ADR-012, byte-identical in both repositories), the
  same deadline ticker (ADR-006), the same app VM.
- **The same needs, built twice.** Grading and grades, deadlines, isolated
  execution of student code (Quiz's `apps/runner`, classroom's
  `apps/codespace`), Safe Exam Browser (two implementations with different
  threat models), LLM feedback (placeholders in Quiz, a GitHub Actions
  dispatch in classroom), notifications, design system (55 primitives with
  the same name, maintained twice — the finding of ADR-029).

ADR-029 answered the last point with a shared npm package and explicitly
rejected merging, "at the price of coupling two products deployed, operated
and reviewed separately". Seen from the product, they are not two products:
they are two kinds of work in the same classroom.

What classroom has that Quiz does not:

1. **GitHub**: an App installed on organizations, a repository per student
   or per group created from a source repository, protected files, a
   deadline applied on the repositories, CI grading, reconciliation.
2. **The journal**: course documentation kept in a GitHub repository,
   rendered by the platform, read by the students (classroom ADR-015, imported as
   [ADR-049](ADR-049-journal-source-github.md)). A
   teacher's tool, not an activity.
3. **The online workspace** (`apps/codespace`): code-server in a hardened
   container, optionally under SEB. Deployed, never used by a real class.

## Decision

### 1. One platform: classroom is ported into this repository

Quiz is the base. Classroom's capabilities are **ported** into it as
modules, and classroom's production data is **migrated** into Quiz's
database by a one-shot script at a planned cutover. After the cutover
`classroom.chevallier.io` redirects to Quiz and the classroom stack is
stopped, then archived.

"Ported" means: the code that carries production-hardened behaviour (the
GitHub adapters, provisioning, deadline application, webhook intake,
reconciliation, grade selection — fixes #10, #15, #33, #37–#41 of
classroom) is moved with its tests and rewired onto Quiz's substrate, not
re-derived. What both have (identity, roster, staff, notifications, audit,
ticker, UI primitives) keeps Quiz's version; classroom's version is read for
behaviour Quiz lacks, never copied beside it.

### 2. A classroom hosts activities of several kinds, and a journal

A student who enters a classroom sees three things: its **activities**, its
**journal** if there is one, and a **grades** tab (D06, settled
2026-10-01; see §3). The door is **Courses**, the list of the student's classrooms, each
opening its page; **Activities** stays the summary of the active
activities across every classroom (D07). The teacher's classroom page
gains a **Settings** tab, home of the GitHub connection and of the
journal (D24).

- **Evaluation** — exists: exam, exercise, and poll as a mode
  (`evaluations.mode`, ADR-014).
- **Project** — new: work delivered in a GitHub repository per student or
  group, with a deadline, protected files, CI (and later runner or LLM)
  grading, optionally an online workspace. The French UI word is "Projet".
  "Assignment" stays a forbidden synonym (glossary).
- **Journal** — not an activity: course documentation, read-only for
  students, never graded. [ADR-057](ADR-057-journal-two-modes.md) amends its source: in Quiz
  or in a GitHub repository.

The activity abstraction is **thin**: a TypeScript interface
(`ActivityKind`) implemented by the service of each owning module (list for
a classroom, student cards, gradebook entries, deadlines), and a
discriminated `ActivitySummary` union in `packages/contracts`. There is no
shared `activities` table and no registry in the style of the question
types: two kinds share too little behaviour to pay for it, and each keeps
its own tables and state machine (a table belongs to one module).

### 3. Shared services, not shared tables

Each activity kind calls the same services: roster and staff (`org`),
deadlines (the single ticker, ADR-006), notifications (ADR-030), audit (one
closed union), SEB (ADR-027 launch tickets; how they reach a project is
D21, settled 2026-10-01), runner (ADR-016), and later one `llm` module. Grades meet in a
**gradebook** module that owns only its column table and reads the released
results of each kind. A project score is frozen by the clock as ADR-012
states (read literally for projects); when and on what scale it reaches the
gradebook is D05 (after a teacher release, on a per-project scale), and the
gradebook's rules are D06 — both settled on 2026-10-01 (F-PROJ-14, F-GBOOK).

### 4. GitHub is optional

- The GitHub features are off when the `GITHUB_*` settings are empty. Production
  turns them on with Quiz's own App as soon as it is registered; staging
  always has its own App on a test organization and never holds the
  production one (ADR-028 restores production dumps into staging).
- A classroom is connected to a GitHub organization **when a teacher
  chooses to**, from the classroom's Settings, never at creation; using
  Quiz without GitHub stays the default. A classroom has at most one
  journal, which is one repository of that organization.
- A student meets GitHub **only when a project asks for it**: the project
  row walks link account → create repository → accept invitation → open.
  A student with no project sees nothing of GitHub.
- Quiz registers its own GitHub App (production, and a separate one for
  staging); classroom's App keeps serving classroom until the cutover.
  Both coexist on an organization, so GitHub features reach Quiz's
  production before the cutover; organizations still used by classroom
  install Quiz's App before it.

### 5. Deployable at every step, the data migration last

Every phase before the cutover ships to production through the normal
pipeline (ADR-028), with additive migrations only. A feature that needs
no migrated data (the GitHub substrate, the journal) goes live when it
ships, for the classrooms whose teacher turns it on; the rest waits behind
switches that are off or empty. The migration script is maintained alongside the port (it follows every
schema change of the ported tables) and rehearsed on staging against a
production dump before it runs once for real.

### 6. What the merge changes elsewhere

- **ADR-029** is superseded. The UI primitives still move out of
  `apps/web/src/ui/` into a workspace package (`packages/ui-kit`, not
  published), and `@quiz/ui` (question-type surfaces) builds on it. The
  sentence of `CLAUDE.md` that sends generic primitives to
  `@heig-platform/ui` is changed.
- **ADR-007** (self-hosted GitHub Actions runners) applies again, to
  project CI.
- **ADR-010** gets back the GitHub secrets it had removed (App key, webhook
  secret, client secret) and gains the codespace launch secret.
- **ADR-006** gains the project sweeps; **ADR-012** gets an addendum giving
  its literal (projects) and analogical (evaluations) readings;
  **ADR-016** hosts the codespace beside the runner; **ADR-027** confines a
  `seb` session to an activity rather than an evaluation (the design is
  D21, settled 2026-10-01); **ADR-030** gains the project notification kinds (their list
  is D18, settled 2026-10-01). Each of these records carries a status note saying so.
- **Classroom's own ADRs** are imported, bodies verbatim, with a status
  line naming the former number and the renames: its ADR-011
  (reconciliation handlers) into Quiz's free 011 slot,
  [ADR-011](ADR-011-reconciliation-par-les-handlers.md); its ADR-013
  (online workspace) as [ADR-047](ADR-047-espace-de-travail-en-ligne.md),
  ADR-014 (group assignments) as [ADR-048](ADR-048-projets-de-groupe.md)
  and ADR-015 (journal) as [ADR-049](ADR-049-journal-source-github.md),
  the next free numbers at import time (036–046 were taken). ADR-049 has
  an addendum: how the port differs (one journal per classroom, D03).
  Classroom's 001–010 and 012 are not imported: Quiz's copies are
  authoritative.
- **The spec**: 07 is frozen as history; 00, 01, 02, 05, 06 and 08 are
  amended (the list is `docs/merge/07-incompatibilities.md`).
- **Invariants**: invariant 4 (`toStudent`, one exit) is generalized to
  "activity content reaches a student only through its kind's student
  view", and the journal's student view is the journal's one exit (no
  draft, no page before its `visible_from`, no markdown, blob sha nor
  warning); invariant 6 gains a student branch (`readableClassroom`: a
  claimed enrollment reads its classroom, anyone else gets the 404);
  invariants 11 and 12 (closed network, nothing mounted) are scoped
  to `apps/runner`, `apps/codespace` carrying its own `CLAUDE.md` with its
  two sanctioned divergences (a persistent work volume, a git channel on an
  internal bridge).

## Consequences

- One roster, one sign-in, one gradebook for a class; one place to fix a
  bug in a primitive, the ticker, SEB or the audit.
- The Quiz repository grows by roughly 6 000 lines of GitHub code, a
  journal module and, later, a second deployable (`apps/codespace`). Its
  CI and its concurrent agents carry it.
- Classroom's teacher screens were English-only by decision; here every
  string goes through `t()` (N-I18N-01). Porting a screen includes
  translating it.
- A classroom-classroom (one org, one owner, no course) becomes a Quiz
  course plus classroom: access widens from the classroom's staff to the
  course's staff, and owner-only actions become staff actions.
- The cutover is a short freeze with a written rollback; until its point of
  no return the classroom database stays untouched.
- `@heig-platform/ui` is not created. Issue #143 stays open until the
  merge is complete: it closes at the decommission of classroom (task
  M9-01 of `docs/merge/`), not with this ADR.

## Rejected alternatives

- **Keep two apps and share an npm UI package (ADR-029).** Solves the
  design-system duplication only; the roster, grades, SEB, ticker and
  runner stay duplicated, and a class still lives in two places.
- **A shared backend library for both apps.** Same cost as a merge (every
  shared concept must be reconciled), none of the benefit for users.
- **Rewrite classroom's GitHub side from its specification.** Loses the
  fixes learned in production (quota exhaustion, renamed accounts, stale
  live state, free-plan rulesets, symlink escapes in the student handout).
- **A generic `activities` table as a supertype of evaluations and
  projects.** Migrates every evaluation row and its CHECKs, fits neither
  evaluation templates nor anonymous polls, duplicates state between the
  supertype and each kind.
- **Migrate the data first, port afterwards.** Leaves migrated rows with no
  code to serve them; the port is what makes the migration testable.
