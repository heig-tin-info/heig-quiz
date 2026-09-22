# 3. Non-functional requirements

## 3.1 Performance and load

| Id | Requirement |
|---|---|
| N-PERF-01 | 100 students connected simultaneously, 30 in the same evaluation, without perceptible degradation. |
| N-PERF-02 | An autosave is acknowledged in under 200 ms server-side at the 95th percentile. |
| N-PERF-03 | A teacher action, start, pause, add time, close, is visible to every student in under one second. |
| N-PERF-04 | The runner absorbs 30 executions requested in 10 seconds with a response time under 5 seconds for a trivial program. Configurable concurrency, 4 by default on a 4 vCPU VM. |
| N-PERF-05 | Initial load of an evaluation page under 2 seconds on an average 4G connection. The code player bundle is loaded on demand. |
| N-PERF-06 | The target VM: 4 vCPU, 8 GB, 80 GB SSD. The spec does not assume horizontal scaling. |

## 3.2 Resilience during an evaluation

| Id | Requirement |
|---|---|
| N-RES-01 | No acknowledged answer is lost. The acknowledgement is sent only after the write to the database. |
| N-RES-02 | The client keeps unacknowledged answers in memory and resends them with their revision on reconnection. A visible indicator signals the offline state. |
| N-RES-03 | The real-time connection re-establishes itself automatically with exponential backoff, and replays the current state of the evaluation on reconnection. |
| N-RES-04 | A restart of the application server during an evaluation invalidates neither the sessions nor the attempts. Deadlines are in the database, not in memory. |
| N-RES-05 | Database backup every hour during teaching hours and daily otherwise, kept for 30 days, off the VM. Restoration tested before going to production. |
| N-RES-06 | A documented fallback procedure: the teacher may export at any time the raw state of the answers of a running evaluation. |

## 3.3 Security

| Id | Requirement |
|---|---|
| N-SEC-01 | Auth only through edu-ID OpenID Connect with PKCE. Session cookies `HttpOnly`, `Secure`, `SameSite=Lax`. |
| N-SEC-02 | Mandatory TLS, automatic certificates. HSTS. Strict CSP headers, no inline script without a nonce. |
| N-SEC-03 | Every authorisation is checked server-side per resource: a student reaches only their own attempts, a teacher only their own classrooms and pools. |
| N-SEC-04 | The content served to a student during an evaluation excludes the answer key, the explanation, the hidden test cases and the pool metadata. The filtering is done by the question type in a dedicated, tested function. |
| N-SEC-05 | Rendered markdown is sanitised. Images are served from the same domain. |
| N-SEC-06 | Runner sandbox: one container per execution, no network, read-only file system except a temporary working directory, limits on CPU, memory, pids, output size and wall-clock time, unprivileged user, gVisor runtime. No platform secret is mounted. |
| N-SEC-07 | Rate limiting of executions per student and per minute, and per evaluation. |
| N-SEC-08 | LLM API keys are encrypted at rest with an application key kept out of the database. Never sent back to the client. |
| N-SEC-09 | Audit log of sensitive actions with author, timestamp, resource. |
| N-SEC-10 | Light anti-cheating, never blocking: logging of focus losses and IP address changes during an attempt, access code, optional IP restriction. The student is informed that these events are recorded. |
| N-SEC-11 | Dependencies updated automatically by PR, runner base image rebuilt every week. |

## 3.4 Personal data

| Id | Requirement |
|---|---|
| N-DATA-01 | Legal basis: processing required by the teacher's teaching duty. Data is stored on a server in Europe, a Hetzner VM. |
| N-DATA-02 | Data processed: edu-ID identity, classroom membership, answers, gradings, grades, attempt events, drill cards. |
| N-DATA-03 | Retention: the data of a classroom or an evaluation is kept until its deletion by the teacher. Deletion is effective and irreversible, including in backups beyond 30 days. |
| N-DATA-04 | A student may view and export all their data from their profile, in JSON format. |
| N-DATA-05 | Sending to an LLM provider: anonymised content, without name, email, identifier, nor classroom metadata. The teacher is informed of the provider in use. The provider is configured in no-retention mode when the option exists. |
| N-DATA-06 | Question statistics in the pool are aggregated and cannot be traced back to a student. |
| N-DATA-07 | A "Data and privacy" page describes these rules to students, in French and in English. |

## 3.5 Accessibility and internationalisation

| Id | Requirement |
|---|---|
| N-A11Y-01 | WCAG 2.1 AA conformance targeted on the student flows and the teacher dashboard: contrast, full keyboard navigation, visible focus, labels, screen reader on forms. |
| N-A11Y-02 | The player is usable with the keyboard alone. Documented shortcuts: next question, previous question, mark as done. |
| N-A11Y-03 | Information is never carried by colour alone. The correct / wrong / partial states have an icon. |
| N-A11Y-04 | Font size and browser zoom up to 200 % without loss of function. |
| N-I18N-01 | Interface in French and in English, language chosen by the user, the browser's by default. Every string goes through the translation system. |
| N-I18N-02 | Dates, times and numbers formatted according to the locale. The displayed clock is in the user's local time. |
| N-I18N-03 | Question content is not translated. |

## 3.6 Compatibility

| Id | Requirement |
|---|---|
| N-COMPAT-01 | Last two major versions of Chrome, Firefox, Safari, Edge. Safari iOS and Chrome Android for the student flows. |
| N-COMPAT-02 | Minimum supported width: 360 px. Code and drawing types: optimised from 1024 px, usable below. |
| N-COMPAT-03 | Light and dark themes, system preference by default, choice remembered. |

## 3.7 Operations

| Id | Requirement |
|---|---|
| N-OPS-01 | Deployment by Docker Compose: reverse proxy, application, Postgres database, runner. One command to update. |
| N-OPS-02 | Structured JSON logs, configurable level. Basic metrics: requests, latency, active real-time connections, runner queue. |
| N-OPS-03 | Internal health page: database, runner, disk space, last backup. |
| N-OPS-04 | Schema migrations versioned and applied at startup. Always compatible with the previous version to allow a rollback. |
| N-OPS-05 | No deployment during a running evaluation: the update script refuses when an evaluation is `running` unless a force option is given. |

## 3.8 Quality and maintainability

| Id | Requirement |
|---|---|
| N-QUAL-01 | Strict TypeScript end to end, schemas shared between client and server. |
| N-QUAL-02 | Unit tests on every grader and on the filtering of the content served to students. Integration tests on the lifecycle of an evaluation. One end-to-end test per main flow. |
| N-QUAL-03 | Every question type is an isolated package with the same interface. Adding a type does not change the core. |
| N-QUAL-04 | Documentation: this `docs/` folder, an operations guide, a question type author's guide. |

## 3.9 UX principles

These principles frame the design system, detailed later in a dedicated document.

1. **Restraint**: no borders around fields, hierarchy through space and typography, a single primary action per screen.
2. **Predictability on the student side**: the exam interface is conventional in its affordances. Input fields are identifiable at rest, buttons have a label. Visual innovation is focused on the teacher interface.
3. **Responsiveness**: every state change is visible without a reload. The synchronisation state is always shown during an evaluation.
4. **A minimum of decisions**: the evaluation settings have sensible defaults. The teacher launches a quiz in three screens: choose the questions, set the time, start.
5. **Content first**: the statement takes the space, the application chrome is reduced to a top bar with logo, sections, and on the right user, theme, help.
6. **Consistency**: one component per use, design tokens for colours, spacing, radii, and a single icon library.
