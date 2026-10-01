# 0. Context, objectives and scope

## 0.1 Context

- A project by a HEIG-VD teacher for his own courses. Developed by the teacher, assisted by Claude.
- Hosting: one Hetzner VM, Docker Compose deployment, a single node.
- Users: HES-SO students and teachers authenticated by edu-ID, one admin.
- Main use: in-class evaluations (20 to 30 students), exercises at home, live polls, individual practice.
- Since the merge of heig-classroom (ADR-035, 2026-09-28; the working plan is [`docs/merge/`](../merge/README.md)): a classroom may also carry its **journal**, the course documentation kept in a GitHub repository and read in the app, and, later, its **projects**, graded work in student GitHub repositories. GitHub stays optional: a classroom without it is a plain Quiz classroom.

## 0.2 Why a home-grown system

| Need | Moodle / CodeRunner | Wooclap, Kahoot, etc. | This project |
|---|---|---|---|
| edu-ID auth and automatic matching of students | Yes through Cyberlearn, but heavy | No | Yes, native |
| Clean, modern interface, real time | No | Yes, but geared towards animation | Yes |
| Code questions run in a sandbox | CodeRunner, dated UI | No | Yes, native |
| LLM-assisted grading, framed and validated by the teacher | No | No | Yes, a differentiator |
| Versioned question pool, shared, exportable as text | Partial | No | Yes |
| Spaced practice on the questions of the course | No | No | Yes, phase 2 |
| Free, no advertising, data on a server under our control | Yes | No | Yes |
| Course notes written in markdown, versioned in git, read by the class in the same app | Pages, not versioned | No | Yes, the journal (ADR-035) |

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
- Load: 20 to 30 students per quiz, 100 students simultaneously on the platform, code execution peaks of 30 runs in 10 seconds.
- Languages: interface in French and in English. Question content in the teacher's language.
- Auth: edu-ID only for named accounts. A session code allows anonymous participation in polls. Linking a GitHub account (F-GH-05) is never a way to sign in: it attaches a GitHub identity to an edu-ID account.
- GitHub: the platform acts on GitHub through its own GitHub App (D23 of `docs/merge/08-decisions.md`), installed by a teacher on an organization; production and staging have separate Apps, and staging never holds the production one (N-SEC-18).
- Data: answers and grades are personal data. See [03-exigences-non-fonctionnelles.md](03-exigences-non-fonctionnelles.md), data section.
- Browsers: current versions of Chrome, Firefox, Safari, Edge. Mobile and tablet for every type except code and diagram, which remain usable but are optimised for desktop.

## 0.5 Phases

MoSCoW priority: M = must, S = should, C = could.

### Phase 1, MVP: run a graded quiz in class

| Area | Content | Prio |
|---|---|---|
| Auth | edu-ID OpenID Connect, teacher / student / admin roles | M |
| Organisation | Course, classroom, roster imported from CSV or self-enrolment at sign-in | M |
| Pool | Private pool per teacher, categories, tags, draft then publication, numbered versions | M |
| Questions | Multiple choice, short answer, cloze, stdin/stdout code | M |
| Evaluation | Timed exam mode, waiting room, free / forward only navigation, shuffling, extra time per student | M |
| Live run | Autosave, real-time SSE, server clock, pause, +1/+5/+10 min, manual or automatic close | M |
| Grading | Automatic for the 4 types, validation panel, manual override, annotated re-grading | M |
| Grades | 1 to 6 scale to the tenth, CSV export, configurable feedback | M |
| Dashboard | Live students x questions grid, show / hide names and answers | M |
| Export | Canonical YAML format of the pool, import / export, token API | S |
| Expert | WYSIWYG / source toggle, `Ctrl+K` palette, shortcuts | S |
| UX | Home-grown design system, light / dark, responsive | M |

### Phase 2: LLM, exercises, statistics

| Area | Content | Prio |
|---|---|---|
| Questions | Rich markdown answer graded by LLM, random numeric values | M |
| LLM | "Generate the answer", variants, explanations, expected outputs computed by the reference solution, proposed grading, API key per teacher or institutional | M |
| Expert | `quiz pull` / `push` CLI, raw YAML editing, regex tester, bulk operations | S |
| Evaluation | Open exercise mode with a deadline, one-question poll mode with a session code | M |
| Pools | Pools shared between teachers, reader / contributor / owner roles, fork with provenance | S |
| Statistics | Difficulty and discrimination indices per question (ADR-038), distractor analysis, answer time | S |
| Drill | FSRS spaced practice, a daily drill, strengths and weaknesses per tag | S |
| Import | GIFT and Moodle XML | C |

### Phase 3: advanced types and extensibility

