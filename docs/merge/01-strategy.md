# 1. Strategy

## 1.1 The target

One platform at `quiz.chevallier.io`. A teacher's classroom hosts:

| | What | Owner module | Students see it |
| --- | --- | --- | --- |
| **Evaluations** | exams, exercises, polls (a mode) | `evaluation`, `live`, `poll`, `grading`, `results` | as today |
| **Projects** | a GitHub repository per student or group, deadline, protected files, CI grading, optional online workspace | `project` (+ `github`) | only when a project is published in one of their classrooms |
| **Journal** | course documentation from a GitHub repository | `journal` (+ `github`) | a Journal tab, only when the classroom has one |
| **Grades** | released grades of every graded activity | `gradebook` (reads the others) | a Grades tab |

A student reaches a classroom from **Courses** and sees **Activities**
(default tab), **Journal** (if any), later **Grades** (M5-04). A teacher
sees Roster, Activities (with a "New ▾" menu: Evaluation, Poll, Project),
Journal (if any), Grades and Settings.

GitHub is optional for everyone: a teacher connects a classroom to an
organization from the classroom's Settings (D24), or from "New project",
which opens the same sheet; a student links their GitHub account when a
project asks for it.

## 1.2 Principles

1. **Quiz is the base; classroom is ported, not rewritten.** Code that
   encodes production experience moves with its tests (the GitHub adapters
   ~ verbatim). Concepts both apps have keep Quiz's implementation.
2. **Deployable at every step.** Additive migrations, features off while
   their configuration is empty (`GITHUB_APP_*`, `CODESPACE_URL`), nothing
   visible to a student who has no project. Every phase before M8 ships to
   production through the normal pipeline (ADR-028).
3. **The migration grows with the port.** The import script exists from
   phase M1 (identity first) and every task that adds a ported table adds
   its import step and its fixture in the same PR. At the cutover it is a
   script that has run on every rehearsal, not one written the week before.
   One exception, the journal track: it runs before M1-06, and its import
   step (one classroom row per attachment, then a re-ingest) is written by
   M8-01, since no page or asset is copied.
4. **Invariants first.** Each ported flow is rewired onto Quiz's invariants:
   `staffAccess` loaders, contracts in `packages/contracts`, the audit
   union, `app.clock.now()`, `t()` in en and fr, the single-exit student
   view. Classroom's shortcuts on these points (English-only teacher UI,
   server-built English messages, `Date.now()`, a `classroom:` SSE topic
   reaching students) are not carried over.
5. **Small PRs, one migration each.** The hot files (schema, audit,
   contracts, i18n, the ticker) are touched by many tasks: a task keeps its
   diff there minimal and rebases often.
6. **Classroom keeps living until the cutover.** It stays in production.
   A fix merged into classroom after the sync point recorded in
   `PROGRESS.md` is forwarded to the ported code (the task that owns the
   file, or a `fwd:` task). The sync point is moved at the end of each phase.

## 1.3 Phases

Task ids are `M<phase>-<nn>`; the cards are in [`09-tasks.md`](09-tasks.md).
"Prod-safe" = can reach production before the data migration without
changing what an existing student sees.

| Phase | Content | Prod-safe | Exit criterion |
| --- | --- | --- | --- |
| **M0 — Decisions and paper** | Blocking decisions settled, production measured, ADR-035 accepted, classroom ADRs imported, spec and `CLAUDE.md` amended | yes (docs) | The decisions marked *blocks M1* in `08-decisions.md` are settled; the spec-challenger has no open objection on ADR-035 |
| **M1 — Foundations** | Pure domain ports, GitHub adapter layer, `ActivityKind` + `ActivitySummary` union, missing primitives and long-form styles, migration script skeleton with identity matching | yes, invisible | CI green; `/activities` unchanged; the import script dry-runs identity on a fixture |
| **M2 — GitHub substrate** | `github` tables, installations and org link, account linking, webhook intake and delivery reconciliation, periodic tasks, Quiz's production and staging Apps (D23), the classroom's Settings tab | yes: nothing changes for a classroom whose teacher does not connect it | On staging with the staging App: installation resolved, webhooks received and deduplicated, a missed delivery replayed; then one classroom connected in production |
| **M3 — Projects** | Project tables and lifecycle, acceptance and provisioning, ingestion and grading, deadline / freeze / dispatch, reconciliation, sync, teacher and student views, groups (M3-15/16) | no: projects open with the import (D26), at the cutover | A pilot on staging walks classroom's user stories; 100 repositories at a deadline applied in < 5 min; a student-view leak test on projects |
| **M4 — Journal** | Pure renderer, journal module (read, then write), reader and teacher tab, WYSIWYG editor (D25) | yes: renders only where a teacher set a repository | A staging journal mirrors a repository; drafts and `visible_from` do not leak (pages nor assets); then live in production for the classrooms that opt in |
| **M5 — Student classroom page and gradebook** | The student classroom page and the Courses route (M5-01/02, shipped with the journal), then the gradebook module and the teacher Grades tab | the student page is the first visible change for students (D07) | The gradebook equals per-evaluation results on the seeded world; staff seats never appear in it |
| **M6 — Online workspace and SEB** | `packages/seb`, `apps/codespace` imported, its CI/CD, the Quiz `codespace` module, SEB for projects, engine VM capacity | yes, opt-in work mode | A supervised session opens from a Quiz project; proof B (real SEB) recorded. **Off the critical path if production has no online assignment (D09)** |
| **M7 — Finishing** | Palette, help, tours, user guide pages and screenshots | yes | The guide documents projects, journal and GitHub setup |
| **M8 — Migration and cutover** | Import script complete, legacy URL resolver, Caddy fragments, codespace identity remap, runbook, rehearsals, the cutover | **no — this is the switch** | A rehearsal on staging with a production dump passes its parity report; then the real cutover and a clean reconciliation |
| **M9 — Decommission** | Point of no return, permanent redirects, classroom stack removed, repository archived, #143 closed | yes | Nothing of classroom runs |
| **L — Later** | Platform `llm` module, runner grading of projects, `packages/ui-kit` extraction | yes | Not needed for the merge |

