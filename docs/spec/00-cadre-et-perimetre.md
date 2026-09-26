# 0. Context, objectives and scope

## 0.1 Context

- A project by a HEIG-VD teacher for his own courses. Developed by the teacher, assisted by Claude.
- Hosting: one Hetzner VM, Docker Compose deployment, a single node.
- Users: HES-SO students and teachers authenticated by edu-ID, one admin.
- Main use: in-class evaluations (20 to 30 students), exercises at home, live polls, individual practice.

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
- Auth: edu-ID only for named accounts. A session code allows anonymous participation in polls.
- Data: answers and grades are personal data. See [03-exigences-non-fonctionnelles.md](03-exigences-non-fonctionnelles.md), data section.
- Browsers: current versions of Chrome, Firefox, Safari, Edge. Mobile and tablet for every type except code and drawing, which remain usable but are optimised for desktop.

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
| Statistics | Difficulty and discrimination indices per version, distractor analysis, answer time | S |
| Drill | FSRS spaced practice, daily / weekly drill, strengths and weaknesses per tag | S |
| Import | GIFT and Moodle XML | C |

### Phase 3: advanced types and extensibility

| Area | Content | Prio |
|---|---|---|
| Questions | Drawing. The schematic type (`circuit`) was brought forward and now ships with a simulation grading, ADR-019; the code-image type (`codeimage`) was brought forward too, as a variant of `code` graded pixel by pixel, ADR-021 | S |
| Code | TAP unit tests, additional files, locked regions, further languages | S |
| Plugins | External question packages, loaded at build time | C |
| Generation | "Generate 10 min quiz" by tags and difficulty | C |
| Integrations | MCP server to author from an LLM client | C |

## 0.6 Out of scope

- Heavy proctoring: webcam, device lockdown. (Safe Exam Browser is in scope since ADR-027: an exam may require it, launched from the portal without a second sign-in.)
- Comparison of electronic schematics by topology: netlist isomorphism, series/parallel
  canonicalisation, "the same circuit drawn differently". The `circuit` question type
  grades a schematic by SIMULATING it and comparing the output waveform with the
  reference's (ADR-019), which is in scope; what it never does is decide whether two
  netlists are the same graph. Pick-and-place is graded by LLM or manually.
- Management of study plans, credits, absences. The platform exports grades, it does not administer them.
- Institutional multi-tenancy: a single admin, a single instance.
- Code editor with a full language server. Monaco with highlighting and shortcuts is enough.
- Hot installation of plugins from a remote repository.

## 0.7 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| VM outage during an exam | High | Server-side autosave on every keystroke, transparent resume, backups, documented failover procedure, paper fallback mode |
| Escape from the code sandbox | High | Containers without network, gVisor, CPU / memory / pids / time limits, read-only image, no reachable secrets |
| Wrong LLM grading on an official grade | Medium | Always validated by the teacher, justification per criterion, confidence score, traced re-grading |
| Cost or unavailability of the LLM provider | Medium | Deferred grading, never in the critical path of the quiz, key per teacher |
| Leak of the pool's questions | Medium | The pool is never served to students, only the questions of a running evaluation are, without the key |
| Scope creep | High | Frozen phases, every new idea goes to phase 3 or out of scope |

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
| 2026-09-19 | Start from a pruned copy of heig-classroom: auth, visual identity, SSE, pg-boss, ticker, deployment, Podman hardening from the codespace |
