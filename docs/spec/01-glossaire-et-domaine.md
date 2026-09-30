# 1. Glossary and domain model

One concept, one word. The terms below are used as they are in the spec, the code and the interface.

## 1.1 Glossary

| Term | Definition |
|---|---|
| User | A person authenticated by edu-ID. Carries a global role: `student`, `teacher` or `admin`. The role comes from the edu-ID affiliation attribute, the admin is a configured edu-ID. |
| Course | A teacher's teaching unit, persistent from one year to the next. E.g. "Programmation C". References one or more pools. |
| Hidden course | A course a user took out of their own navigation (F-ORG-11). A per-user display state, not a state of the course: the word is "hidden", never "archived", which is a state of a classroom seen by the whole staff. |
| Classroom | An instance of a course for a group and a period. E.g. "Prog C, class A, autumn 2026". Owns a roster. May be connected to one GitHub organization and carry one journal (ADR-035). heig-classroom's "classroom" (top-level, bound to an organization) maps to a course plus a classroom here. |
| Period | When a classroom runs: a free label (`2026-A`, "Autumn 2026") and, optionally, a first and a last month (`YYYY-MM`, both or neither). The HEIG-VD semesters are the presets: autumn N = September N – January N+1, spring N = February – July. A dated classroom is *current* while its months, give or take one month on each side, cover today; an undated one is always current. "Ended" is computed, never written: nothing is archived automatically. |
| Roster | The list of the students of a classroom, with their accommodations. Fed by CSV import or by self-enrolment with a classroom code. |
| Pool | A collection of questions. Private to a teacher, or shared with roles. A global public pool is readable by every teacher. |
| Category | A hierarchical folder in a pool. Used for filing, not for permissions. |
| Tag | A free keyword attached to a question. Used for search, statistics and quiz generation. |
| Question | A stable entity of the pool, identified by an id. Carries the type, the internal name, the tags, the difficulty. Its content lives in its versions. |
| Question version | The content of a question at a point in time: statement, configuration, answer key, explanation. Numbered 1, 2, 3. Immutable once published. |
| Draft | The version being edited, unnumbered, never usable in an evaluation. Publishing creates the next version. |
| Question type | A plugin that defines the configuration schema, the answer schema, the editor, the player, the review view and the grader. E.g. `mcq`, `short`, `cloze`, `code`. |
| Evaluation | An ordered set of question versions with run settings, created in a classroom. A single term: no quiz, assignment or session. |
| Activity | What a classroom gives its students to do: an evaluation (exam, exercise, poll) and, later, a project. The student's **Activities** is the summary of the active activities of all their classrooms. The journal is not an activity. heig-classroom's commit-graph panel is called "repository history", never "activity". |
| Project | The future activity kind of the merge (D01): graded work in a student or group GitHub repository, a lab as well as a semester project. heig-classroom's "assignment"; the word "assignment" stays forbidden outside migration code. Specified with the rest of M0-04, not in this spec yet. |
| Evaluation template | An evaluation kept at the course level rather than in a classroom: its questions, points, order, milestones and settings, without dates, access code nor IP list. Never opened, never answered; each classroom's evaluation is made from it by *Instantiate* and records the template and its revision. `exam` and `exercise` only, never `poll` (ADR-031). |
| Instance | An evaluation linked to a template: instantiated from it into a classroom, or saved as it (*Save as template*, at revision 1). It records the template and the revision it came from, and editing the template never changes it: a newer revision reaches it only when the teacher pulls it (ADR-031). |
| Evaluation mode | `exam` timed and graded, `exercise` open with a deadline, `poll` one live question. |
| Attempt log | The server's record of an attempt's events (`attempt_events`): focus and visibility changes, reconnections, IP changes, time added, pauses, runs. Formerly called the attempt's "journal" (D16); "journal" now means the course journal only. |
| Attempt | A student's participation in an evaluation. Only one per student and per evaluation in phase 1. Carries the start time, the effective end, the state. |
| Answer | The current state of a student's answer to a question of an evaluation. One record per attempt and per question, updated on every autosave. |
| Grading | The result of assessing an answer: points, source, state, justification. Several successive gradings are possible, the last one is authoritative. |
| Grader | The function of the question type that produces a grading from the configuration and the answer. Synchronous, asynchronous through the runner, or LLM. |
| Grade | The conversion of an attempt's points into a Swiss grade from 1 to 6 to the tenth, according to the evaluation's grade scale. |
| Grade scale | The rule converting points into a grade for an evaluation: linear, 1 + 5 × points / total, capped at 6, with its rounding. The total leaves the bonus items out (ADR-052). |
| Bonus item | An item of an evaluation whose points are left out of the total: they can only lift a student: under negative marking its score is floored at 0, and the grade stays capped at 6. Set in the builder, locked like the points, labelled "Bonus question" for the student (ADR-052). |
| Explanation | Markdown text attached to a question version, shown to the student according to the feedback policy, and to the teacher during grading. |
| Feedback | The disclosure policy: `none`, `on_release`, `immediate`. |
| Published correction | The correction of an `exercise` published by its teacher while it is still running (F-EVAL-27, ADR-050): the class debrief opens over the papers handed in, and each student's feedback follows the policy as if the results were released. Irreversible; retakes go on. |
| Drill | An individual practice session generated for a student from the questions seen in class, scheduled by spaced repetition. |
| Runner | An isolated service that compiles and runs the students' code in a sandbox. |
| Canonical format | The YAML representation of a question or a pool, independent of the database, used for import, export and external versioning. |
| Quiz's GitHub App | The GitHub App through which the platform acts on GitHub (D23): it reads and writes the repositories of the organizations that installed it, receives their webhooks, and links GitHub accounts. One App per environment: production, and staging on a test organization. heig-classroom's App is a different one; an organization may install both. |
| GitHub organization link | The connection of a classroom to one GitHub organization where Quiz's App is installed (D02, `github_classroom_links`). Made from the classroom's Settings by a member of the course's staff; optional; at most one per classroom. A classroom without it is a plain Quiz classroom. |
| GitHub account link | The attachment of a user's GitHub account (its immutable id and its current login) to their edu-ID account (`github_accounts`). Never a way to sign in. One GitHub account for one user. Needed to be invited as a collaborator to a repository, never to edit a journal in the browser. |
| Journal | A classroom's course documentation: **one GitHub repository** of the classroom's organization (a branch and an optional root folder), one markdown file per page, written by the staff and read by the students of the classroom. Not an activity: no grade, no deadline, no tracking. At most one per classroom (D03); two classrooms of the same organization may use the same repository, each with its own copy. GitHub is the source of truth; the platform keeps a rendered read model. |
| Journal page | One markdown file of the journal, rendered on the server. Its place in the navigation comes from its path; its front matter may carry `title`, `date`, `draft: true` (read by the staff only) and `visible_from` (hidden from the students until then). |
| Journal asset | A file of the journal's repository (an image, a PDF) referenced by one of its pages, copied into the read model (≤ 5 MB, D14). |