| Area | Content | Prio |
|---|---|---|
| Questions | Diagram (`diagram`, eight notations from UML classes to automata, graded by hand in v1; it replaces the drawing type, ADR-046). The schematic type (`circuit`) was brought forward and now ships with a simulation grading, ADR-019; the code-image type (`codeimage`) was brought forward too, as a variant of `code` graded pixel by pixel, ADR-021; the categorize type (`categorize`, cards sorted into columns, with negative marking like `mcq`) was added, ADR-036 | S |
| Code | TAP unit tests, additional files, locked regions, further languages | S |
| Plugins | External question packages, loaded at build time | C |
| Generation | "Generate 10 min quiz" by tags and difficulty | C |
| Integrations | MCP server to author from an LLM client. Brought forward and shipped with the personal API tokens (ADR-022, ADR-023) | C |

### Merge of heig-classroom (ADR-035)

Carried by the task cards of [`docs/merge/09-tasks.md`](../merge/09-tasks.md), in the order of [`docs/merge/01-strategy.md`](../merge/01-strategy.md). The journal goes first and goes live in production before the cutover, classroom by classroom, through Quiz's own GitHub App.

| Area | Content | Prio |
|---|---|---|
| Classroom | A **Settings** tab on the teacher's classroom page: rename, archive, delete, drill, GitHub, journal (F-ORG-13) | M |
| GitHub | Connect a classroom to an organization where Quiz's App is installed, with its checks; link one's GitHub account (F-GH) | M |
| Journal | A classroom's course documentation in one GitHub repository, rendered on the server, read by the class, edited in the browser (F-JRN) | M |
| Student | A **Courses** route and a classroom page: its activities, its journal, later its projects and grades (F-ORG-14, F-ORG-15) | M |
| Projects, gradebook, online workspace, unified SEB | Specified with the rest of M0-04, not yet in this spec | M |

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
- A general-purpose GitHub client: the platform touches GitHub only for what a feature needs (the journal now, projects later). It never deletes a repository when a journal is removed (F-JRN-04).
- Hot installation of plugins from a remote repository.

## 0.7 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| VM outage during an exam | High | Server-side autosave on every keystroke, transparent resume, backups, documented failover procedure, paper fallback mode |
| Escape from the code sandbox | High | Containers without network, gVisor, CPU / memory / pids / time limits, read-only image, no reachable secrets |
| Wrong LLM grading on an official grade | Medium | Always validated by the teacher, justification per criterion, confidence score, traced re-grading |
| Cost or unavailability of the LLM provider | Medium | Deferred grading, never in the critical path of the quiz, a daily spending cap on the institutional key (ADR-058, which replaced the key per teacher) |
| Leak of the pool's questions | Medium | The pool is never served to students, only the questions of a running evaluation are, without the key |
| Scope creep | High | Frozen phases, every new idea goes to phase 3 or out of scope |
| GitHub unavailable, or its rate limit reached | Medium | The journal is a read model in Postgres: a page view never calls GitHub, an outage only delays the next synchronisation (N-RES-07) |
| The platform acts on the wrong repositories (a staging copy of production driving real ones, a leaked App key) | High | Quiz's own Apps, one per environment; staging never holds the production App; the key and the webhook secret outside the repository and the database (N-SEC-16, N-SEC-18) |

## 0.8 Decision log

| Date | Decision |
|---|---|
| 2026-09-19 | Home-grown system rather than Moodle or a SaaS tool |
| 2026-09-19 | LLM grading for rich answers and drawing, validated by the teacher |
| 2026-09-19 | 1 to 6 scale to the tenth, extra time in % per student |
| 2026-09-19 | Full retention until deletion by the teacher |
| 2026-09-19 | Versioning as draft then publication, incremented number |
| 2026-09-19 | Target load of 30 per quiz, 100 simultaneous |
| 2026-09-19 | Real time: SSE plus REST, data-carrying events for the live run, no WebSocket |
| 2026-09-19 | Two interface levels, novice by default, expert through progressive disclosure |
| 2026-09-29 | The drawing type is replaced by a structured `diagram` type, graded by hand in v1 (ADR-046) |
| 2026-09-19 | Start from a pruned copy of heig-classroom: auth, visual identity, SSE, pg-boss, ticker, deployment, Podman hardening from the codespace |
| 2026-09-28 | heig-classroom merges into Quiz: GitHub integration, projects and the journal come in scope (ADR-035, `docs/merge/`) |
| 2026-09-30 | The journal first, live before the cutover, through Quiz's own GitHub App; one journal per classroom, a journal is a repository; a Settings tab on the classroom (D03, D07, D23–D25, D27) |
| 2026-10-01 | The journal in two modes: in Quiz (the default, no GitHub, the standard editor, revisions) or in a GitHub repository (read-only in the platform, Edit on GitHub); D25 superseded (ADR-057, D29) |