### The journal first (2026-09-30)

The product owner put the journal ahead of projects: it needs the whole
GitHub substrate but no grade, no deadline and no student repository, so it
proves the substrate on the least risky feature, and it is useful on its
own. With Quiz's own App (D23) it goes live in production before the
cutover, classroom by classroom. The order of that track:

```
M0-03/05 paper ── M1-02 adapters ── M2-01 schema ── M2-02 installs ─┬─ M2-04 webhooks ── M4-02 read ── M4-03 writes
                  M1-04 primitives ── M1-05 routes ── M2-07 Settings ┘   M2-03 account link ┘
M1-01 domain ──── M4-01 renderer + schema ─────────────────────────────── M4-04 reader, M4-05 tab, M4-06 editor
M1-03 activity ── M5-01 student classroom API ── M5-02 student classroom page + Courses route
M2-06 staging and production Apps (product owner's hands) — before the first deploy that reads GITHUB_*
M0-04 spec (journal, Courses, Settings tab) and M0-05 invariants — before M2-01
```

The periodic work the journal needs runs on the ticker: `reconcile.deliveries`
as a scheduled task (M2-05, D10, which lands first), the J4 `visible_from`
sweep as a clock-bound tick task. The
student reader (M4-04) reaches students only through the student
classroom page (M5-02): a classroom's journal is live for its students
when both are merged.

Projects (M3) follow on the same substrate. They do not go live before
the cutover: project creation opens in Quiz on the day classroom's data
is imported, and from then on Quiz mirrors classroom (D26, 2026-10-01).

### Critical path

```
M0-01 decisions ─┬─ M0-03 ADRs ── M1-02 adapters ── M2-01 github schema ── M2-02 installs ── M2-04 webhooks
M0-02 measures ──┘                                                                         │
            M1-01 domain ── M3-01 project schema ── M3-02 lifecycle ── M3-03 provisioning ──┴─ M3-04 ingestion
                                                                            ── M3-05 deadline ── M3-08 teacher views
M3-* + M4-* + (M6-* if D09) ── M8-01 script complete ── M8-06 rehearsal ── M8-07 cutover ── M9-01
```

Everything web-side (M2-07, M3-10…13, M4-04…06, M5-02) runs in parallel
with the API tasks it depends on, as soon as the contract of that API is
merged (the mock serves the contract).

### Parallelism

The dependency graph allows four to five agents at once in M1–M4 (for
example: one on the GitHub/project API chain, one on the journal chain, one
on the web side, one on the migration script, one on M5). Beyond that the
hot files (schema, audit, contracts, i18n) make rebases costlier than the
gain. Respect `AGENTS.md` §7: one full test suite at a time on the machine.

## 1.4 What stays deliberately out of the merge

- **Platform LLM grading.** Classroom's LLM review runs in the student
  repository's GitHub Actions (a `repository_dispatch` after the freeze);
  it is ported as is. A platform `llm` module (qt-rich, the `short` LLM
  matcher, projects) is phase L.
- **Runner grading of a repository.** Projects stay graded by CI on the
  self-hosted Actions runners (ADR-007); a tarball of the repository at the
  frozen sha sent to `apps/runner` is phase L.
- **Extracting `packages/ui-kit`.** Welcome, but independent: the merge
  only adds the handful of primitives it needs.

## 1.5 Cutover in one paragraph

(Details and rollback in [`06-codespace-seb-infra.md`](06-codespace-seb-infra.md).)
The journal (and the GitHub substrate) is already live in Quiz with its own
App (D23); what is still dark is what only migrated data can use. Before
T0 the teachers create their classrooms in Quiz, install Quiz's App and
connect them to their organization by hand (the import makes no
organization link; spec 06 no. 47), and validate the correspondence
table classroom → Quiz (D22). At T0 — during the autumn
semester, as soon as M3 and M8-01 are ready (D20; no deadline, no live
evaluation, no live workspace session in that hour) —
a Caddy maintenance fragment freezes classroom (webhooks answer 503),
classroom's database is dumped, the import script runs on Quiz's database,
the GitHub account links come over with the import (spec 06 no. 45),
the
reconciliation jobs (`reconcile.repos`, `reconcile.grades`) catch up
from the repositories themselves, and `classroom.chevallier.io` becomes a
redirect fragment
(302 during observation, 301 after the point of no return). Target: under
one hour. Until the point of no return, classroom's database is untouched
and the rollback is: restore the fragment, start classroom (its App never
moved).
