# 2. Functional requirements

Every requirement is identified `F-AREA-nn`, with its phase P1 / P2 / P3 and its priority M / S / C. A requirement must be verifiable by a test or a demonstration.

## F-AUTH Authentication and accounts

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-AUTH-01 | The user signs in through edu-ID with OpenID Connect. No local password. | P1 | M |
| F-AUTH-02 | On first sign-in, the account is created with name, email and a role derived from the edu-ID affiliation: `staff` or `faculty` gives `teacher`, `student` gives `student`. | P1 | M |
| F-AUTH-03 | The admin is identified by a list of edu-ID identifiers in the configuration. They may promote or demote a user to `teacher`. | P1 | M |
| F-AUTH-04 | The session persists for 30 days. An explicit sign-out is available. A running exam never asks to sign in again. | P1 | M |
| F-AUTH-05 | A participant without an account may join an evaluation in `poll` mode through a session code, anonymously: no pseudonym is asked for nor stored (see 06 no. 18). | P2 | M |

## F-ORG Courses, classrooms, rosters

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-ORG-01 | A teacher creates a course with a name and a short code. They may add other teachers to it. | P1 | M |
| F-ORG-02 | A course references one or more pools. The course's evaluations draw from these pools. | P1 | M |
| F-ORG-03 | A teacher creates a classroom in a course with a name and a period. A classroom may be archived. | P1 | M |
| F-ORG-04 | The roster is imported from CSV with at least the edu-ID email. Lines already known are merged, never duplicated. | P1 | M |
| F-ORG-05 | A student whose email appears in a roster is attached to the classroom on their first sign-in. | P1 | M |
| F-ORG-06 | A classroom exposes a join code. A student who enters it joins the roster. The teacher may disable the code. | P1 | S |
| F-ORG-07 | Every roster line carries an extra time in percent, 0 by default, and a free note. | P1 | M |
| F-ORG-08 | The teacher may remove a student from a roster. Their past attempts are kept. | P1 | M |
| F-ORG-09 | Deleting a classroom deletes its evaluations, attempts, answers and gradings after a confirmation that names the classroom. The questions of the pool are not affected. | P1 | M |
| F-ORG-10 | A classroom may be duplicated to a new period, without roster nor attempts, with its evaluations as drafts. | P2 | S |

## F-POOL Pools and organisation of questions

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-POOL-01 | Every teacher has a private pool created automatically and may create others. The personal pool (`Polls`) is created on first use, by the first question the teacher keeps after a live poll (ADR-014, addenda item 6); a teacher who never keeps one never sees it. | P1 | M |
| F-POOL-02 | A pool contains hierarchical categories and questions. A question is in a single category or at the root. | P1 | M |
| F-POOL-03 | The list of questions can be filtered by type, tags, difficulty, category, free text on the internal name and the statement. | P1 | M |
| F-POOL-04 | A question may be copied to another pool. The copy references its origin. | P1 | S |
| F-POOL-05 | A pool may be shared with other teachers with a `reader`, `contributor` or `owner` role. | P2 | S |
| F-POOL-06 | A global public pool is readable by every teacher. The admin designates its contributors. | P2 | S |
| F-POOL-07 | A pool exports as an archive of YAML files in the canonical format, one file per question, the category tree as folders. Importing this archive recreates the pool or merges into an existing pool by id. | P1 | S |
| F-POOL-08 | Import of GIFT and Moodle XML files for the supported types. Questions that cannot be converted are listed with the reason. | P2 | C |

## F-QST Questions and versions

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-QST-01 | A question carries a type, an internal name visible to the teacher only, tags, a difficulty from 1 to 5. | P1 | M |
| F-QST-02 | The editor works on the draft. Every change is saved automatically. | P1 | M |
| F-QST-03 | Publishing validates the draft against the type's schema and creates version N+1 with an optional change note. The draft stays equal to the published version until the next change. | P1 | M |
| F-QST-04 | The version history can be browsed with a diff of the configuration. A version may be restored into the draft. | P1 | S |
| F-QST-05 | A version may be marked `deprecated` with a reason. The evaluations that use it show this to the teacher. | P1 | S |
| F-QST-06 | The statement and the explanation are markdown with a WYSIWYG editor: headings, bold, lists, code, pasted or dragged images, inline and block KaTeX equations. | P1 | M |
| F-QST-07 | Pasted images are stored on the server and referenced by a stable id. The canonical export embeds them. | P1 | M |
| F-QST-08 | A question declares whether it can be shuffled and whether it supports random values. | P1 | M |
| F-QST-09 | The editor offers a preview of the player exactly as the student will see it, with the possibility to answer and to see the grading. | P1 | M |
| F-QST-10 | A question with random values declares variables with a range, a step and a precision. The expressions in the statement and the key are evaluated with the attempt's seed. See [04-types-de-questions.md](04-types-de-questions.md). | P2 | M |
| F-QST-11 | Deleting a question hides it from the pool. It is still resolved by past evaluations. Permanent deletion is possible only when no evaluation references it. | P1 | M |