## 1.2 Roles and permissions

| Action | Student | Teacher | Admin |
|---|---|---|---|
| See and answer own evaluations, results, drills | Yes | No | No |
| Create a course, a classroom, import a roster | No | Yes | Yes |
| Create a private pool, edit its questions | No | Yes | Yes |
| Read the public pool | No | Yes | Yes |
| Edit a shared pool | No | According to the role on the pool | Yes |
| Create, launch, drive, grade an evaluation | No | On own classrooms | Yes |
| Create, instantiate, delete an evaluation template | No | On own courses | Yes |
| See the grades of a classroom | Own grades | On own classrooms | Yes |
| Configure the LLM providers, the runner languages, the admins | No | Own API key | Yes |
| Connect a classroom to a GitHub organization, create, choose or remove its journal, edit its pages | No | On own classrooms | Yes |
| Read a classroom's journal | Own classrooms, pages neither draft nor before their `visible_from` | On own classrooms, drafts included | Yes |
| Link or unlink own GitHub account | Yes | Yes | Yes |
| Delete a classroom or an evaluation and its data | No | On own classrooms | Yes |

Roles on a shared pool, phase 2: `reader` may read and copy into their own pool, `contributor` may create and publish versions, `owner` manages members and deletes.

A course may have several teachers. They all have the same rights on its classrooms.

