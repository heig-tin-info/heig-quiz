# Grading and results

Closing an evaluation starts the grading. Most of it is automatic; your part is to validate what the machine proposes, adjust the cases it cannot judge, then publish. This page follows that order: what happens at the close, the grading panel, the results page, publishing.

## What happens at the close

The moment an evaluation is closed, by you or by the server at the last deadline, every answer of a deterministic type is graded: multiple choice, short answer and fill in the blanks are scored on the spot and come back already validated. Code answers are sent to the runner, which compiles and runs each one against the question's test cases in an isolated container; their gradings come back as validated too once the runner has spoken. Code-to-picture and circuit answers go to the runner too, to draw the picture or simulate the schematic. A categorize question is scored on the spot. An essay waits for you, unless the platform has a language model to propose a grade (see [Essays and AI proposals](#essays-and-ai-proposals)). A missing answer is worth 0 and the entry says so (**No answer**, graded zero).

While some answers of the question you are on have not been graded — still at the runner, or left by a grader that could not decide — a banner above the table counts them and offers **Run grading**, which starts the pass again on that question. The command palette runs it on the whole evaluation.

## The grading panel

<figure markdown="span">
  ![The grading table of a multiple-choice question](../assets/screenshots/grading-light.png#only-light)
  ![The grading table of a multiple-choice question](../assets/screenshots/grading-dark.png#only-dark)
  <figcaption>One question at a time: the expected answer on top, then every student's answer as a row.</figcaption>
</figure>

Open it from the classroom row of a closed evaluation, from **Go to grading** on the dashboard, or from the **Grading panel** button on the results page. The subtitle states the job: **Validate the proposals, adjust what needs it, then publish.**

### One question at a time

You grade question by question: one item across the whole class. Grading twenty answers to the same question in a row is how you stay consistent, and it is the order in which an odd answer key becomes obvious. To look at one student's whole paper, open the results page.

The card at the top says which question you are on, **Question 1 of 9**, with its type, its points, its internal name and how many answers are still **to validate** (or **All validated**). **Question 1 of 9** opens the list of every question with what each one still asks for; the chevrons at the card's edges move to the previous or next question. Under it, a stepper shows every question of the evaluation: a filled circle is a question whose answers are all validated, and a click jumps to it.

### The table

Each row is one student's answer. It starts with a verdict square: a solid green check for full marks, a striped green square for partial credit, a red cross for no credit (a missing answer or a negative score included), and a dashed **?** for an answer nothing has judged yet — still at the runner, or an essay waiting for a grade by hand; its tooltip says which. Then come the answer's own columns, the **Points** and the row's actions.

The columns depend on the question type. A multiple choice gets one column per choice, lettered as in the editor: a ticked choice is filled green when it is correct and red when it is not, and a correct choice left out is drawn dashed. A short answer gets one column with the text typed, tinted by its verdict. A fill-in-the-blanks question gets one column per blank.

A categorize question gets one column per card, headed by the card: each cell names the column the student put it in, green where the card belongs there and red where it does not, and a dash for a card left out. With more than eight cards, one column counts the cards placed right instead (`7/9 right`); open the row to see the board. A code question gets one wide column with the program the student wrote, the parts they could edit, and a chip counting the tests passed (`3/4 tests`), or `runner…` while the runner still owes the verdict. A program longer than five lines is folded: click it to unfold it in place, click again to fold it; the row does not open. A code-to-picture question adds the picture the program drew, as a small thumbnail beside the program. A circuit shows what the schematic holds (`3 parts · 4 wires`) and how many stimuli it passed; hover the chip for the ones that failed, and open the row for the drawing. An essay shows its first three lines as plain text.

The first row, on a blue background, is the **Expected answer**: the correct choices, the accepted answers, the key of each blank, the column of each card, the reference solution of a program (with the target picture), what the reference circuit holds, or the model answer of an essay (else its rubric). Its two buttons **Edit question** and **Re-grade** are there for the moment you notice the key is wrong.

Click any column header to sort by it, click again to reverse the order, a third time to go back to the table's own order. Rows with the same value keep their relative order.

### Filters and anonymity

The row under the question card narrows the table: **All** or **To validate** (with its count); **Graded by** **Any**, **Rules**, **AI** or **Teacher**; and, once **AI** is picked, a **Confidence** filter. These filters are remembered by your browser from one visit to the next.

**Anonymise** is on every time you open the panel. The student's name is not even sent to your browser: the Student column is simply absent, and the rows are shuffled in an order drawn for this visit, which stays the same while you work — a validation never makes a row jump. Two things still show on a row, because they are not names: the attempt number of an exercise a student retook (`#2`, in green for the attempt that counts), and a **Teacher** badge on a teacher's own test run. Switch **Anonymise** off to see a **Student** column, sorted by name.

## What each type shows

Clicking a row, or pressing **Enter** on it, opens the answer on the right: the statement as the student saw it, their answer with the score and how it was computed, the question's explanation (the same one a student reads if the feedback policy allows it), and the history of its gradings. **↑** and **↓** move to the previous or next row without closing it.

A multiple choice lists the choices with the ticked ones highlighted and the correct ones flagged `Correct`, then the score with its breakdown: `Score 1 / 1 · Correct choices ticked 1/1 · Wrong choices ticked 0/3`. A question with several correct answers is scored by the policy of the evaluation or of the question, described in [Question types](question-types.md).

<figure markdown="span">
  ![Grading a short-answer question](../assets/screenshots/grading-short-light.png#only-light)
  ![Grading a short-answer question](../assets/screenshots/grading-short-dark.png#only-dark)
  <figcaption>A short answer: the text typed, tinted by its verdict, and the accepted answers on the expected row.</figcaption>
</figure>

A short answer shows **Your answer** with an `Accepted` or rejected flag, which matcher accepted it (`Matched by #1 · exact`), and the list of **Accepted answers**. Sort the table by the answer column to bring identical spellings together: when the automatic pass rejected one you would accept, you see all of them at once.

<figure markdown="span">
  ![Grading a fill-in-the-blanks question](../assets/screenshots/grading-cloze-light.png#only-light)
  ![Grading a fill-in-the-blanks question](../assets/screenshots/grading-cloze-dark.png#only-dark)
  <figcaption>Fill in the blanks: one column per blank in the table, the text with the student's words in the answer.</figcaption>
</figure>

A fill-in-the-blanks question renders the text with the student's words in the blanks, then a table with one row per blank: **Blank**, **Your answer** with its verdict, **Expected**. The score line adds `Weighted blanks 3/3`, since a blank may weigh more than another.

<figure markdown="span">
  ![Grading a code question with its test cases](../assets/screenshots/grading-code-light.png#only-light)
  ![Grading a code question with its test cases](../assets/screenshots/grading-code-dark.png#only-dark)
  <figcaption>A code question: each program in one wide column, folded after five lines, beside the tests it passed.</figcaption>
</figure>

Opened, a code question shows the points earned, then one row per test case: **Case**, **Arguments**, **Expected**, **Got**, **Verdict** (`Passed` or failed) and **Points**. A case marked `Hidden case` was never shown to the student. When the source did not compile, the view says **Compilation failed** and shows the **Compiler output** instead of the table; a program that died shows `Crashed`. The **Reference solution** is displayed underneath so you can compare without opening the question.

<figure markdown="span">
  ![Grading a categorize question, one column per card](../assets/screenshots/grading-categorize-light.png#only-light)
  ![Grading a categorize question, one column per card](../assets/screenshots/grading-categorize-dark.png#only-dark)
  <figcaption>A categorize question: one column per card, naming the column the student chose, green where it belongs and red where it does not.</figcaption>
</figure>

A categorize question is scored on the spot, card by card, and its gradings arrive validated: the striped squares are the partial scores. Opened, it shows the student's board, each card marked right or wrong, and the score line `Placed cards right 7/7`.

<figure markdown="span">
  ![Grading a code-to-picture question while the runner is away](../assets/screenshots/grading-codeimage-light.png#only-light)
  ![Grading a code-to-picture question while the runner is away](../assets/screenshots/grading-codeimage-dark.png#only-dark)
  <figcaption>A code-to-picture question: the program, and the picture it drew once the runner has run it; here the runner was away, so `runner…` stands in for it.</figcaption>
</figure>

A code-to-picture question draws the picture the program printed beside its source, the target picture on the expected row. Until the runner has run the program, the picture is `runner…` and the row is a **?**: that is what the screenshot shows, taken without a runner.

<figure markdown="span">
  ![Grading a circuit while the simulator is away](../assets/screenshots/grading-circuit-light.png#only-light)
  ![Grading a circuit while the simulator is away](../assets/screenshots/grading-circuit-dark.png#only-dark)
  <figcaption>A circuit: what each schematic holds; the chip counts the stimuli passed once the simulator has run, `simulator…` until then.</figcaption>
</figure>

A circuit shows what each schematic holds, and a chip that counts the stimuli it passed once the simulator (the runner's) has run it. Opened, it shows the drawing and, once simulated, the student's and the reference's curves side by side. A circuit graded by hand gets the curves too, for your eyes, and a 0-point proposal for you to settle.

### Essays and AI proposals

<figure markdown="span">
  ![Grading essays with the AI's proposals](../assets/screenshots/grading-essay-light.png#only-light)
  ![Grading essays with the AI's proposals](../assets/screenshots/grading-essay-dark.png#only-dark)
  <figcaption>An essay: the first three lines of each answer, the model answer on the expected row, and under each score the AI's confidence.</figcaption>
</figure>

An essay is graded by you: without a language model, each written essay arrives as a 0-point proposal to read and grade, and an empty one as a validated zero. When the platform has a language model configured, the essay, your rubric and the model answer are sent to it, with nothing that names the student, and it proposes points, a confidence and a short justification. The justification is for you alone: it appears in the open answer as **The AI's justification, never shown to the student**, and a validation does not turn it into the comment a student reads; write your own through **Adjust** if the student should know why.

<figure markdown="span">
  ![An AI proposal opened, with its justification](../assets/screenshots/grading-ai-justification-light.png#only-light)
  ![An AI proposal opened, with its justification](../assets/screenshots/grading-ai-justification-dark.png#only-dark)
  <figcaption>An AI proposal opened: the answer beside the criteria and the model answer, then the model's justification, for your eyes only.</figcaption>
</figure> Under the points the row then reads `AI · High`, `AI · Medium` or `AI · Low`; the **Graded by** filter set to **AI** adds a **Confidence** filter, so you can validate the confident proposals together and read the others one by one. A proposal is never final until you validate it. No model is called while an evaluation is running.

!!! note
    No language model is configured on the platform yet: your essays arrive as proposals to grade by hand. The screenshots on this page come from the demo world, graded by a development stand-in that proposes a grade from the rubric's words and says so in every justification.

## Acting on an answer

**Validate** takes a proposal as it stands. It appears on the rows still waiting for you, and at the foot of the open answer; automatic gradings are already validated. A proposal worth 0 points that no grader stood behind — an essay waiting to be read, a program the runner never ran — is never validated as it stands: its row offers **Grade** instead, which opens the answer on the adjustment form, and **V** leaves it alone.

<figure markdown="span">
  ![Adjusting a grading: points and a comment](../assets/screenshots/grading-override-light.png#only-light)
  ![Adjusting a grading: points and a comment](../assets/screenshots/grading-override-dark.png#only-dark)
  <figcaption>Adjusting a grading: the points and a mandatory comment the student may read.</figcaption>
</figure>

**Adjust**, on a row or at the foot of the open answer, opens **Adjust this grading** under the answer. Enter the **Points** (between 0 and the item's maximum) and a **Comment**. The comment is mandatory, and it is the one comment the student may read with their result if the feedback policy shows comments: a student who reads a grade different from the machine's deserves to know why. **Save and validate** stores it as a manual grading and validates it. The grading it replaces is never deleted: it stays in the answer's **Grading history**.

<figure markdown="span">
  ![The primary button offering to validate the four AI proposals of an essay](../assets/screenshots/grading-batch-light.png#only-light)
  ![The primary button offering to validate the four AI proposals of an essay](../assets/screenshots/grading-batch-dark.png#only-dark)
  <figcaption>On an essay the AI has graded, <strong>Validate 4</strong> validates its four proposals in one click.</figcaption>
</figure>

The one red button of the screen, at the end of the filter row, says what comes next. While the table shows proposals it reads **Validate 4**: it validates the proposals shown, those of the filters you picked included (above ten, it asks first), and a toast counts what was validated; each grading stays editable. An essay or a program proposed at 0 points with nothing behind it (no grader could judge it) is never validated in a batch: read it and grade it. A proposal that states a confidence, an AI's zero included, is. Once every answer of the question is validated, the button becomes **Next question**, and on the last question **Results**. While what is left can only be graded by hand, it stays in place, greyed out, and its tooltip says why.

### Re-grade a question

**Re-grade**, on the expected row, runs the automatic grading again on every attempt of this item. The sheet lists the question's published versions, each with its change note, and a **Note, kept with every new grading**, which is mandatory and travels with each grading it produces. The gradings it replaces stay in the history, marked `Re-graded` with your note. The results page and, if they were published, the students' grades follow.

When the key itself is wrong, the round trip is short:

1. **Edit question** (the pencil on the expected row) opens the question editor. The header's way back reads **Back to grading**.
2. Fix the question and **Publish** it. Publishing takes you straight back to the grading table, on the same question.
3. The expected row now shows **Re-grade** as a **New version** button, with the tooltip **A newer version is published — re-grade**. Click it: the sheet already has the newest version selected. Write the note and confirm.

**Edit question** is offered only to someone who may edit the question's pool (a contributor or its owner). A teaching assistant on the course staff who may not write the pool sees **Re-grade** alone, and asks the pool's owner for the fix.

If the results are already published, the sheet says so before you confirm: re-grading updates the grades the students already see, and marks the results **Modified after publication**.

### When the runner is unavailable

If the runner cannot be reached when the evaluation closes, the code answers are not lost, nor the code-to-picture and circuit ones: each one comes back as a proposal worth `0 / 5` with the message **The answer could not be run automatically; it is waiting for a manual grade.** and a **Grading note** that says the runner was unavailable (never a raw code). The banner above the table counts them and offers **Run grading**. Once the runner is back, **Run grading** sends them again and the proposals are replaced by real verdicts. If it will not be back in time, open each one and **Adjust** it by hand (a zero included, with its comment). The same happens, with a note saying so, when the runner was saturated.

### Shortcuts

The keys of the grading panel are listed in the sidebar while you are on it.

| Key | Action |
| --- | --- |
| `←` `→` | Previous or next question |
| `↑` `↓` | Previous or next row, the expected row first; moves the open answer too |
| `Enter` | Open the selected row |
| `V` | Validate the selected row's proposal |
| `A` | Adjust the selected row |
| `Esc` | Close the open answer |

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

The **Questions** tab lists one block per item in quiz order, headed by its type, its number of answers and its **Success rate**. Each block shows **Question and answer key** drawn as the projection draws it, answers revealed: for a multiple choice every choice with a bar of the papers that ticked it (green on a right choice, red on a wrong one) and their count; for a short answer the values the class typed; for a cloze each blank with its key and a right / wrong bar. Any other type shows the question as the student saw it, followed by what the class answered when the type groups answers (the accuracy of a code image, for instance). A code question adds its reference solution and each test case with the number of papers that passed it; every question adds its explanation.

**Present**, in the header of the page, opens the same questions full screen, dark, one screen per question, for the beamer. It appears once the evaluation is closed. Each question shows how the class fared in one bar — full marks, partial, wrong, no answer — and its success rate; a multiple choice gives a bar per choice with the number of papers that ticked it, a short answer the answers the class wrote, a cloze each blank, a code question each test case. The answers and their colours stay hidden until you press **R** (or **Reveal the answers**), so the room can think first — the choices' bars already show, in grey, how the class voted; **E** shows the explanation, **↓** and **↑** move between questions, **F** goes full screen. Hover a bar for its exact figures. Only validated gradings count: an answer still waiting for your validation is not on the wall.

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

Once published, the subtitle reads **Published just now** and the primary button becomes **Publish again**. If a grading changes after that, through **Adjust** or a re-grade, a banner says **Modified after publication**: the students already read the recomputed grades (F-GRADE-09), and the banner reminds you that they changed since you published. **Publish again** takes the new grades as the published ones and removes the banner. The menu beside the button offers **Withdraw the publication**, which takes the grades back out of sight until you publish again; the gradings themselves are untouched.

### A grade in two steps

The grade of an attempt is frozen twice, in plain words: a provisional grade at the close, a final one at the release. When the evaluation closes, the automatic pass produces a grade you can already read on the results page, and every adjustment, validation or re-grade moves it. When you publish, that grade is snapshotted with the instant of publication: what the student reads is that snapshot, not a live computation, and a later change only reaches them through **Publish again**. The state of the evaluation moves to `released` and the publication is written to the audit log.

The two-step freeze is inherited from the sibling classroom project, where it settles disputes about deadlines; see [ADR-012](../adr/ADR-012-gel-note-deux-temps.md) for the reasoning. Here the practical rule is simpler: nothing a student reads changes without you pressing **Publish** once more.

!!! warning
    Publishing is per evaluation, not per student. Check the **To validate** filter of the grading panel before you publish: an unvalidated proposal counts for nothing in the grade, and a student whose code answers were waiting for the runner would read a grade computed without them.

!!! tip
    Keep the CSV. A grade in the platform can change with a re-grade; the file you exported on the day of the publication is the record you announced to the class.
