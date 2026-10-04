<div align="center">

<img src="apps/web/public/icon-192.png" alt="" width="96" height="96">

# Quiz

**The teaching platform for Swiss higher education: write your questions once,
run exams live, grade in one pass, and keep students practising.**

Switch edu-ID sign-in · French and English · light and dark themes ·
self-hosted on one VM

[![CI](https://github.com/heig-tin-info/heig-quiz/actions/workflows/ci.yml/badge.svg)](https://github.com/heig-tin-info/heig-quiz/actions/workflows/ci.yml)
[![Docs](https://github.com/heig-tin-info/heig-quiz/actions/workflows/docs.yml/badge.svg)](https://heig-tin-info.github.io/heig-quiz/)
![Node 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-end%20to%20end-3178C6?logo=typescript&logoColor=white)

[User guide](https://heig-tin-info.github.io/heig-quiz/guide/) ·
[Try it in two minutes](#try-it-in-two-minutes) ·
[Specification](docs/spec/README.md) ·
[Architecture decisions](docs/adr/README.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/live-running-dark.png">
  <img alt="The teacher's live dashboard during an exam: one row per student, one cell per question, verdicts computed as the answers are typed" src="docs/assets/screenshots/live-running-light.png">
</picture>

<p align="center"><sub>The live dashboard of an exam: every answer saved as it is typed, every verdict computed on the fly.</sub></p>

## Made for every school that signs in with edu-ID

Quiz was born at HEIG-VD and runs its courses in production, but nothing in
it belongs to one school. Identity is [Switch edu-ID](https://www.switch.ch/edu-id/)
over OpenID Connect, so the platform fits **any institution whose teachers
and students already hold an edu-ID**:

- **Every school of the HES-SO works out of the box.** edu-ID asserts their
  staff as `staff@hes-so.ch`, which the default configuration recognises as
  a teacher; everyone else signs in as a student.
- **Any other Swiss university or school is one setting away**:
  `STAFF_AFFILIATION_DOMAINS` lists the institutions whose staff become
  teachers at their first sign-in.
- **No accounts to create, no passwords to reset.** A student imported from
  a CSV roster claims their seat the first time they sign in.

## What it does

### Questions you write once and reuse for years

- **Nine question types**: multiple choice, short answer, fill in the
  blanks, **code** run against test cases, **code judged by the picture it
  draws**, **electronic circuits graded by simulation**, categorize (cards
  dragged into columns), essay and diagram.
- **Parameterized questions**: write `[[R]]` instead of a value, and every
  student gets numbers of their own, graded against a key of their own.
- **Question pools** with categories, tags, difficulty and a history of
  published versions, shared with colleagues and filtered in a keystroke.
- **Evaluation templates** kept by the course, instantiated into next year's
  classroom in one click.

### Exams and exercises run live, on the server's clock

- A waiting room, a start, a deadline closed by the server — never by the
  browser — and every keystroke saved: a dropped Wi-Fi loses nothing.
- A **live dashboard** for the teacher: who is connected, who answered
  what, extra time for the class or for one student, and accommodations
  (+25 % time) applied by themselves.
- **Code in the browser**: students compile and run their program against
  the visible cases before handing in; the grade comes from hardened,
  network-less containers on the server.
- Exams can require **Safe Exam Browser**, opened from the portal without a
  second sign-in, or run on the school's locked-down Chromebooks.

### Grading in one pass, with the teacher in charge

- Deterministic types are graded the moment the exam closes; code and
  circuits as soon as the runner has executed them.
- **AI proposals for essays and diagrams**, each with its confidence and a
  justification only the teacher sees: validate a whole batch in one click,
  or adjust with a comment the student will read.
- **Results by question** with success rate and discrimination, grades
  exported to CSV on the Swiss 1–6 scale, and a release step: students read
  their feedback only once the teacher publishes it.

### Learning between the exams

- **Live polls**: a question on the projector, answered from a phone through
  a QR code, anonymously if you like, then the answer revealed.
- **Drill**: spaced-repetition practice (FSRS) drawn from the course's pools,
  so students revise a little every day.
- **Classroom journal**: the course documentation, written in a WYSIWYG
  editor or kept in a GitHub repository, shown to students page by page from
  the date you choose.
- **GitHub projects** *(rolling out)*: graded work in student repositories,
  provisioned by the platform's own GitHub App, with CI scores, deadlines
  that freeze the repositories, and review checkpoints.

### Everything a daily tool needs

- A command palette (<kbd>Ctrl</kbd>+<kbd>K</kbd>), keyboard shortcuts on
  every busy screen, and a help drawer on every page.
- Notifications in the app, by e-mail and in Microsoft Teams.
- Phone-first student screens: home, polls, feedback and grades.
- **API tokens and an MCP server**: let an AI assistant write questions,
  build templates and set up evaluations in your pools, under your account.

## A closer look

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/player-code-dark.png">
        <img alt="A student writing C code in the exam player, with the visible test cases below" src="docs/assets/screenshots/player-code-light.png">
      </picture>
      <p align="center"><sub><b>Code questions</b>: the student edits only their regions of the template, and runs the visible tests before handing in.</sub></p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/grading-essay-dark.png">
        <img alt="The grading table of an essay question, with AI proposals and their confidence" src="docs/assets/screenshots/grading-essay-light.png">
      </picture>
      <p align="center"><sub><b>Grading</b>: AI proposals with their confidence, validated in one click or adjusted by hand.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/poll-projection-dark.png">
        <img alt="A live poll on the projector, with its join code and QR code" src="docs/assets/screenshots/poll-projection-light.png">
      </picture>
      <p align="center"><sub><b>Live polls</b>: the question, the join code and a QR on the projector; the votes stay hidden until you reveal them.</sub></p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/editor-code-dark.png">
        <img alt="The editor of a code question: template, editable regions and test cases" src="docs/assets/screenshots/editor-code-light.png">
      </picture>
      <p align="center"><sub><b>The question editor</b>: template, editable regions, test cases, and a preview of exactly what the student will see.</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/pool-dark.png">
        <img alt="A question pool: categories in the sidebar, questions in the table" src="docs/assets/screenshots/pool-light.png">
      </picture>
      <p align="center"><sub><b>Question pools</b>: categories, tags, difficulty and published versions, shared with colleagues.</sub></p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/grading-circuit-dark.png">
        <img alt="Grading circuit answers: each schematic, simulated against the stimuli" src="docs/assets/screenshots/grading-circuit-light.png">
      </picture>
      <p align="center"><sub><b>Circuits</b>: a schematic is graded by simulating it and comparing its output with the reference.</sub></p>
    </td>
  </tr>
</table>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/join-mcq-phone-dark.png">
    <img alt="A phone answering a live poll" src="docs/assets/screenshots/join-mcq-phone-light.png" width="200">
  </picture>
  &nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/student-home-phone-dark.png">
    <img alt="The student's home on a phone" src="docs/assets/screenshots/student-home-phone-light.png" width="200">
  </picture>
  &nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/feedback-phone-dark.png">
    <img alt="A student's feedback on a phone" src="docs/assets/screenshots/feedback-phone-light.png" width="200">
  </picture>
  <br>
  <sub>On the student's phone: a poll, the home page, the feedback once released.</sub>
</p>

Every screen, in both themes, is in the [user guide](https://heig-tin-info.github.io/heig-quiz/guide/).

## Try it in two minutes

All you need is **Node 24**. No Docker, no PostgreSQL, no identity provider:
the database is an embedded PostgreSQL (PGlite) on disk, and the sign-in
screen offers a persona picker instead of edu-ID.

```bash
git clone https://github.com/heig-tin-info/heig-quiz.git && cd heig-quiz
corepack enable pnpm && pnpm install --frozen-lockfile
pnpm build               # the apps import the workspace packages' dist/
cp .env.example .env     # embedded database, development login on
pnpm seed                # a complete demo world
pnpm dev                 # API on :3000, web on :5173
```

Open <http://localhost:5173>, click **Dev login** and pick a persona:

| Persona | Role | What you will find |
| --- | --- | --- |
| Prof Démo | teacher | the course PRG1, two pools, four evaluations in every state |
| Admin Démo | admin | the same, plus the administration screen |
| Léa Rochat | student | a seat with a 25 % extra-time accommodation |
| Noah, Emma, Louis, Chloé, Gabriel | students | ordinary seats |

The seed builds a course, its classroom and six students, nineteen published
questions of all nine types across two pools, and four evaluations: a draft,
one scheduled in two days, an exercise waiting in its lobby, and
**Test 0 — bases du C**, already run and graded but not released, so the
grading table has proposals waiting for you. Sign in as Prof Démo, open it,
and validate.

> [!TIP]
> `pnpm seed` is idempotent. To start over, stop the API and delete
> `apps/api/.data/pglite`. The embedded database is single-process: always
> stop the API before seeding.

### Everyday commands

```bash
pnpm dev                 # API and web, plus the code runner when Podman is there
pnpm dev:mock            # the interface alone, on fake data
pnpm build && pnpm typecheck
VITEST_MAX_WORKERS=4 pnpm -r --workspace-concurrency=1 test
pnpm smoke               # an end-to-end HTTP walk through a whole evaluation
pnpm db:generate         # after a schema change: the Drizzle migration
```

`pnpm smoke` wants a running, seeded API: it signs a teacher in, authors and
publishes a question, sits an evaluation as a student, then closes, grades,
releases and exports it, over HTTP only.

### Going further

- **The real login and PostgreSQL**:
  `docker compose -f docker-compose.dev.yml up -d` starts PostgreSQL and a
  Keycloak realm (`infra/keycloak/`); then
  `DATABASE_URL=postgres://quiz:quiz@localhost:5432/quiz AUTH_DEV_LOGIN=0 pnpm dev`.
- **Running code for real**: with a Podman socket on the machine, `pnpm dev`
  starts the runner too; see [`apps/runner/README.md`](apps/runner/README.md).
- **The whole setup guide**, the demo world in detail and the optional paths:
  [`docs/development/index.md`](docs/development/index.md).

## How it is built

| Layer | Stack |
| --- | --- |
| **Server** | Fastify 5, Drizzle over PostgreSQL, pg-boss jobs, server-sent events for every live view |
| **Browser** | React 19 and Vite; WebAssembly language runtimes for the student's trial runs |
| **Code runner** | a separate service: Podman with `--network none`, a read-only root, seccomp, no capabilities, no secret inside |
| **Identity** | Switch edu-ID (OpenID Connect with PKCE); Keycloak in development |
| **Contracts** | every HTTP input validated by a schema the server and the client share |

```
apps/api        Fastify API, Drizzle schema and migrations
apps/web        the React single-page application
apps/runner     the hardened code execution service
packages/       contracts, pure domain rules, one package per question type,
                the diagram engine, the journal renderer
docs/           user guide, specification, architecture decision records
```

The [repository map](docs/development/repository.md) has the details;
[`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md) hold the invariants and
the working rules every contributor, human or agent, follows.

## Running your own instance

Quiz is designed to be operated by one person: one VM, one PostgreSQL, two
container images built by GitHub Actions and pulled by the server, and the
code runner on a VM of its own. Production refuses to start with anything
meant for development: the dev login, the embedded database, a weak secret.
The runbook, [`docs/development/deployment.md`](docs/development/deployment.md),
covers the machines, the secrets, DNS, backups, staging and rollback.

The HEIG-VD instance runs at <https://quiz.chevallier.io>, its staging at
<https://quiz.dev.chevallier.io>.

## Documentation

The user guide, the specification and the architecture decision records are
published at <https://heig-tin-info.github.io/heig-quiz/>, rebuilt from
`docs/` on every push to `main`. To preview them locally:
`uvx zensical serve`.