## 1.3 Domain model

```mermaid
erDiagram
    USER ||--o{ COURSE_TEACHER : teaches
    COURSE ||--o{ COURSE_TEACHER : has
    COURSE ||--o{ CLASSROOM : instantiates
    COURSE }o--o{ POOL : uses
    CLASSROOM ||--o{ ENROLLMENT : roster
    USER ||--o{ ENROLLMENT : student
    POOL ||--o{ POOL_MEMBER : shares
    POOL ||--o{ CATEGORY : contains
    POOL ||--o{ QUESTION : contains
    CATEGORY ||--o{ QUESTION : files
    QUESTION ||--o{ QUESTION_VERSION : versions
    QUESTION }o--o{ TAG : tagged
    CLASSROOM ||--o{ EVALUATION : hosts
    COURSE ||--o{ EVALUATION : templates
    EVALUATION |o--o{ EVALUATION : instantiates
    EVALUATION ||--o{ EVALUATION_ITEM : ordered
    QUESTION_VERSION ||--o{ EVALUATION_ITEM : used_in
    EVALUATION ||--o{ ATTEMPT : has
    USER ||--o{ ATTEMPT : takes
    ATTEMPT ||--o{ ANSWER : contains
    EVALUATION_ITEM ||--o{ ANSWER : answers
    ANSWER ||--o{ GRADING : graded_by
    USER ||--o{ DRILL_CARD : reviews
    QUESTION ||--o{ DRILL_CARD : scheduled
    USER ||--o| GITHUB_ACCOUNT : links
    GITHUB_ORGANIZATION ||--o{ GITHUB_CLASSROOM_LINK : connects
    CLASSROOM ||--o| GITHUB_CLASSROOM_LINK : connected_to
    CLASSROOM ||--o| CLASSROOM_JOURNAL : documents
    CLASSROOM_JOURNAL ||--o{ JOURNAL_PAGE : mirrors
    CLASSROOM_JOURNAL ||--o{ JOURNAL_ASSET : mirrors
```

### Key attributes

