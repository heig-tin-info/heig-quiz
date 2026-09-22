# Running an evaluation

The live dashboard is the screen you keep open while the class takes an evaluation. It shows who is in, how far each student has got, and it holds every control that acts on a running evaluation: start, pause, extend, close. This page assumes the evaluation is configured and its waiting room open (see [Evaluations](evaluations.md)).

## Reaching the dashboard

From the classroom's **Evaluations** tab, a row in `lobby`, `running` or `paused` opens the dashboard on a click; the row's menu also offers **Live dashboard** for any evaluation past `draft`. From the configuration screen, the **Launch** tab of a live evaluation shows **Go to the dashboard**.

The **Configure** link above the title leads back to the three configuration steps, where nothing structural can change any more.

## The waiting room

<figure markdown="span">
  ![The dashboard of an evaluation in its lobby](../assets/screenshots/live-lobby-light.png#only-light)
  ![The dashboard of an evaluation in its lobby](../assets/screenshots/live-lobby-dark.png#only-dark)
  <figcaption>Before the start, the grid gives way to a presence ring and two lists.</figcaption>
</figure>

While the evaluation is in `lobby`, the dashboard shows a ring: how many students are present, filling up towards the number enrolled. The students see the same ring on their side, with the announced duration. Two lists name them: **Present**, with a green dot, and **Not here yet**. A student with extra time on the roster wears a `+25 % time` chip, and the panel counts them (**One student has extra time.**), so you know before starting who will run longer than the others.

The status line under the title, `Live · 2 of 6 connected`, says the page is receiving events from the server. Nothing starts until you press **Start now**; a confirmation asks **Start for the 2 students in the waiting room?** From that instant every present student's countdown begins, and a late student who enters afterwards starts with the full duration.

With the waiting room set to **Automatic**, the evaluation starts by itself once everybody on the roster is present. With **None**, there is no lobby at all: each student starts when they open it.

## The grid

<figure markdown="span">
  ![The dashboard during the evaluation, one row per student](../assets/screenshots/live-running-light.png#only-light)
  ![The dashboard during the evaluation, one row per student](../assets/screenshots/live-running-dark.png#only-dark)
  <figcaption>Students down, questions across; the identity column stays put while the question columns scroll.</figcaption>
</figure>

Once the evaluation runs, the ring becomes a grid: one row per student on the roster, one column per question, headed `Q1`, `Q2`... with the question's type underneath. The **Student** column stays fixed while the questions scroll. Beside the name it carries the student's state (`handed in`, `closed`, the extra-time chip), their progress as `3/5 · 60 %`, and their presence: a green dot when connected, `offline` when the page dropped, `never connected` for a student who has not opened the evaluation. **Score** and **Time** show the running score and the individual time left. The **Class** row at the bottom gives the completion rate of each question, then its success rate once the grading exists.

### Cell states

Each cell says where one student stands on one question. The legend under the grid names them:

| Cell | Meaning |
| --- | --- |
| **Not started** | The student has not opened this question |
| **In progress** | The question is open, nothing is written yet |
| **Answered** | Something is written and saved |
| **Done** | The student marked the question as done |
| **Correct**, **Partly correct**, **Wrong** | The verdict, once the evaluation is closed and graded |

A column darkening downward is the class moving through the quiz. With **Answers** on, the cell also carries a glyph of the answer itself: the letters ticked on a multiple choice, the word typed in a short answer, `9L` for nine lines of code.

### The three switches and the projector

Three switches sit above the grid: **Names**, **Answers** and **Results**. They exist for the projector. Turn **Names** off and each row becomes `Student 1`, `Student 2`..., in an order that is shuffled per evaluation and stable across reloads, so the number says nothing about the roster's alphabetical order. Turn **Answers** off and the glyphs disappear; the cells keep only their state. **Results** is what turns a progress cell into a verdict cell once grading exists.

The arrows icon at the top right, or the `F` key, puts the dashboard in full screen for projection.

## The controls

Three buttons live in the header while the evaluation runs.

**Pause** freezes every countdown at once and moves the evaluation to `paused`; the students see their clock stop. The same button becomes **Resume**.

<figure markdown="span">
  ![The Extend menu open on the dashboard](../assets/screenshots/live-extend-light.png#only-light)
  ![The Extend menu open on the dashboard](../assets/screenshots/live-extend-dark.png#only-dark)
  <figcaption>Extend adds one, five or ten minutes to every open attempt at once.</figcaption>
</figure>

**Extend** opens a menu with **+1 minutes**, **+5 minutes** and **+10 minutes**, each labelled **Extend for the whole class**. It pushes the deadline of every open attempt by that much, and a toast confirms `4 attempts extended by 5 minutes.`

Each row has its own actions at the right: **Open the answers**, **+5 minutes for this student**, and **Close this attempt**, which asks **Close the attempt of Emma Favre? They stop being able to write.** A closed attempt shows **Reopen this attempt** instead, which hands the student back an open attempt with their answers intact; the confirmation reminds you that the deadline is recomputed from their original start, not from now, so pair it with **+5 minutes for this student** when they need time.

**Close** ends the evaluation for everybody, after the confirmation **Close the evaluation for everybody? Open attempts are handed in as they are.** Every action here is propagated to the students within a second and logged.

## Inspecting a cell

<figure markdown="span">
  ![A student's answers opened from a cell of the grid](../assets/screenshots/live-inspect-light.png#only-light)
  ![A student's answers opened from a cell of the grid](../assets/screenshots/live-inspect-dark.png#only-dark)
  <figcaption>Clicking a cell opens every answer of that student, updated as they type.</figcaption>
</figure>

Click a cell to open the panel **Answers of Noah Bovet**: every question in order, with the choice ticked, the text typed or the code written, updated live as the student works. Before grading the panel shows the choices only; with **Results** on, after the close, each choice wears `Correct` or `Missed` and each question its score. The counter at the bottom, `1 / 4`, and the arrows move to the previous or next student; `Esc` closes the panel. Nothing here is editable: the panel is read-only.

## The clock belongs to the server

The countdown on the dashboard and on every student's screen is computed on the server's clock, not on any laptop's. Each client corrects its own offset on every tick, so a student whose computer runs three minutes fast sees the same remaining time as everybody else. When a deadline passes, it is the server that closes the attempt, whether or not the student's page is open.

A write that reaches the server after the deadline plus three seconds of grace is refused; the three seconds cover the network, not a late click. **Extend** and **Pause** act on that server deadline, which is why they take effect for a student whose page is closed as well.

A student who loses the network loses nothing. Answers are sent as they type and acknowledged; the player shows an unsaved or offline state while the link is down, and on reload or reconnection the student finds exactly their answers and their position. The row's presence dot goes `offline` in the meantime, which is your signal, not theirs.

!!! note
    A student who never connected has no attempt and no countdown. If they arrive late in **Per student** mode, they start with the full duration from their own start; in **Common end** mode they stop with everybody else, and **+5 minutes for this student** is how you make it up to them.

## After the close

<figure markdown="span">
  ![The dashboard of a closed evaluation with verdicts and scores](../assets/screenshots/live-closed-light.png#only-light)
  ![The dashboard of a closed evaluation with verdicts and scores](../assets/screenshots/live-closed-dark.png#only-dark)
  <figcaption>Once closed and graded, the grid shows verdicts, scores and success rates.</figcaption>
</figure>

When the evaluation is closed, the automatic grading runs and the grid turns into a results grid: each cell is **Correct**, **Partly correct** or **Wrong**, the **Score** column fills in (`7 / 11`), and the **Class** row gives the success rate of each question. Nothing can be extended or paused any more; the header's single action is **Go to grading**, which opens the panel described in [Grading and results](grading.md). The row actions still let you inspect an attempt or reopen it if you decide a student deserves more time after all.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `N` | Toggle **Names** |
| `R` | Toggle **Answers** |
| `S` | Toggle **Results** |
| `Space` | **Pause** or **Resume** |
| `F` | Full screen |
| `Esc` | Close the inspect panel |

The shortcuts are listed in the sidebar and under the grid, so a colleague standing in for you finds them without this page.

!!! tip "During the exam"
    - Before projecting, switch **Names** and **Answers** off. The grid still shows who is done and who is stuck, as `Student 7`.
    - If the evaluation has an **Access code**, write it on the board only once the waiting room is open. A student needs it once, at entry.
    - Check the `+25 % time` chips in the waiting room against your list; extra time comes from the roster, not from this screen.
    - A laptop that dies mid-exam: the attempt is still open on the server and its answers are saved. Let the student log in on another machine and continue. If they lost several minutes, **+5 minutes for this student** from the row's actions. If their attempt expired in the meantime, **Reopen this attempt**, then extend it: a reopened attempt keeps its original deadline.
    - Do not close the evaluation from the row of a student by mistake: **Close this attempt** ends one attempt, the red **Close** ends everybody's. Both ask first.
