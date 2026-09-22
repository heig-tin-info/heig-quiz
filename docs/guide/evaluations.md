# Evaluations

An evaluation is an ordered list of questions taken from the pools of a course, played by one classroom under a set of rules: how long, in what order, with what feedback. This page walks through creating one and configuring it. Running it in front of the class is covered in [Running an evaluation](live.md), and what comes after in [Grading and results](grading.md).

## Create an evaluation

Open the classroom and its **Evaluations** tab (see [Classrooms](classrooms.md)), then click **New evaluation**. Give it a **Title** and pick a **Mode**:

- **Exam**: graded, taken in one sitting, no feedback before you release the results.
- **Exercise**: practice at home, with a deadline and feedback as soon as a question is validated.

The mode is not a lock. It picks the starting preset and decides which feedback timings are offered, and everything else stays yours to change. Click **Create evaluation**: the new evaluation opens in `draft` on its first step.

The configuration screen has three tabs, **Questions**, **Time and mode** and **Launch**. They are tabs, not a wizard: you can come back to any of them, and the step is part of the address (`?step=timing`), so a bookmark or a shared link lands on the right one. **Preview as student** stays in the header on all three.

## Step 1: Questions

<figure markdown="span">
  ![The Questions step of a draft evaluation with five items](../assets/screenshots/eval-questions-light.png#only-light)
  ![The Questions step of a draft evaluation with five items](../assets/screenshots/eval-questions-dark.png#only-dark)
  <figcaption>Step 1 lists the items in the order the student will read them, each with its points.</figcaption>
</figure>

### Add questions

Click **Add questions**. The sheet lists the published questions of the pools linked to this course (see [Pools](pools.md)), with a **Pool** selector, a type and difficulty filter and a search field. Tick the ones you want, then **Add 3 questions**: they are appended to the list. Only published questions can be added: a draft in the pool never reaches a student.

Each row shows the question's internal name, its type and the version it was frozen on (`v1`, `v2`...). The footer sums it up: `5 questions · 11 points`.

### Points

Every item carries a number of points, in the **pts** field of its row. The default depends on the type: 1 point for a multiple choice or a short answer, one point per blank for a fill-in-the-blanks question, and one point per test case for a code question. In the screenshot the code question is worth 5 and the cloze 3 for that reason. Change the value and it is saved when you leave the field; the total at the bottom follows.

### Reorder

Drag the grip at the left of a row to move it. From the keyboard: focus the grip, press `Space` to pick the row up, move it with the arrow keys, press `Space` again to drop it.

### Milestones

A milestone is a line drawn across the list. For the student, everything above the line closes once they pass it: they confirm, then they cannot go back to those questions. It is the tool for a quiz whose second part gives away the answers of the first.

Hover the space between two rows and click **Add a milestone** to put one there. A milestone belongs to the row above it and travels with that row when you drag it. The **×** on the separator removes it. Milestones only act when the navigation is set to **Milestones** in the advanced options (below); otherwise they are drawn but not enforced.

### Frozen versions and the update banner

Adding a question freezes it on its current published version. If you publish a newer version of that question later, this evaluation does not change behind your back: the row shows `version 2 available` and a banner above the list says **One question has a newer published version.** or **3 questions have a newer published version.** Click the refresh button on one row to move that item forward, or **Update it** / **Update 3 questions** in the banner to move them all.

This is only offered while nobody has started. Once an attempt exists, the versions are locked and the way to apply a corrected key is **Re-grade this question** in the grading panel, described in [Grading and results](grading.md).

### Remove an item

The bin at the end of a row takes the item out of this evaluation. The question itself stays in its pool.

!!! tip
    Use **Preview as student** after assembling the list. It shows the whole evaluation the way a student receives it, statement by statement, and catches a question that reads well in the pool but makes no sense in this order.

## Step 2: Time and mode

<figure markdown="span">
  ![The Time and mode step with the in-class preset selected](../assets/screenshots/eval-timing-light.png#only-light)
  ![The Time and mode step with the in-class preset selected](../assets/screenshots/eval-timing-dark.png#only-dark)
  <figcaption>Step 2 opens on two presets; the settings they wrote stay visible and editable underneath.</figcaption>
</figure>

### The two presets

Two cards carry this step. Clicking one writes a handful of settings at once; you can then change any of them individually, and the card stays highlighted as long as its two defining choices (the timing and the waiting room) hold.

| Preset | Time | Waiting room | Feedback | Navigation and layout |
| --- | --- | --- | --- | --- |
| **In-class evaluation** | 45 minutes per student | **You start** | **On release**, key and explanation shown | Free, one question per screen, questions and choices shuffled, progress bar |
| **Homework exercise** | Common end, one week from now | **None** | **Right away**, key and explanation shown | Free, continuous scrolling, choices shuffled, progress bar |

An **Exam** never gives feedback right away, whatever the preset says: the server keeps it at **On release**.

### Timing

The **Time** row offers three modes, each explained by a sentence under the label:

- **Per student**: each student gets the same number of **Minutes**, counted from their own start. A late student gets the full duration.
- **Common end**: everybody stops at the instant in **Closes at**, whenever they started.
- **I close it**: no deadline at all; the evaluation ends when you close it from the dashboard.

**Opens at** is the moment a scheduled evaluation opens by itself (see Step 3). An exam needs a duration or a common end.

Extra time granted on the roster (see [Students](students.md)) applies on top: a student with `+25 % time` gets 56 minutes out of 45 in **Per student** mode, and in **Common end** mode their own end is pushed past the common one.

### Advanced options

Everything else lives behind **Advanced options**, folded by default. A novice never has to open it to run a first quiz; the settings are, in order:

- **Navigation**: **Free** (the student moves between questions as they like), **Forward only** (a validated question is never reopened) or **Milestones** (going past a milestone locks everything before it).
- **Presentation**: **One by one** (one question per screen), **Continuous** (a single scrolling page) or **Free choice** (the student picks). **Free choice** is only offered with free navigation.
- **Waiting room**: **None** (a student who opens the evaluation starts straight away), **Automatic** (everybody waits, and it starts by itself once the whole roster is there) or **You start** (everybody waits on the ring until you press **Start**).
- **Shuffle the questions**: a different order per student, stable across reloads.
- **Shuffle the choices**: applies to the question types that allow it.
- **Show the progress bar**: the student sees which questions are done, seen and empty.
- **Log tab changes** and **Recommend full screen**: nothing is blocked, the journal is yours on the dashboard.
- **Feedback**: **None** (the student never sees a correction here), **On release** (nothing until you publish the results) or **Right away** (as soon as the student validates a question, exercises only). Two separate switches decide what the feedback carries: **Show the expected answer** and **Show the explanation**. Your comment on an adjusted grading is always part of it.
- **Multiple-answer scoring**: the policy every multiple-choice item of this evaluation uses when the student ticks only some of several correct answers, unless the question names its own. **Exact**, **True/false**, **Distance**, **Symmetric** or **Ripkey**; a question with a single correct answer is always all or nothing. The formulas are in [Question types](question-types.md).
- **Access code**: asked once, before the student enters. Three characters at least; empty means no code.
- **Grading scale**: **Linear** (grade = 1 + 5 × points / total) or **Threshold** (grade = 1 + 5 × points / threshold, capped at 6). Both land on the Swiss 1 to 6 scale, rounded to the tenth.

!!! note
    The waiting room and the feedback policy are part of what the presets decide, but their controls sit under **Advanced options**, not on the main card. Open the disclosure to change them.

## Step 3: Launch

<figure markdown="span">
  ![The Launch step with its summary and the two actions](../assets/screenshots/eval-launch-light.png#only-light)
  ![The Launch step with its summary and the two actions](../assets/screenshots/eval-launch-dark.png#only-dark)
  <figcaption>Step 3 sums the evaluation up and offers one action: open the waiting room now, or schedule it.</figcaption>
</figure>

The summary shows four figures: **Questions**, **Points**, **Time** and **Feedback**. Read them once; if one surprises you, the tab to fix it is one click away. Below, one primary action and one alternative:

- **Open the waiting room** moves the evaluation to `lobby` right now and takes you to the dashboard. Students see it on their home page and gather on the ring. With the waiting room set to **None**, they start as soon as they enter.
- **Schedule it** moves it to `scheduled`. Fill **Opens at** on the previous step first: at that instant the server opens the waiting room by itself, or starts the evaluation straight away if there is no waiting room, without anyone logged in. A common end in **Closes at** is enforced the same way. **Back to draft** unschedules it.

An evaluation with no question cannot be opened or scheduled.

<figure markdown="span">
  ![A scheduled evaluation with its scheduled badge](../assets/screenshots/eval-scheduled-light.png#only-light)
  ![A scheduled evaluation with its scheduled badge](../assets/screenshots/eval-scheduled-dark.png#only-dark)
  <figcaption>A scheduled evaluation stays editable and opens on its own at the announced time.</figcaption>
</figure>

### Student preview

<figure markdown="span">
  ![The student preview sheet over the launch step](../assets/screenshots/eval-preview-light.png#only-light)
  ![The student preview sheet over the launch step](../assets/screenshots/eval-preview-dark.png#only-dark)
  <figcaption>The student preview renders the whole evaluation as a student gets it, read-only.</figcaption>
</figure>

**Preview as student** opens the **Student preview** sheet: every question in order, with its type and points, exactly as the player will render it. It is read-only, nothing you do in it is saved, and no attempt is created. **Done** closes it.

## The states of an evaluation

| State | How it gets there | What students see |
| --- | --- | --- |
| `draft` | Creation, or **Back to draft** | Nothing |
| `scheduled` | **Schedule it** | Nothing until **Opens at** |
| `lobby` | **Open the waiting room**, or the server at **Opens at** | The waiting room ring and the announced duration |
| `running` | **Start** on the dashboard, an automatic waiting room filling up, or the server when there is no waiting room | The questions and their own countdown |
| `paused` | **Pause** on the dashboard | Their countdown frozen; **Resume** brings it back |
| `closed` | **Close** on the dashboard, or the server once every deadline has passed | Their attempt handed in; nothing more until you publish |
| `released` | **Publish results** on the results page | Their grade and the feedback the policy allows |

Once an evaluation is running, every control lives on the dashboard: pausing, extending, closing. The **Launch** tab only offers **Go to the dashboard**.

## What can still change once someone has started

As soon as one attempt exists, the banner **A student has already started: the structure is frozen.** appears on the first two steps. Frozen: the list of questions, their versions, their points and order, the milestones, the timing mode and duration, the waiting room, the navigation, the presentation, the shuffling, the scoring policy and the grading scale. Anything that decides what a student sees or what an answer is worth is fixed, so that every student plays the same evaluation.

Still editable: the feedback policy and its two switches, and the access code. You can decide after the fact to show the explanation with the results, or to hide the key.

!!! warning
    A student who has started keeps the version of each question they started with. If a key turns out to be wrong, fix the question in its pool, publish it, then use **Re-grade this question** in the grading panel against the new version. Do not delete and recreate the evaluation: its attempts go with it.
