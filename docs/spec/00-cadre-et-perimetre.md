# 0. Context, objectives and scope

## 0.1 Context

- A project by a HEIG-VD teacher for his own courses. Developed by the teacher, assisted by Claude.
- Hosting: one Hetzner VM, Docker Compose deployment, a single node.
- Users: HES-SO students and teachers authenticated by edu-ID, one admin.
- Main use: in-class evaluations (20 to 30 students), exercises at home, live polls, individual practice, and, since the merge, programming projects in GitHub repositories.
- Since the merge of heig-classroom (ADR-035, 2026-09-28; the working plan is [`docs/merge/`](../merge/README.md)): a classroom may also carry its **journal**, the course documentation read in the app (kept in Quiz or in a GitHub repository, ADR-057), its **projects**, graded work in student GitHub repositories, and its **gradebook**. GitHub stays optional: a classroom without it is a plain Quiz classroom.

## 0.2 Why a home-grown system

Teacher-owned question pools, edu-ID identity, live evaluations, controlled code
execution and teacher-validated grading share one platform. The
[original comparison](history/scope-planning.md#02-why-a-home-grown-system)
records the initial rationale; it is not a current product comparison.

## 0.3 Objectives

1. A teacher creates a 10-question evaluation from their pool in under 10 minutes.
2. A quiz with 30 students runs without any visible network incident: every answer is saved as soon as it is typed, a disconnection loses nothing.
3. The teacher's dashboard reflects the state of the students in under one second.
4. Automatically graded questions yield a provisional grade as soon as the evaluation closes. The others are proposed by the LLM and validated by the teacher in a single pass.
5. The export of grades to the tenth, on the 1 to 6 scale, is available as CSV as soon as they are validated.
6. The whole content of a pool exports to text files that can be versioned in git, and imports back without loss.

## 0.4 Constraints

- Team: one person plus an AI assistant. The spec favours operational simplicity: one repository, one database, one VM.
- Starting point: the `~/heig-classroom` repository by the same author, in production, provides the edu-ID auth, the design system, the deployment infrastructure and the container hardening. See [07-reutilisation-heig-classroom.md](07-reutilisation-heig-classroom.md).
- Load: 20 to 30 students per quiz, 100 students simultaneously on the platform, code execution peaks of 30 runs in 10 seconds; a project deadline applied to 100 repositories in under 5 minutes (N-PERF-07).
- Languages: interface in French and in English. Question content in the teacher's language.
- Auth: edu-ID only for named accounts. A session code allows anonymous participation in polls. Linking a GitHub account (F-GH-05) is never a way to sign in: it attaches a GitHub identity to an edu-ID account.
- GitHub: the platform acts on GitHub through its own GitHub App (D23 of `docs/merge/08-decisions.md`), installed by a teacher on an organization; production and staging have separate Apps, and staging never holds the production one (N-SEC-18).
- Data: answers and grades are personal data. See [03-exigences-non-fonctionnelles.md](03-exigences-non-fonctionnelles.md), data section.
- Browsers: current versions of Chrome, Firefox, Safari, Edge. Mobile and tablet for every type except code and diagram, which remain usable but are optimised for desktop.

## 0.5 Phases

The [original phase tables](history/scope-planning.md#05-phases) are history.
P1 / P2 / P3 in the requirements record planning priority, not delivery status;
M = must, S = should, C = could.

| Work | Read |
|---|---|
| Current product behaviour, including questions, evaluations, drill, journal, projects and gradebook | [Functional requirements](02-exigences-fonctionnelles.md) and [question types](04-types-de-questions.md) |
| Security, reliability, operations and load targets | [Non-functional requirements](03-exigences-non-fonctionnelles.md) |
| Architecture and decision rationale | [Architecture](05-architecture.md) and [ADR index](../adr/README.md) |
| Merge delivery order and remaining work, including the online workspace | [Merge entry point](../merge/README.md) and [progress](../merge/PROGRESS.md) |
| Decisions not yet settled | [Open questions](06-questions-ouvertes.md) |

The journal supports Quiz and GitHub modes (ADR-057). Teachers may create
projects before the cutover through Quiz's own App (D26 addendum, ADR-062).
The online workspace stays after the cutover (D09). Requirements describe
intended behaviour; their presence alone does not certify implementation.

### Phase 1, MVP: run a graded quiz in class

[Original planning table](history/scope-planning.md#phase-1-mvp-run-a-graded-quiz-in-class).

### Phase 2: LLM, exercises, statistics

[Original planning table](history/scope-planning.md#phase-2-llm-exercises-statistics).

### Phase 3: advanced types and extensibility

[Original planning table](history/scope-planning.md#phase-3-advanced-types-and-extensibility).

### Merge of heig-classroom (ADR-035)

[Original planning table](history/scope-planning.md#merge-of-heig-classroom-adr-035).

## 0.6 Out of scope

- Heavy proctoring: webcam, lockdown of a student's own device. (Safe Exam Browser is in scope since ADR-027: an exam may require it, launched from the portal without a second sign-in. The school's own Chromebooks, locked in a web kiosk and attested by Chrome Verified Access, are in scope since ADR-051 as fallback stations for an exam, paired from the student's phone.)
- Comparison of electronic schematics by topology: netlist isomorphism, series/parallel
  canonicalisation, "the same circuit drawn differently". The `circuit` question type
  grades a schematic by SIMULATING it and comparing the output waveform with the
  reference's (ADR-019), which is in scope; what it never does is decide whether two
  netlists are the same graph. Pick-and-place is graded by LLM or manually.
- Management of study plans, credits, absences. The platform exports grades, it does not administer them.
- Institutional multi-tenancy: a single admin, a single instance.
- Code editor with a full language server. Monaco with highlighting and shortcuts is enough. (This is about the question editors; the online workspace of the merge, ADR-035, is specified with it.)
- A general-purpose GitHub client: the platform touches GitHub only for what a feature needs (the journal, projects). It never deletes a repository: not when a journal is removed (F-JRN-04), not when a project or a classroom is deleted (F-PROJ-16).
- Grading a project's repository in `apps/runner`, and a platform LLM review of projects: a project is graded by its own CI on the CI runners, and reviewed by the LLM there (D17); both may move into the platform later (phase L of the merge).
- Hot installation of plugins from a remote repository.

## 0.7 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| VM outage during an exam | High | Server-side autosave on every keystroke, transparent resume, backups, documented failover procedure, paper fallback mode |
| Escape from the code sandbox | High | Containers without network, gVisor, CPU / memory / pids / time limits, read-only image, no reachable secrets |
| Wrong LLM grading on an official grade | Medium | Always validated by the teacher, justification per criterion, confidence score, traced re-grading |
| Cost or unavailability of the LLM provider | Medium | Deferred grading, never in the critical path of the quiz, a daily spending cap on the institutional key (ADR-058, which replaced the key per teacher) |
| Leak of the pool's questions | Medium | The pool is never served to students, only the questions of a running evaluation are, without the key |
| Scope creep | High | Keep the documented scope; record new decisions and their delivery priority explicitly |
| GitHub unavailable, or its rate limit reached | Medium | The journal is a read model in Postgres: a page view never calls GitHub, an outage only delays the next synchronisation (N-RES-07) |
| A forged CI score: the student's code runs in the run that reports it | Medium | A score is indicative until the teacher releases it; two `GRADE` annotations void a run; the teacher may override (N-SEC-21) |
| A deadline applied late or twice on 100 repositories | High | The receipt time of every push written as the webhook arrives; the deadline claimed in the database, applied idempotently, with a time budget (N-PERF-07, N-RES-08) |
| The platform acts on the wrong repositories (a staging copy of production driving real ones, a leaked App key) | High | Quiz's own Apps, one per environment; staging never holds the production App; the key and the webhook secret outside the repository and the database (N-SEC-16, N-SEC-18) |

## 0.8 Decision log

The [dated scope decision log](history/scope-planning.md#08-decision-log)
is preserved as history. Follow the [ADR index](../adr/README.md) for
decisions and their amendments; do not infer precedence from a date alone.
