# For students

This page is for you if a teacher sends you here. It walks through everything you do on the platform: signing in, finding your classroom, taking an evaluation and reading your results.

## Signing in

Open the platform and press **Sign in with Switch edu-ID**. You sign in with the account of your school; there is no separate password for the platform.

Your teacher adds your school e-mail address to the class list. The seat is attached to your account the first time you sign in with a matching address: there is no code to enter and nothing to accept. If a classroom you expect is missing from your home, check that you signed in with the address your teacher used, and that this address is registered on your Switch edu-ID account.

A **Classroom code** field sits at the bottom of your home. Use it only if your teacher gave you a code for the classroom: type it and press **Join**. Most classrooms use the e-mail match above and have no code.

## Your home

Your home shows what your classrooms have opened for you, in three sections.

<figure markdown="span">
  ![The student home: an exercise open now with Enter the waiting room, a graded quiz coming up in two days, a past graded quiz with View, and the classroom card with extra time](../assets/screenshots/student-home-light.png#only-light)
  ![The student home: an exercise open now with Enter the waiting room, a graded quiz coming up in two days, a past graded quiz with View, and the classroom card with extra time](../assets/screenshots/student-home-dark.png#only-dark)
  <figcaption>The home: what is open now, what is coming up, what is past, and your classrooms.</figcaption>
</figure>

**Open now** lists the evaluations you can enter, each with one button: **Start**, **Resume** if you already began, or **Enter the waiting room** when the teacher has opened one. The badge says whether it is a **Graded quiz** or an **Exercise**, and the card shows how long you have or when it is due.

**Coming up** shows what is scheduled and when it starts. **Past evaluations** keeps what is over, with its state: **handed in**, **time was up** or **not started**, and a **View** button that opens your results.

**My classrooms** lists your classrooms with their teachers. If you were granted extra time, the card shows it, for instance **Extra time: +25%**. It applies automatically to every timed evaluation of that classroom; there is nothing to ask for at the start.

<figure markdown="span">
  ![The same home on a phone, the sections stacked](../assets/screenshots/student-home-phone-light.png#only-light){ width="390" }
  ![The same home on a phone, the sections stacked](../assets/screenshots/student-home-phone-dark.png#only-dark){ width="390" }
  <figcaption>The home on a phone.</figcaption>
</figure>

## The waiting room

An in-class evaluation usually opens on a waiting room. You enter it from your home and wait; your teacher starts the evaluation for everybody at once, and your screen switches to the first question by itself.

<figure markdown="span">
  ![The waiting room: a ring showing 2 of 6 students present, the sentence Your teacher will start the quiz, and three notes about the clock, saving and the single attempt](../assets/screenshots/student-lobby-light.png#only-light)
  ![The waiting room: a ring showing 2 of 6 students present, the sentence Your teacher will start the quiz, and three notes about the clock, saving and the single attempt](../assets/screenshots/student-lobby-dark.png#only-dark)
  <figcaption>The waiting room: how many are present, and what to expect once the teacher presses Start.</figcaption>
</figure>

The ring shows how many students of the class are already here. Under it, three notes tell you what to expect: the clock is the server's, your answers are saved as you type, and you take the evaluation once. If you have extra time, the room says how many minutes that gives you. The line at the bottom reads **Connected · clock synchronised** once your browser has caught the server's time. **Leave** takes you back home; you can come back as long as the room is open.

## Taking an evaluation

The player shows one question per screen. The strip at the top has one segment per question, coloured by its state, and clicking a segment moves to that question when the navigation allows it. The header carries the countdown when the evaluation is timed, the saving indicator, a theme toggle and **Hand in**.

<figure markdown="span">
  ![The player on a phone: the progress strip, question 1 marked Done, four choices with B selected, and the Previous, Done and Next buttons](../assets/screenshots/player-mcq-phone-light.png#only-light){ width="390" }
  ![The player on a phone: the progress strip, question 1 marked Done, four choices with B selected, and the Previous, Done and Next buttons](../assets/screenshots/player-mcq-phone-dark.png#only-dark){ width="390" }
  <figcaption>A multiple-choice question in the player, on a phone.</figcaption>
</figure>

### The question types

- A **multiple-choice** question lists its choices; the line under the statement says whether to choose one answer or several.
- A **short-answer** question has one field under **Your answer**. Spelling counts as far as the teacher decided.
- A **fill-in-the-blanks** question shows a text or a piece of code with fields inside it; fill every blank.
- A **code** question shows the template with the parts you cannot change greyed out and an editor for the part you write. It is described below.

How each type is graded is explained from the teacher's side in `question-types.md`.

### The clock

The countdown in the header is the server's clock, the same for everybody whatever your device says. It counts your own duration from your own start, extra time included. The teacher can pause the evaluation or extend it for the class, and your countdown follows without a reload.

### Navigation

Your teacher chooses one of three rules, and the waiting room names the one in force.

- **Free navigation**: you move between questions as you like and change an answer until the time is up.
- **One way through**: a question you mark as done cannot be opened again.
- **Checkpoints**: the list has milestones. Passing one closes every question before it, and you do not come back. The player asks for confirmation before you cross a milestone.

**Mark as done** tells your teacher you consider the question finished; the segment in the strip turns dark and the header of the question reads **Done**. Under the free rule you can still change the answer afterwards. Under the other two, the hint under the question warns you first: **Once this question is marked as done, it cannot be changed.**

### How answers are saved

Your answers are saved as you type, a fraction of a second after each change. The indicator in the header reads **Saving…** then **Saved**. There is no save button anywhere, and nothing to do before moving on.

If the connection drops, the indicator turns to **Offline** and a banner says **You are offline**: your answers are kept on this device and sent again as soon as the connection comes back. You can keep writing meanwhile. A reload, a closed tab or a crashed browser costs you nothing either: reopening the evaluation brings back your answers and your place. Only what was still unsaved at the very moment of the deadline is lost, and the deadline is what the next section is about.

!!! note
    You take an evaluation once. Opening it in a second tab or on a second device shows the same attempt, not a new one, and two tabs writing the same question overwrite each other. Keep to one.

### Running a code question

A code question has a **Run** button under the editor, next to **Visible cases**. It compiles your program and runs it against the cases the teacher chose to show, and lists what was expected, what your program printed and a verdict per case. The hidden cases only run when the question is graded.

<figure markdown="span">
  ![A code question after Run: the template, the editable region, Compiled, two visible cases both Passed, a note about two hidden cases, and a Try it yourself box](../assets/screenshots/player-run-light.png#only-light)
  ![A code question after Run: the template, the editable region, Compiled, two visible cases both Passed, a note about two hidden cases, and a Try it yourself box](../assets/screenshots/player-run-dark.png#only-dark)
  <figcaption>Run compiles the program and checks it against the visible cases; the hidden ones wait for the grading.</figcaption>
</figure>

Depending on the question, the run happens in your browser: the page says **Runs in your browser — the server grades.** The first run downloads the language runtime and shows **Loading the language runtime… this happens once.**, so run once early rather than at the last minute. **Try it yourself** lets you run the program on an input of your own with **Run once**; nothing there is graded.

Whatever Run says, the grade is computed later by the server, from the source it rebuilds out of the template and what you wrote. Run is a trial, not the grading. If running is unavailable, your answer is still saved and graded normally.

### When the teacher pauses

If your teacher pauses the evaluation, an overlay says **The quiz is paused**. The clock is stopped and what you write is kept until it resumes; the page comes back by itself when it does.

## Handing in

Press **Hand in** in the header when you are done. The confirmation names how many questions are still without an answer, and reminds you that nothing can be changed afterwards. **Cancel** takes you back to the questions.

<figure markdown="span">
  ![The Hand in dialog: 2 questions are still without an answer, nothing can be changed after handing in, with Cancel and Hand in](../assets/screenshots/player-submit-light.png#only-light)
  ![The Hand in dialog: 2 questions are still without an answer, nothing can be changed after handing in, with Cancel and Hand in](../assets/screenshots/player-submit-dark.png#only-dark)
  <figcaption>The confirmation counts the unanswered questions before you hand in.</figcaption>
</figure>

Once handed in, the player is replaced by a card that says **Handed in**, with **See my results** and **Back to home**.

<figure markdown="span">
  ![The Handed in card: Your answers are with your teacher, with See my results and Back to home](../assets/screenshots/player-done-light.png#only-light)
  ![The Handed in card: Your answers are with your teacher, with See my results and Back to home](../assets/screenshots/player-done-dark.png#only-dark)
  <figcaption>After handing in.</figcaption>
</figure>

### At the deadline

You do not have to hand in. When your time is up, the attempt closes by itself and the screen says **Time is up**: your answers were saved and handed in automatically. The server accepts a save that was still travelling for three seconds after the deadline; after that, nothing more is accepted, whatever the browser shows. If your teacher closes the evaluation early, the same happens with the message **The quiz is closed**.

## Your results

**See my results**, or **View** on a past evaluation, opens your results page. What it shows depends on what your teacher decided.

<figure markdown="span">
  ![The results page before publication: Results not published yet, and a sentence saying they will appear here as soon as the teacher publishes](../assets/screenshots/feedback-pending-light.png#only-light)
  ![The results page before publication: Results not published yet, and a sentence saying they will appear here as soon as the teacher publishes](../assets/screenshots/feedback-pending-dark.png#only-dark)
  <figcaption>Before publication, the page only says the results are not published yet.</figcaption>
</figure>

For a graded quiz, nothing shows until your teacher publishes the results: the page reads **Results not published yet**. For an exercise, the feedback may be immediate. An evaluation can also be set to show no feedback at all, in which case the page says so and your teacher tells you your grade otherwise.

<figure markdown="span">
  ![The results on a phone: grade 6.0, points 11 of 11, then one card per question with the chosen answer, the verdict per blank or per test case and the score](../assets/screenshots/feedback-phone-light.png#only-light){ width="390" }
  ![The results on a phone: grade 6.0, points 11 of 11, then one card per question with the chosen answer, the verdict per blank or per test case and the score](../assets/screenshots/feedback-phone-dark.png#only-dark){ width="390" }
  <figcaption>Published results: the grade, the points, and one card per question.</figcaption>
</figure>

Once published, the page shows your **Grade** and your **Points**, then one card per question with your answer and its score. According to the feedback policy of the evaluation, a card may also show the expected answer, an **Explanation** written by the teacher, and **Your teacher's comment** on your answer. If your teacher adjusts a grading afterwards and publishes again, the page updates.

## Settings

**Settings**, in the menu under your name, holds your profile as the platform knows it and your preferences: **Language** (English or French, saved on your account so it follows you across devices), **Appearance** (**Light**, **Dark** or **System**) and the date format.

<figure markdown="span">
  ![The settings of a student: profile with name, e-mail and last sign-in, then Language, Appearance and Date format](../assets/screenshots/student-settings-light.png#only-light)
  ![The settings of a student: profile with name, e-mail and last sign-in, then Language, Appearance and Date format](../assets/screenshots/student-settings-dark.png#only-dark)
  <figcaption>The settings: language, appearance and date format.</figcaption>
</figure>

The theme can also be flipped from the player's header during an evaluation, and `Ctrl+K` opens a command palette from any page.

!!! tip "Before an exam"
    - Charge the laptop, or bring the charger: a dead battery is not a reason to reopen an attempt.
    - Sign in the day before and check that the classroom shows on your home, with the right e-mail address.
    - Open the evaluation from your home as soon as the waiting room is announced, so the ring counts you present.
    - On a code question, press **Run** once early: the first run loads the language runtime.
    - Keep to one tab. A second tab shows the same attempt and does not give you a second one.
    - Watch the countdown, not your watch: the clock is the server's, and nothing is accepted more than three seconds after it reaches zero.
