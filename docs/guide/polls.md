# Live polls

A poll is one question, thrown on the wall in the middle of a lecture, answered by whoever is in the room. There is no roster, no schedule and no grade: the people present scan a code with their phones, the answers stack up live on the beamer, and you reveal the correct answer when you decide to. Half the room may not even have an account on the platform.

A poll runs a multiple-choice question or a short-answer question, and nothing else. It is created and started in one move, so there is nothing to prepare beforehand beyond the question itself.

## Starting a poll

Click **Poll** in the sidebar, or open the command palette with `Ctrl+K` and choose **Start a poll**. The launcher opens on a page of its own, so you can reach it from wherever you happen to be.

<figure markdown="span">
  ![The poll launcher, on its Pick a question tab, with no question written yet](../assets/screenshots/poll-launcher-light.png#only-light)
  ![The poll launcher, on its Pick a question tab, with no question written yet](../assets/screenshots/poll-launcher-dark.png#only-dark)
  <figcaption>The launcher: pick a question you already wrote, or ask a new one, choose the classroom, and start.</figcaption>
</figure>

The launcher has two tabs, because there are exactly two ways to have a question.

**Pick a question** lists the multiple-choice and short-answer questions of your personal poll pool, the most recently used first: a question you just published but never polled sits at the top too. Each row shows the internal name, the first line of the statement and how many times it was polled. The search box filters by name or statement. Select a row, and the primary action becomes **Start the poll**.

**Ask a new question** takes a type and an internal name, and **Create question** opens the question editor on it. This is a deliberate detour and not a hidden mode: the editor is the same one as everywhere else, you publish the question there, and the launcher is one click away afterwards with the new question waiting at the top of its list. See `question-types.md` for what a multiple-choice or a short-answer question can hold.

Two settings sit above the list on the first tab:

- **Classroom**: where the poll and its answers are kept. A poll appears afterwards in that classroom's evaluation list like any other evaluation, which is how you find the poll you ran last Tuesday. The launcher remembers your last choice.
- **Anyone with the code answers**: on, the poll is anonymous. No account is needed to answer, and no name is ever shown. Off, participants must sign in, and each answer is counted under the student's name.

Press **Start the poll**. The poll is running from that instant and the projection opens.

## The projection

The projection is the one screen of the product that is not a page: no sidebar, no header, dark by default because a beamer throws light. Put this window on the beamer and press the full-screen button at the top right, or the `F` key.

<figure markdown="span">
  ![The projection of a running poll: the question in large type, one bar per choice with votes and percentages, the join code and its QR code](../assets/screenshots/poll-projection-light.png#only-light)
  ![The projection of a running poll: the question in large type, one bar per choice with votes and percentages, the join code and its QR code](../assets/screenshots/poll-projection-dark.png#only-dark)
  <figcaption>The projection while the poll runs; at this window height the last choice is partly cut off by the footer, and it scrolls into view.</figcaption>
</figure>

From top to bottom: the course and classroom with a **Live** pulse, the statement in large type, then one line per choice with a bar, the vote count and the percentage. For a short-answer question the distinct answers are listed instead, the most frequent first, folded so that spelling and capitalisation do not split a count. The tally updates by itself as answers arrive.

The footer carries the ring of answers received out of people present, the join address, the six-character session code and its QR code. A crossed eye reminds the room that no name is shown.

The controls at the top right are the segmented **Live** / **Answer revealed** switch, the theme toggle, **Full screen** and a menu holding **End poll** and **Back to the classroom**. Nothing else happens on this screen.

!!! note
    The distribution is sent only to you. A phone in the room never sees how the votes are spread before you reveal the answer, so the majority does not drag the undecided along.

## How the room joins

Participants scan the QR code, or type the code into the address `/p/CODE` of the platform, the same address printed next to the code. The code alphabet has no `I`, `O`, `0` or `1`, so it can be read from the back of the room and typed on a phone without doubt.

<figure markdown="span">
  ![A phone showing the poll: the statement, the four choices and a Send button](../assets/screenshots/join-mcq-phone-light.png#only-light){ width="390" }
  ![A phone showing the poll: the statement, the four choices and a Send button](../assets/screenshots/join-mcq-phone-dark.png#only-dark){ width="390" }
  <figcaption>A guest phone on the poll: pick a choice and press Send.</figcaption>
</figure>

For an anonymous poll there is no sign-in and nothing to accept: the phone shows the question, the participant picks an answer and presses **Send**. The page says **Answering anonymously.** underneath. Each browser holds one vote in one poll, kept by a cookie that carries no identity; an answer can be changed with **Update** as long as the poll runs.

A participant who is signed in on the platform is counted as themselves, and the page says **Answering as** with their first name. When the poll is not anonymous, a phone without a session is sent to **Log in to answer** and comes back to the poll afterwards.

## Revealing the answer

Switch the control at the top right to **Answer revealed**, or press `R`. On the wall, the correct choice turns green with a **Correct answer** tick and the other bars fade; no row ever turns red, because nobody in the room is being marked wrong.

<figure markdown="span">
  ![The projection after the reveal: the first choice marked Correct answer in green, the other bars faded](../assets/screenshots/poll-revealed-light.png#only-light)
  ![The projection after the reveal: the first choice marked Correct answer in green, the other bars faded](../assets/screenshots/poll-revealed-dark.png#only-dark)
  <figcaption>The reveal on the wall; as above, the fourth choice sits just below the visible area at this window height.</figcaption>
</figure>

The phones follow within a few seconds. The answer field goes away, the choices are listed with the correct one marked, and a participant who answered sees whether their own answer was right. For a short-answer question the phone shows the accepted answers and whether the participant's text was among them.

<figure markdown="span">
  ![The phone after the reveal: the correct choice highlighted in green, the others greyed out](../assets/screenshots/join-revealed-phone-light.png#only-light){ width="390" }
  ![The phone after the reveal: the correct choice highlighted in green, the others greyed out](../assets/screenshots/join-revealed-phone-dark.png#only-dark){ width="390" }
  <figcaption>The same poll on a guest phone once the answer is revealed.</figcaption>
</figure>

Revealing is reversible: switch back to **Live** and the key is hidden again, on the wall and on the phones. You can reveal before or after ending the poll.

## Ending the poll

**End poll**, in the menu at the top right, asks for confirmation and stops the poll: no further answer is accepted, and a phone whose answer arrives too late is told so. The header reads **Poll ended** and the primary action becomes **Run again**, which starts a fresh poll on the same question in the same classroom, with an empty tally and a new code.

<figure markdown="span">
  ![The projection after the end: Poll ended in the header, the whole tally with the correct answer marked, and Run again as the primary action](../assets/screenshots/poll-ended-light.png#only-light)
  ![The projection after the end: Poll ended in the header, the whole tally with the correct answer marked, and Run again as the primary action](../assets/screenshots/poll-ended-dark.png#only-dark)
  <figcaption>The poll ended: the code and the QR leave the screen, the tally stays, and Run again is offered.</figcaption>
</figure>

The code keeps working for two hours after the end. A phone that reloads the page still gets the question and the revealed answer, so the room keeps the result in hand while you comment on it. After two hours the code is free again.

!!! warning
    A poll never puts a grade in the students' results. Ending it closes it and nothing more: the answers are not released, no card appears on a student's home, and nothing about a guest reaches any grade table. The result of a poll is the tally on the beamer.

## Where the question lives afterwards

The first poll question you create goes into a personal pool named **Polls**, created for you at that moment. It is an ordinary pool from then on: it shows on your pools page, you can rename it, share it and add questions to it like any other. See `classrooms.md` for how pools are linked to courses.

The poll itself stays in the classroom's evaluation list with the mode **Poll**, so you can open its projection again later to show the tally, and a signed-in student who answered can find it among their past evaluations. Since a poll is one question, the grading and results screens described in `grading.md` have little to say about it.

!!! tip "Troubleshooting"
    **The phone says "No poll with this code".** Either the poll ended more than two hours ago, or the code was mistyped: remember that the alphabet has no `I`, `O`, `0` or `1`. Scanning the QR code again avoids the typing.

    **The QR code points at the wrong address on a LAN.** The QR encodes the platform's `WEB_URL` setting followed by `/p/CODE`; on a development machine it has to name an address the phones can reach, as explained in `../development/index.md`.

    **Nobody can join a poll that is not anonymous.** Participants need an account and a sign-in; for a mixed room, start the poll with **Anyone with the code answers** switched on.
