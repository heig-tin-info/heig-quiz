# Projects, groups and the journal

This page is for you if your teacher gives graded work in a **GitHub repository**: a lab, a mini-project, a semester project. If you used GitHub Classroom before, this is the same idea, inside the platform you already use for quizzes. The path is always the same: link your GitHub account once, accept the project, work and push, then read your score.

## Before you start

You need a GitHub account. If you do not have one, create it on [github.com](https://github.com) first. It does not have to use your school address.

A project appears under **Open now** or **Coming up** on your home and on your classroom's page, next to the quizzes. If you see none, your teacher has not published one yet, or your classroom is not connected to GitHub.

## 1. Link your GitHub account (once)

The first button of a project reads **Link GitHub**. Press it, sign in to GitHub if it asks, and allow the platform to read your account name. GitHub sends you back to the same page.

<figure markdown="span">
  ![A project to accept: the page says Link your GitHub account to accept it, and the one button is Link GitHub](../assets/screenshots/student-project-unlinked-light.png#only-light)
  ![A project to accept: the page says Link your GitHub account to accept it, and the one button is Link GitHub](../assets/screenshots/student-project-unlinked-dark.png#only-dark)
  <figcaption>Before your first project: the one button is Link GitHub.</figcaption>
</figure>

The platform reads the name of your account, once. It keeps no password and no token of yours. You do this once for all your projects. You can see the link, and remove it with **Unlink**, in **Settings**, under **GitHub**.

!!! note
    If you renamed or deleted your GitHub account since, the button says **Relink GitHub**: press it and link the account you use now.

## 2. Accept the project

Once the project has started and you are linked, the button reads **Accept**. Press it once and wait: the platform creates your **private** repository, with everything you need to start inside. It takes up to a minute, and the button says so. Do not press it again.

<figure markdown="span">
  ![A project ready to accept: My repository says it is created in a minute, and the one button is Accept](../assets/screenshots/student-project-accept-light.png#only-light)
  ![A project ready to accept: My repository says it is created in a minute, and the one button is Accept](../assets/screenshots/student-project-accept-dark.png#only-dark)
  <figcaption>Accept creates your own private repository.</figcaption>
</figure>

You can accept from the start date until the deadline. A project you did not accept before the deadline cannot be accepted afterwards: talk to your teacher.

If something goes wrong, the page tells you what to do: try again in a moment, or ask your teacher (for instance when the classroom is not fully set up). Nothing is lost.

!!! note "Teachers"
    A teacher with a staff seat (**Join as student**) can Accept too, to test a project: the repository is theirs, counts nowhere, and group projects are not covered. Link a GitHub account that is not a member of the organization: a test with an organization owner's account does not reproduce the rulesets and the protected files. *(ADR-077.)*

## 3. Open the invitation on GitHub

Your repository is yours, but GitHub wants you to accept its invitation once. The button becomes **Open the invitation**: it opens GitHub in a new tab, where you press **Accept invitation**. You also get a notification and an e-mail.

<figure markdown="span">
  ![The project page with the repository listed, Invitation pending on GitHub, Resend the invitation, and the button Open the invitation](../assets/screenshots/student-project-invited-light.png#only-light)
  ![The project page with the repository listed, Invitation pending on GitHub, Resend the invitation, and the button Open the invitation](../assets/screenshots/student-project-invited-dark.png#only-dark)
  <figcaption>The invitation waits for you on GitHub.</figcaption>
</figure>

No invitation in your inbox? Press **Resend the invitation** on the project page; you can do it once a minute. Once you have accepted, the page reads **Invitation accepted** and the button becomes **Open repository**.

## 4. Work and push

Clone your repository on your computer as you would any GitHub repository (`git clone`, with the address behind **Open repository**), then work, commit and push. The platform follows your pushes, and the page tells you when one has been received.

- Your repository starts from your teacher's files. Read its `README.md` first: it says what to do.
- Some files are **protected**, usually the grading workflow and the instructions. If a push changes one, the platform adds a commit that puts your teacher's version back. Your own work is never erased, but your change to the protected file does not count. Leave those files alone.
- Your teacher may send an update of the project while you work. It arrives in your repository as a **pull request** (its branch is named `sync/...`). Open it on GitHub, resolve the conflicts if there are any, and merge it. The platform never merges it for you.
- Push to the branches you were given. Work on another branch is not graded.

## 5. Read your score

Under **Score**, the page shows the score of the latest commit that was graded: points out of a maximum, with the run it comes from (**See the run on GitHub**). It is marked **indicative**. It moves with every push, and it is not your grade.

<figure markdown="span">
  ![The project page: the repository with its last commit and a passing badge, then the indicative score 34 / 40 and an indicative grade](../assets/screenshots/student-project-score-light.png#only-light)
  ![The project page: the repository with its last commit and a passing badge, then the indicative score 34 / 40 and an indicative grade](../assets/screenshots/student-project-score-dark.png#only-dark)
  <figcaption>The indicative score, from the latest graded commit.</figcaption>
</figure>

- **No score yet** means the automatic grading has not graded a commit of yours. Push, then wait a moment.
- Some projects are not graded: there is no score and no release.
- Your teacher may also review your work after the deadline. That review is not shown until the release.

## 6. The deadline

The deadline is the server's, like for an evaluation, and the page shows a countdown. If your teacher locked the project, your repository becomes **read-only** at the deadline: pushes are refused and the page reads **Read-only since the deadline**. Otherwise it stays open, but pushes made after the deadline do not count. Either way, what you pushed before the deadline counts, whatever the date written in your commit, and a grading run started in time may still finish a few minutes later. The score is then **frozen**, and the page shows **Evaluated commit**: the one that counts.

A day before, you get a reminder. Your teacher can give one repository more time; if that is you, you hear it from them.

## 7. The release

When your teacher publishes the scores, a **Result** block replaces the indicative score: your **final score**, your **grade**, and your teacher's comment if there is one. You get a notification.

<figure markdown="span">
  ![The project page after the release: Final score 18 / 20, Grade 5.5 and a comment from the teacher](../assets/screenshots/student-project-released-light.png#only-light)
  ![The project page after the release: Final score 18 / 20, Grade 5.5 and a comment from the teacher](../assets/screenshots/student-project-released-dark.png#only-dark)
  <figcaption>After the release: the final score, the grade and the comment.</figcaption>
</figure>

The final score can differ from the indicative one: your teacher may have adjusted it after reading your work.

## Notifications

You receive a notification, and an e-mail for the ones you must not miss, when:

- a project of your classroom is published (notification only; if you have not linked your GitHub account yet, it reminds you to link it before accepting);
- your repository is ready and its invitation waits for you;
- your deadline is within 24 hours;
- the scores are released.

Each one opens the project's page. You choose the channels (bell, e-mail, Teams) for each kind in **Settings**. Meanwhile, the page updates without a reload, and a short message tells you, for instance, that your push was received or that a new score is in.

## Forming a group

Some projects are done in groups. Your teacher either places you, or opens the groups to the students until a date. In the second case your Activities show a row **Form your group until …**, and your classroom page gets a **Groups** tab.

<figure markdown="span">
  ![The Groups tab: a set open until a date, groups with their members, the student's own group marked, and the students in no group](../assets/screenshots/student-groups-mine-light.png#only-light)
  ![The Groups tab: a set open until a date, groups with their members, the student's own group marked, and the students in no group](../assets/screenshots/student-groups-mine-dark.png#only-dark)
  <figcaption>The Groups tab: your own group is marked; the others can be joined while they are not full.</figcaption>
</figure>

In the **Groups** tab you can:

1. **Create a group**: you join it at once. The name is optional.
2. **Join** a group that is not full. Your teacher sets the size limit.
3. **Leave** your group, or **Rename** it.

While the set is open you see the names of the others and of the students who have no group yet, nothing more. When the date has passed, the groups close: you then see only your own group, and your teacher places whoever has no group. As soon as one group of the set gets its repository, the groups can no longer change, so be sure before you accept.

For a group project, **one member accepts** and the repository belongs to the group. Every member is invited on GitHub; a member who has not linked their GitHub account is invited only once they do. The score is the group's.

## The journal

If your teacher keeps a journal for the course, your classroom page has a **Journal** tab. It is the course's notebook: what was seen each week, exercises, links.

<figure markdown="span">
  ![The Journal tab: a strip of pages at the top, the home page of the journal and its table of contents on the right](../assets/screenshots/student-classroom-journal-light.png#only-light)
  ![The Journal tab: a strip of pages at the top, the home page of the journal and its table of contents on the right](../assets/screenshots/student-classroom-journal-dark.png#only-dark)
  <figcaption>The journal: the pages along the top, the table of contents beside the page.</figcaption>
</figure>

- The strip at the top lists the pages; a folder opens a menu of its pages.
- **On this page** jumps to a heading.
- There is nothing to do in the journal: it is for reading. A page your teacher planned for a later date does not show until then, and appears by itself.
- Links between pages stay in the journal. Links to the outside open in a new tab.