## F-EVAL Configuring an evaluation

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-EVAL-01 | The teacher creates an evaluation in a classroom with a title, a mode `exam`, `exercise` or `poll`, and an ordered list of questions taken from the course's pools. | P1 | M |
| F-EVAL-02 | Every item carries a number of points. By default: 1 for the simple types, the number of test cases for code, the number of blanks for cloze. | P1 | M |
| F-EVAL-03 | Adding a question freezes its current published version. The evaluation shows when a more recent version exists and offers "Update" item by item or globally, as long as no attempt exists. | P1 | M |
| F-EVAL-04 | Time settings: `duration` per-student duration from their start, `deadline` common end time, `manual` closed by the teacher. `exam` requires `duration` or `deadline`. `exercise` has a due date. | P1 | M |
| F-EVAL-05 | The roster's extra time applies to `duration`. In `deadline` mode it extends the individual end beyond the common end. | P1 | M |
| F-EVAL-06 | Waiting room: `skip` the student starts alone, `auto` start when everybody present is there, `manual` the teacher starts. | P1 | M |
| F-EVAL-07 | Navigation: `free`, `forward_only`, `milestones` with a flag per item beyond which there is no going back. | P1 | M |
| F-EVAL-08 | Presentation: `zen` one question per screen, `continuous` scrolling, `student_choice` only with `free` navigation. | P1 | M |
| F-EVAL-09 | Shuffling: question order yes / no, choice order yes / no for shuffleable questions. The order is derived from the attempt's seed and stable for a student. | P1 | M |
| F-EVAL-10 | Grade scale: `linear` grade = 1 + 5 × points / total, or `threshold` grade = 1 + 5 × points / threshold capped at 6. Rounded to the tenth, configurable method: nearest by default. | P1 | M |
| F-EVAL-11 | Feedback: `none`, `on_release` after the teacher releases the results, `immediate` after the student validates a question, reserved to the `exercise` and `poll` modes. The feedback includes or not the answer key and the explanation, two distinct options. | P1 | M |
| F-EVAL-12 | An evaluation may require an access code entered by the student, and restrict IP addresses to a list of prefixes. | P1 | S |
| F-EVAL-13 | An evaluation may enable the recommended full-screen mode and the logging of tab visibility changes. Nothing is blocking, everything is visible to the teacher. | P2 | S |
| F-EVAL-14 | An evaluation can be duplicated to the same classroom or to another one. | P1 | S |
| F-EVAL-15 | An `exercise` evaluation may allow several attempts, keeping the best or the last one (the teacher's choice), with an optional maximum. A retake starts blank, with a new question order, once the previous attempt is handed in and while the evaluation is open; the student sees the score of each attempt, not the correction, until the evaluation closes. Results, grade, CSV and statistics use the kept attempt. An exam keeps one attempt (ADR-025). | P2 | C |
| F-EVAL-16 | An `exam` or `exercise` evaluation may use **negative marking**: every choice question is then scored so that a wrong answer costs points (single answer: +1 or −1/(n − 1); several: c/C − w/W, not floored) and no answer costs nothing. Per-question points may be negative; the evaluation total is floored at 0 and the grade computed from it. The student is told in the waiting room and on each choice question. Frozen once an attempt exists (ADR-026, issue #130). | P1 | S |

## F-LIVE Live run

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-LIVE-01 | The student sees on their home page the open evaluations of their classrooms and enters one in a single click. | P1 | M |
| F-LIVE-02 | In the waiting room they see the number of students present out of the number enrolled, as a progress ring, and the announced duration. | P1 | M |
| F-LIVE-03 | Before starting, the teacher sees the list of those present, those absent, and the students with extra time, and confirms. | P1 | M |
| F-LIVE-04 | The start is propagated to every client in under one second. | P1 | M |
| F-LIVE-05 | Every change to an answer is sent to the server with a batching delay of at most 300 ms, and acknowledged. The interface shows an unsaved or offline state. | P1 | M |
| F-LIVE-06 | After a reload or a reconnection, the student finds exactly the state of their answers and their position. | P1 | M |
| F-LIVE-07 | The countdown is computed on the server clock. The client corrects its offset on every tick. The server accepts a write until the deadline plus 3 seconds of grace, then refuses. | P1 | M |
| F-LIVE-08 | A question counts as **answered** as soon as it holds an answer — the question type decides what an empty answer is — with no click. The student may say **"I won't answer this question"** on an empty question: it is settled on purpose, stored with the attempt, taken back by writing an answer, and graded like an empty answer (0). The student may **flag a question for review**: a toggle stored with the attempt, no effect on grading, shown to the staff on the live dashboard (F-DASH-01). A **multiple-choice** question offers **Clear**, which withdraws the selection (with negative points, a student must be able to); the other types are emptied by hand. In `forward_only`, an explicit **"Validate and continue"** step, confirmed, is irreversible and moves to the next question. In `milestones`, validating a checkpoint question asks for a confirmation and closes everything up to it. Every one of these writes goes through the write gate of F-LIVE-07. Decided in issue #89, which replaced the former "Mark as done". | P1 | M |
| F-LIVE-09 | The question list shows every question with a distinct style, and a symbol besides the colour, for answered / not answered / "won't answer" / flagged, marks the current and the closed ones, and allows going to one when the navigation permits it. | P1 | M |
| F-LIVE-10 | The student may hand in before the end after a confirmation. At the deadline the attempt is closed by the server. | P1 | M |
| F-LIVE-11 | The teacher may pause, resume, add 1, 5 or 10 minutes to everybody or to one student, and close. Every action is propagated immediately and logged. | P1 | M |
| F-LIVE-12 | A late student starts with the full duration in `duration` mode, or until the common end in `deadline` mode. The teacher may grant them time individually. | P1 | M |
| F-LIVE-13 | `poll` mode: one question, aggregated results live on the teacher's screen, reveal of the correct answer on demand, possibility to relaunch the same question. A question written for the poll alone may have no correct answer (an opinion poll): the reveal then shows the distribution only, and nothing is graded (ADR-014, addendum 2026-09-23). | P2 | M |
| F-LIVE-14 | The teacher may project a "presentation" view without student names: completion rate, and in `poll` the distribution of answers. | P2 | S |

## F-DASH Teacher's live dashboard

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-DASH-01 | Grid with students as rows, questions as columns. Every cell shows the state: not opened, opened, answered, "won't answer", validated (`forward_only`, a crossed checkpoint), and after grading correct / partial / wrong. A cell the student flagged for review carries a flag, and each column header counts the students who flagged it — a question many students flag may be unclear (issue #89). Staff only: a student never sees another student's flags. | P1 | M |
| F-DASH-02 | Toggles: show names, show answers, show results. Hidden names give a stable pseudonym per row. | P1 | M |
| F-DASH-03 | Columns: running score, individual remaining time, connection state, last event. Sort by column. | P1 | M |
| F-DASH-04 | Total row per question: completion rate — the share of started students who answered the question, said they would not, or validated it — and after grading success rate. | P1 | M |
| F-DASH-05 | A click on a cell opens the student's answer read-only. | P1 | M |
| F-DASH-06 | Full-screen mode suited to projection. | P1 | S |

## F-GRADE Grading

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-GRADE-01 | On close, every answer of the deterministic types is graded automatically and validated. A missing answer is worth 0. | P1 | M |
| F-GRADE-02 | The answers of LLM-graded types are sent anonymised to the configured provider, with the statement, the criteria grid and the reference answer. The proposal contains the points per criterion, a justification and a confidence. | P2 | M |
| F-GRADE-03 | Grading panel: walk by student in quiz order, or by question across all students. The student's name is hidden by default. | P1 | M |
| F-GRADE-04 | The teacher validates one proposal, a filtered batch, for example every high-confidence proposal, or every proposal of a question, or changes the points and a comment before validating. | P1 | M |
| F-GRADE-05 | The teacher may override any grading, including an automatic one, with a mandatory comment. The previous grading is kept as `superseded`. The points lie in [0, item points], or [−item points, item points] for a choice question under negative marking (F-EVAL-16). | P1 | M |
| F-GRADE-06 | Re-grading: after publishing a new version of a question, the teacher may re-run the automatic grading of an item on every attempt. Every re-run grading carries the annotation "re-graded with version N" and the old one is kept. | P1 | M |
| F-GRADE-07 | One teacher comment per answer is visible to the student according to the feedback policy. | P1 | S |
| F-GRADE-08 | A student may report a question from their results with a reason. The teacher sees the reports on the grading panel. | P2 | S |
| F-GRADE-09 | Releasing the results freezes the grades and notifies the students. A re-grading after release updates the grades and marks the evaluation "changed after release". | P1 | M |

## F-RES Results and grades

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-RES-01 | Grades view of an evaluation: per student, points, grade to the tenth, time used, mean, median, standard deviation, histogram. | P1 | M |
| F-RES-02 | CSV export: email, name, points per item, total, grade. Semicolon separator, UTF-8 encoding with BOM for Excel. | P1 | M |
| F-RES-03 | Per-question view: statement, correct answer, explanation, distribution of answers, for a multiple choice the percentage per choice, success rate, mean time. Linear scrolling for going through the answers in class. | P1 | M |
| F-RES-04 | The student sees their released results: points per question, grade, and according to the feedback their answer, the key, the explanation, the teacher's comment. | P1 | M |
| F-RES-05 | Cumulative view per classroom: grades of every released evaluation, configurable weighted mean. | P2 | S |

## F-STAT Question statistics

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-STAT-01 | For every question version: number of exposures, success rate, mean points, mean, min and max answer time, per year. | P2 | S |
| F-STAT-02 | Difficulty index p, discrimination index by point-biserial correlation with the total, distractor analysis for multiple choice. | P2 | S |
| F-STAT-03 | The statistics are visible in the pool on the question's card and serve as filters. | P2 | S |
| F-STAT-04 | "Generate a quiz": target duration, tags, difficulty, number of questions, relying on the mean answer time. The result is an editable evaluation draft. | P3 | C |

## F-LLM LLM assistance

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-LLM-01 | The admin configures providers: Anthropic, OpenAI, or OpenAI-compatible, with a model and an optional institutional key. Every teacher may enter their own key, encrypted at rest. | P2 | M |
| F-LLM-02 | In the editor: generate a variant of the question, propose the answer key, write the explanation, propose distractors. The result lands in the draft, never published automatically. | P2 | M |
| F-LLM-03 | LLM grading is described in F-GRADE-02. No LLM call is made while an evaluation is running. | P2 | M |
| F-LLM-04 | Every piece of data sent is anonymised: no name, email nor student identifier. The calls are logged with the model, the number of tokens and the estimated cost, per teacher. | P2 | M |
| F-LLM-05 | Without a configured key, the "Copy the prompt" action provides the full prompt to paste into an external client, and "Paste the answer" imports it. | P2 | S |
| F-LLM-06 | MCP server exposing the reading and writing of question drafts, to author from an LLM client. | P3 | C |

## F-DRILL Practice

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-DRILL-01 | Every question a student meets in an evaluation becomes a drill card. The teacher may also open a whole pool to drill for a classroom. | P2 | S |
| F-DRILL-02 | Scheduling follows FSRS. The student rates their answer, or the automatic grading provides the recall rating. | P2 | S |
| F-DRILL-03 | The student has a drill tab with the session of the day or of the week, of N questions, duration configured by the teacher or the admin. | P2 | S |
| F-DRILL-04 | Drill is opt-in. The teacher sees aggregates per classroom and per tag, never the individual detail by default. | P2 | S |
| F-DRILL-05 | The student sees per tag a mastery indicator derived from the FSRS retention, and their strengths and weaknesses. | P2 | S |

## F-ADMIN Administration

| Id | Requirement | Phase | Prio |
|---|---|---|---|
| F-ADMIN-01 | List of users, roles, last sign-in. Promotion to teacher. | P1 | M |
| F-ADMIN-02 | Runner status: available languages, queue, mean time, errors. | P1 | M |
| F-ADMIN-03 | Global settings: LLM providers, default drill duration, announcement message. | P2 | S |
| F-ADMIN-04 | Audit log of sensitive actions: deletion, re-grading, role change, release of results. | P1 | S |
