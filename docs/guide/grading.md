# Grading and results

Closing an evaluation starts the grading. Most of it is automatic; your part is to validate what the machine proposes, adjust the cases it cannot judge, then publish. This page follows that order: what happens at the close, the grading panel, the results page, publishing.

## What happens at the close

The moment an evaluation is closed, by you or by the server at the last deadline, every answer of a deterministic type is graded: multiple choice, short answer and fill in the blanks are scored on the spot and come back already validated. Code answers are sent to the runner, which compiles and runs each one against the question's test cases in an isolated container; their gradings come back as validated too once the runner has spoken. A missing answer is worth 0 and the entry says so (**No answer**, graded zero).

The card at the top of the grading panel tracks the pass: `Automatic grading · 25 of 25 answers graded`. While it is incomplete it also says what is still `waiting for the runner` and what `failed`, and offers **Run grading**, which starts the pass again on whatever has not been graded yet.

## The grading panel

<figure markdown="span">
  ![The grading panel by question, on a multiple-choice item](../assets/screenshots/grading-light.png#only-light)
  ![The grading panel by question, on a multiple-choice item](../assets/screenshots/grading-dark.png#only-dark)
  <figcaption>By question: one item at a time, every student's answer to it, the first one open.</figcaption>
</figure>

Open it from the classroom row of a closed evaluation, from **Go to grading** on the dashboard, or from the **Grading panel** button on the results page. The subtitle states the job: **Validate the proposals, adjust what needs it, then publish.**

### By question or by student

The panel is **By question** by default: one item across the whole class. Grading twenty answers to the same question in a row is how you stay consistent, and it is the order in which an odd answer key becomes obvious. **By student** walks one attempt in quiz order instead, which is the order you want when a student comes to discuss their paper.

<figure markdown="span">
  ![The same panel by student](../assets/screenshots/grading-by-student-light.png#only-light)
  ![The same panel by student](../assets/screenshots/grading-by-student-dark.png#only-dark)
  <figcaption>By student: the five answers of one attempt, in quiz order.</figcaption>
</figure>

The card at the top says where you are, **Question 1 of 5** or **Student 1 of 5**, and how many answers are left to validate; the chevrons at its edges move to the previous or next question or student, and the segmented bar under it shows the progress on each. The left card names the current question with its type, its points and its number of answers, or the current student with their number of answers.

### Filters and names

The row of filters narrows the list: **All**, **To validate** or **Validated**; a **Source** selector (`automatic`, `manual`, or `model` for the assistance planned in a later phase and not available yet); and a **Confidence** selector, which only matters for proposals that carry one.

Names are hidden by default: each student wears a stable pseudonym such as `Brave Jaguar`, and the note under the filters says why: **Names are hidden by default: a pseudonym keeps the grading about the answer.** The **Show names** switch reveals them when you need to.

## What each type shows

Every entry opens on the statement, the student's answer, the score with how it was computed, and the question's explanation, the same one a student reads if the feedback policy allows it.

A multiple choice lists the choices with the ticked ones highlighted and the correct ones flagged `Correct`, then the score with its breakdown: `Score 1 / 1 · Correct choices ticked 1/1 · Wrong choices ticked 0/3`. A question with several correct answers is scored by the policy of the evaluation or of the question, described in [Question types](question-types.md).

<figure markdown="span">
  ![Grading a short-answer question](../assets/screenshots/grading-short-light.png#only-light)
  ![Grading a short-answer question](../assets/screenshots/grading-short-dark.png#only-dark)
  <figcaption>A short answer: the text typed, which matcher accepted it, and the accepted answers.</figcaption>
</figure>

A short answer shows **Your answer** with an `Accepted` or rejected flag, which matcher accepted it (`Matched by #1 · exact`), and the list of **Accepted answers**. When the automatic pass rejected a spelling you would accept, this is the view where you see it and adjust.

<figure markdown="span">
  ![Grading a fill-in-the-blanks question](../assets/screenshots/grading-cloze-light.png#only-light)
  ![Grading a fill-in-the-blanks question](../assets/screenshots/grading-cloze-dark.png#only-dark)
  <figcaption>Fill in the blanks: the text with the student's words in place, then a table per blank.</figcaption>
</figure>

A fill-in-the-blanks question renders the text with the student's words in the blanks, then a table with one row per blank: **Blank**, **Your answer** with its verdict, **Expected**. The score line adds `Weighted blanks 3/3`, since a blank may weigh more than another.

<figure markdown="span">
  ![Grading a code question with its test cases](../assets/screenshots/grading-code-light.png#only-light)
  ![Grading a code question with its test cases](../assets/screenshots/grading-code-dark.png#only-dark)
  <figcaption>A code question: one row per test case with the expected and obtained output, and the reference solution.</figcaption>
</figure>

A code question shows the points earned, then one row per test case: **Case**, **Arguments**, **Expected**, **Got**, **Verdict** (`Passed` or failed) and **Points**. A case marked `Hidden case` was never shown to the student. When the source did not compile, the view says **Compilation failed** and shows the **Compiler output** instead of the table; a program that died shows `Crashed`. The **Reference solution** is displayed underneath so you can compare without opening the question.

## Acting on an answer

**Validate** takes the proposal as it stands and moves to the next entry. Automatic gradings are already validated, so the button only appears on proposals still waiting for you.

<figure markdown="span">
  ![The Adjust sheet with points and a comment](../assets/screenshots/grading-override-light.png#only-light)
  ![The Adjust sheet with points and a comment](../assets/screenshots/grading-override-dark.png#only-dark)
  <figcaption>Adjusting a grading: the points and a mandatory comment the student will read.</figcaption>
</figure>

**Adjust** opens the sheet **Adjust this grading** for any grading, automatic or not. Enter the **Points** (between 0 and the item's maximum) and a **Comment, visible to the student**. The comment is mandatory: a student who reads a grade different from the machine's deserves to know why. **Save and validate** stores it as a manual grading and validates it. The grading it replaces is never deleted; **History (2)** on the entry opens every earlier grading with its points, its source and its note.

<figure markdown="span">
  ![The batch bar offering to validate every proposal of a question](../assets/screenshots/grading-batch-light.png#only-light)
  ![The batch bar offering to validate every proposal of a question](../assets/screenshots/grading-batch-dark.png#only-dark)
  <figcaption>The batch bar validates every proposal of the current question, or of the filtered selection, in one click.</figcaption>
</figure>

When a question still has proposals, a bar above the list offers **Validate the 4 proposals of this question**, or **Validate the 4 proposals of this selection** when a filter is active, with the reminder **Each grading stays editable after validation.** The confirmation says the same, and a toast counts what was validated.

### Re-grade a question

**Re-grade this question**, in the left card, runs the automatic grading again on every attempt of this item. The sheet asks for a **Published version**, left empty to keep the version the evaluation froze, or set to a newer one after you fixed the key in the pool, and a **Note, kept with every new grading**, which is mandatory and travels with each grading it produces. The gradings it replaces stay in the history, marked `Re-graded` with your note. The results page and, if they were published, the students' grades follow.

### When the runner is unavailable

If the runner cannot be reached when the evaluation closes, the code answers are not lost: each one comes back as a proposal worth `0 / 5` with the message **The answer could not be run automatically; it is waiting for a manual grade.** and a **Grading note** reading `runner_unavailable`. The progress card counts them as `4 waiting for the runner` and shows **Run grading**. Once the runner is back, **Run grading** sends them again and the proposals are replaced by real verdicts. If it will not be back in time, **Adjust** each one by hand, or accept the zero with the batch bar. The same happens, with the note `runner_busy`, when the runner was saturated.

### Shortcuts

| Key | Action |
| --- | --- |
| `V` | Validate the open entry and move on |
| `←` `→` | Previous or next entry |
| `O` | Adjust the open entry |

When the filter **To validate** shows **Nothing left to grade**, the **Results** button in the header is the next step.

## The results page

<figure markdown="span">
  ![The results by student, before publication](../assets/screenshots/results-light.png#only-light)
  ![The results by student, before publication](../assets/screenshots/results-dark.png#only-dark)
  <figcaption>The Students tab: four figures, the distribution, and one row per student.</figcaption>
</figure>

### Students

The **Students** tab opens on four figures: **Mean**, **Median**, **Standard deviation** and **Pass rate**, the share of students at 4.0 or above, with the count under it (`3 / 6`). The **Grade distribution** histogram follows, in half-grade buckets from 1 to 6.

Then one row per student on the roster: **Student**, **E-mail**, **Points**, **Grade**, **Time** used, and the **State** of their attempt: `submitted` by the student, `expired` by the server at the deadline, `in progress` or `not started` for an attempt the close has not caught up with yet, or `absent` for a student who never connected. An absent student has 0 points and the grade 1.0, so that the class figures are honest.

### The grade

The grade comes from the evaluation's scale, chosen in its advanced options (see [Evaluations](evaluations.md)). **Linear** maps the full total onto the Swiss scale, `1 + 5 × points / total`; **Threshold** names the number of points that earns a 6, `1 + 5 × points / threshold`, capped at 6. Either way the result lies between 1.0 and 6.0 and is rounded to the tenth, to the nearest by default.

It is computed from the validated gradings, never typed in: adjust one grading in the panel and the row moves. A proposal not yet validated does not count.

<figure markdown="span">
  ![The results by question with success rate and distribution](../assets/screenshots/results-questions-light.png#only-light)
  ![The results by question with success rate and distribution](../assets/screenshots/results-questions-dark.png#only-dark)
  <figcaption>The Questions tab: one block per item, meant to be scrolled through with the class.</figcaption>
</figure>

### Questions

The **Questions** tab lists one block per item in quiz order, headed by its type, its number of answers and its **Success rate**. Each block shows **Question and answer key**, the explanation, and the **Answer distribution**: per choice for a multiple choice, per typed value for a short answer, per blank for a cloze, and per **Test cases** passed for a code question, with the reference solution. It is written to be scrolled through on the projector while you go over the paper in class.

### Export CSV

**Export CSV** downloads one row per student: `email`, `last_name`, `first_name`, one column per item named after the question's internal name with the points earned, `total` and `grade`. The file uses semicolons and starts with a UTF-8 byte-order mark, so Excel opens it directly with the accents intact and without an import dialog.

## Publishing the results

<figure markdown="span">
  ![The confirmation before publishing the results](../assets/screenshots/results-release-confirm-light.png#only-light)
  ![The confirmation before publishing the results](../assets/screenshots/results-release-confirm-dark.png#only-dark)
  <figcaption>Publishing asks once; from then on every student of the classroom sees their grade.</figcaption>
</figure>

Until you publish, a student who opens their results sees **Results not published yet**. **Publish results** asks **Publish the results of "Test 0"?** and reminds you that **Every student of this classroom sees their grade and the feedback the policy allows.** Confirm with **Publish**.

What a student sees then follows the feedback policy of the evaluation: their points per question and their grade always; their own answer, the expected answer if **Show the expected answer** is on, the explanation if **Show the explanation** is on, and the comment you wrote on any adjusted grading. With the feedback set to **None**, they see the grade and nothing else. On an exercise with feedback **Right away**, they had it question by question while working; publishing adds the grade.

<figure markdown="span">
  ![The results page after publication](../assets/screenshots/results-released-light.png#only-light)
  ![The results page after publication](../assets/screenshots/results-released-dark.png#only-dark)
  <figcaption>After publication, the page says when, and offers to publish again or to withdraw.</figcaption>
</figure>

Once published, the subtitle reads **Published just now** and the primary button becomes **Publish again**. If a grading changes after that, through **Adjust** or a re-grade, a banner says **Modified after publication**: the students still read the grades of the last publication, and **Publish again** updates them. The menu beside the button offers **Withdraw the publication**, which takes the grades back out of sight until you publish again; the gradings themselves are untouched.

### A grade in two steps

The grade of an attempt is frozen twice, in plain words: a provisional grade at the close, a final one at the release. When the evaluation closes, the automatic pass produces a grade you can already read on the results page, and every adjustment, validation or re-grade moves it. When you publish, that grade is snapshotted with the instant of publication: what the student reads is that snapshot, not a live computation, and a later change only reaches them through **Publish again**. The state of the evaluation moves to `released` and the publication is written to the audit log.

The two-step freeze is inherited from the sibling classroom project, where it settles disputes about deadlines; see [ADR-012](../adr/ADR-012-gel-note-deux-temps.md) for the reasoning. Here the practical rule is simpler: nothing a student reads changes without you pressing **Publish** once more.

!!! warning
    Publishing is per evaluation, not per student. Check the **To validate** filter of the grading panel before you publish: an unvalidated proposal counts for nothing in the grade, and a student whose code answers were waiting for the runner would read a grade computed without them.

!!! tip
    Keep the CSV. A grade in the platform can change with a re-grade; the file you exported on the day of the publication is the record you announced to the class.
