---
search:
  exclude: true
---

# Original scope, phases and decision log

Historical planning material preserved on 2026-10-03. These tables record
intent and chronology, not current delivery status. Read the [current scope](../00-cadre-et-perimetre.md)
and [functional requirements](../02-exigences-fonctionnelles.md) for active constraints.

## 0.2 Why a home-grown system

| Need | Moodle / CodeRunner | Wooclap, Kahoot, etc. | GitHub Classroom | This project |
|---|---|---|---|---|
| edu-ID auth and automatic matching of students | Yes through Cyberlearn, but heavy | No | No, GitHub accounts only | Yes, native |
| Clean, modern interface, real time | No | Yes, but geared towards animation | Partial | Yes |
| Code questions run in a sandbox | CodeRunner, dated UI | No | No | Yes, native |
| LLM-assisted grading, framed and validated by the teacher | No | No | No | Yes, a differentiator |
| Versioned question pool, shared, exportable as text | Partial | No | No | Yes |
| Spaced practice on the questions of the course | No | No | No | Yes, phase 2 |
| Free, no advertising, data on a server under our control | Yes | No | Free, data at GitHub | Yes |
| Course notes written in markdown, versioned in git, read by the class in the same app | Pages, not versioned | No | No | Yes, the journal (ADR-035) |
| A repository per student or group from a source repository | No | No | Yes | Yes, projects (F-PROJ) |
| The deadline judged on the server's receipt of each push, the CI score captured, frozen and released into the grades | No | No | No | Yes, projects (F-PROJ) |
| One gradebook for exams and projects | Yes | No | No | Yes (F-GBOOK) |

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

Carried by the task cards of [`docs/merge/09-tasks.md`](../../merge/09-tasks.md), in the order of [`docs/merge/01-strategy.md`](../../merge/01-strategy.md). The journal goes first and goes live in production before the cutover, classroom by classroom, through Quiz's own GitHub App.

| Area | Content | Prio |
|---|---|---|
| Classroom | A **Settings** tab on the teacher's classroom page: rename, archive, delete, drill, GitHub, journal (F-ORG-13) | M |
| GitHub | Connect a classroom to an organization where Quiz's App is installed, with its checks; link one's GitHub account (F-GH) | M |
| Journal | A classroom's course documentation in one GitHub repository, rendered on the server, read by the class, edited in the browser (F-JRN) | M |
| Student | A **Courses** route and a classroom page: its activities, its journal, later its projects and grades (F-ORG-14, F-ORG-15) | M |
| Projects | A repository per student or group from a source repository, protected files, the deadline on the server's receipt time, the CI score captured, frozen, reviewed and released, groups, sync of the source (F-PROJ). Every teacher may create them in Quiz before the cutover; the import still brings heig-classroom's (D26 and its addendum of 2026-10-02) | M |
| Gradebook | The classroom's grades of its released exams and projects in one table, a weighted mean, a CSV (F-GBOOK) | M |
| Online workspace, unified SEB | Phase M6, after the cutover: rebuilt in Quiz, tried by users, then its migration considered (D09); a `seb` session confined to an activity, `packages/seb` (D21; ADR-047) | S |

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
| 2026-10-01 | Projects open with the import of heig-classroom's data, the cutover during the autumn semester; a project's score reaches the gradebook only after a release, on a per-project scale; the gradebook counts exams and projects; GitHub repositories are never deleted (D05, D06, D11–D13, D17–D20, D22, D26) |
| 2026-10-01 | The journal in two modes: in Quiz (the default, no GitHub, the standard editor, revisions) or in a GitHub repository (read-only in the platform, Edit on GitHub); D25 superseded (ADR-057, D29) |
| 2026-10-02 | Every teacher may create projects before the cutover, the students seeing none until their view lands; a project's source, branches and source strategy fixed at creation; nothing deleted on GitHub, not even a failed build's repository (D26 addendum, F-PROJ-03, ADR-062) |