- **USER**: `id`, `eduid_sub`, `email`, `display_name`, `role`, `locale`, `theme`, `llm_api_key` encrypted.
- **COURSE**: `id`, `name`, `code`.
- **CLASSROOM**: `id`, `course_id`, `name`, `period`, `period_start`, `period_end`, `join_code`, `archived_at`.
- **ENROLLMENT**: `classroom_id`, `user_id`, `time_bonus_percent` integer, 0 by default, `note`.
- **POOL**: `id`, `name`, `visibility` `private` / `shared` / `public`, `owner_id`.
- **QUESTION**: `id`, `pool_id`, `category_id`, `type`, `internal_name`, `difficulty` 1 to 5, `created_by`, `origin_question_id` for a fork.
- **QUESTION_VERSION**: `question_id`, `number` null for the draft, `config` JSONB conforming to the type's schema, `explanation`, `published_at`, `published_by`, `change_note`.
- **EVALUATION**: `id`, `classroom_id`, `course_id` set on a template only (exactly one home: a classroom, a course, or — an anonymous poll — its owner), `revision` on a template, `origin_template_id` and `origin_revision` on an instance, `title`, `mode`, `state`, `settings` JSONB, see [02-exigences-fonctionnelles.md](02-exigences-fonctionnelles.md) F-EVAL, `grading_scale`, `feedback_policy`, `opens_at`, `closes_at`, `duration_s`, `correction_published_at` (an exercise's published correction, ADR-050).
- **EVALUATION_ITEM**: `evaluation_id`, `position`, `question_version_id`, `points`, `milestone` boolean, `bonus` boolean (ADR-052).
- **ATTEMPT**: `evaluation_id`, `user_id`, `state`, `started_at`, `deadline_at` computed with the bonus, `submitted_at`, `seed`, `client_events` JSONB for light cheating events.
- **ANSWER**: `attempt_id`, `item_id`, `payload` JSONB conforming to the type's answer schema, `revision` integer incremented on every autosave, `marked_done` (the question was validated in a locking navigation), `skipped` ("Leave unanswered": left blank on purpose), `flagged` (the student's review flag), `updated_at`.
- **GRADING**: `answer_id`, `points`, `max_points`, `source` `auto` / `llm` / `manual`, `state` `proposed` / `validated` / `superseded`, `details` JSONB, `graded_by`, `graded_at`, `note` for the annotation of a re-grading.
- **GITHUB_ORGANIZATION**: `github_org_id`, `login`, `installation_id` of Quiz's App (null until installed), `status`, `plan`.
- **GITHUB_CLASSROOM_LINK**: `classroom_id`, `org_id`, `linked_by`, `linked_at`.
- **GITHUB_ACCOUNT**: `user_id`, `github_user_id` unique, `login`, `linked_at`.
- **CLASSROOM_JOURNAL**: `classroom_id`, `github_repo_id`, `full_name`, `ref`, `root_path`, `last_commit_sha`, `sync_status`, `sync_error`.
- **JOURNAL_PAGE**: `path`, `title`, `front_matter`, `draft`, `visible_from`, the rendered `html` and `toc`, `warnings`.
- **DRILL_CARD**: `user_id`, `question_id`, FSRS parameters `stability`, `difficulty`, `due_at`, `reps`, `lapses`, `last_review_at`; one per student and question, created at the release of an exam or the hand-in of an exercise (ADR-041). Its reviews record the rating, the active time and the device class.

### Invariants

1. An evaluation references only published versions. The draft is never referenced.
2. A published version never changes. Fixing an answer key creates a version.
3. An attempt has at most one answer per item. The autosave updates the answer in place and increments `revision`. The server rejects a revision lower than the current revision.
4. An answer has at most one grading in state `validated`. A new grading moves the previous one to `superseded`.
5. The grade of an attempt is computed from the validated gradings, never stored as the source of truth. It is cached when the results are released.
6. The content sent to a student never contains the answer key nor the explanation before the feedback policy allows it.
7. A journal page reaches a student only rendered, and only when it is not a draft and its `visible_from` has passed; an asset only when such a page references it (N-SEC-12, N-SEC-13).
8. Removing a journal, or disconnecting a classroom from GitHub, never deletes anything on GitHub.

## 1.4 Lifecycles

**Question version**: `draft` → publish → `published` number N. A published version may be marked `deprecated` to signal that a more recent version fixes an error.

**Evaluation template**: always `draft`; its `revision` starts at 1 and moves with every committed change to its items or template-level settings, never with its title (ADR-031).

**Evaluation**: `draft` → `scheduled` → `lobby` waiting room → `running` → `paused` ↔ `running` → `closed` → `grading` → `released`. The `exercise` mode skips `lobby` and `paused`. The `poll` mode goes from `running` to `released` directly.

**Attempt**: `not_started` → `in_progress` → `submitted` by the student or `expired` by the server at the deadline. Both terminal states can be graded.

**Journal**: none → created or chosen (`sync_status` `pending`) → `ok` after each ingestion, `error` when GitHub refused it or the repository is gone (the pages already mirrored stay readable) → removed (the classroom's copy is dropped, the repository kept).

**Grading**: `proposed` → `validated`. An `auto` grading on a fully deterministic type is born `validated`. An `llm` grading is born `proposed`. A manual grading is born `validated`.
