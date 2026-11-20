# Projects

A project hands each student, or each group, a private GitHub repository copied from a source repository of yours. The repository's own CI computes the score; Quiz keeps the deadline, the protected files, the scores and the release. A project is an activity of the classroom, beside its evaluations. It needs the classroom [connected to GitHub](github.md).

!!! note "Coming from heig-classroom"
    A project is heig-classroom's *assignment*. What changes: the groups come from classroom-wide [group sets](groups.md); a push that touches a protected file is answered by a restore commit instead of being rewritten; the source is synchronised through pull requests; and scores become grades only when you **release** them. Roster extra time never applies to a project's deadline: give one repository its own deadline instead.

## Create a project

On the classroom page, **New** then **Project**. On a classroom that is not connected, the same entry leads to the connection first.

<figure markdown="span">
  ![The new project form with the advanced options open](../assets/screenshots/mock-project-new-advanced-light.png#only-light)
  ![The new project form with the advanced options open](../assets/screenshots/mock-project-new-advanced-dark.png#only-dark)
  <figcaption>The form: a name, a source repository and a deadline, with the advanced options below. (Mock data.)</figcaption>
</figure>

The form asks for a **Name**, a **Source repository** (only a repository of the classroom's organization) and a **Deadline**. When the source holds a `criteria.yml`, the form previews its criteria as the students receive it (section, criterion, points, graded by: automatic, AI or teacher), or the errors of a file that does not parse, and **Grading by criteria** is on: you confirm it by creating. The file must follow schema 3; a schema-2 file, or one that does not parse, is refused at creation with its errors. The **advanced options** have working defaults:

- **Branches**: the branches handed out; the first one chosen is the default branch of the students' repositories.
- **History**: **One commit** (default) gives each branch as one commit holding the source's files, without what is reserved for the staff (a `student/` overlay and a `.studentignore` shape what students get); **Whole history** keeps the source's history as it is.
- **Opening**: **Now**, or **At a date**, the start of a project you will schedule.
- **Deadline as**: a date, or a duration counted from publication.
- **At the deadline**: **Lock** (default) refuses every push after the deadline; **Mark** leaves the repository open, to git and to the online workspace alike (an exam in Safe Exam Browser still closes at the deadline), and pushes one empty commit per handed-out branch as a marker.
- **Grace**: minutes after the deadline during which a run started in time may still finish (30 by default).
- **Score**: **Automatic**, **None** (no score is shown and no review is dispatched), or **By criteria** when the source holds a `criteria.yml`.
- The grade of a score is linear: 1 + 5 × points / maximum, capped at 6, rounded to a tenth.
- **Protected files** and **Groups** (see below and [Groups](groups.md)).

**Create** builds a private *distribution repository* in the organization, which only Quiz's App manages. The project is born a **draft**: students see nothing. The source, the branches and the history are fixed at creation; to change them, delete the draft and create it again.

## Protected files

These are the files a student must not change, ticked in the tree the students receive (a file reserved by `.studentignore` is not in it). A ticked directory protects its content: its files are restored, while a file a student adds under it stays. `criteria.yml`, `README.md` and `.github/workflows/grading.yml` are pre-checked when the source has them. Leaving `grading.yml` unprotected warns that students could then alter the grading. In grading by criteria, `.github/workflows/` and `criteria.yml` are always protected: ticked and held, at creation and in the settings.

When a push by anyone but Quiz (a student, or a workflow's own commit) touches a protected file on a handed-out branch, Quiz answers with a **restore commit** that puts the distribution repository's current version back. The student's work is never rewritten, only covered, and they are told which files were restored. Beyond five restores in an hour on one repository, Quiz stops restoring and flags the repository **protected files in conflict**; scores captured meanwhile are marked **to verify**. You re-enable the protection by hand from the repository's page (its ⋯ menu). A new list applies to the next pushes only.

## Configure a draft

A draft's page is a form, written as you go: there is no Save. **Work handed out** recalls the source, the branches and the history, which are fixed. **Publication and deadline** holds the three things most projects need: the opening, now or at a date, and the deadline, either a date or a number of days counted from the publication. The opening names the header's button: **Publish** for now, **Schedule** for a date to come. The start and the deadline are saved together once both are filled, and a refusal is said under the field it concerns. **Groups** turns on group work and chooses the group set. A graded project then shows a **Gradebook** row: whether it counts in the classroom's mean, in which component when the course has some, and its weight, set with **Edit** before anyone sees the project; the published project keeps the same row in its **Settings** tab. Everything else (grace, what happens at the deadline, grading, protected files, where students work) is folded under **Advanced options**, and the lifecycle rail below lets you set the review checkpoints before publishing; before a manual publication it shows no date, since none is set yet. Once published, the page becomes the dashboard described below.

<figure markdown="span">
  ![A draft's page: work handed out, publication and deadline, groups, advanced options and the lifecycle rail](../assets/screenshots/mock-project-draft-light.png#only-light)
  ![A draft's page: work handed out, publication and deadline, groups, advanced options and the lifecycle rail](../assets/screenshots/mock-project-draft-dark.png#only-dark)
  <figcaption>A draft: a form, written as you go. (Mock data.)</figcaption>
</figure>

## Publish

On the project page, **Publish** is the primary action of a draft that opens now: it starts the project at once. A draft whose start lies ahead offers **Schedule** instead: the project is announced to the class, listed under "Coming up" with its start, and Quiz publishes it at that start; nobody can accept it before. A scheduled project keeps its form, so its dates and settings can still change (its start must stay ahead). It has no primary action: **Publish now** opens it at once, and **Cancel schedule** takes it back to a draft, which the students no longer see. A draft never publishes by itself. A project cannot be published or scheduled while a claimed student of a group project is in no group; a student who lands in no group after scheduling meets the refusal when accepting, until placed.

<figure markdown="span">
  ![A scheduled project: its form kept, Cancel schedule and Publish now beside the title](../assets/screenshots/mock-project-scheduled-light.png#only-light)
  ![A scheduled project: its form kept, Cancel schedule and Publish now beside the title](../assets/screenshots/mock-project-scheduled-dark.png#only-dark)
  <figcaption>A scheduled project. (Mock data.)</figcaption>
</figure>

Once published, only these change: the name, the deadline (never to a past date), what happens at the deadline (until it passes) and the protected files. The deadline is edited in its tile; the strategy and the protected files are in the folded **Settings** at the bottom of the page. Students then **accept** the project, and each gets a repository `<project>-<login>` with push access.

<figure markdown="span">
  ![The Settings tab: what happens at the deadline, the protected files picked in the tree, where students work](../assets/screenshots/mock-project-settings-light.png#only-light)
  ![The Settings tab: what happens at the deadline, the protected files picked in the tree, where students work](../assets/screenshots/mock-project-settings-dark.png#only-dark)
  <figcaption>A published project's settings. (Mock data.)</figcaption>
</figure>

## The project page

Once published, the page is a dashboard. Four tiles sit under the header: **Accepted** (a ring and "26 / 30"), **Deadline** (the date, how long is left, the strategy, the grace, how many repositories are frozen, and the field to move it), **Progress** (how many students pushed, with the figures to look at: no commit, CI failing, to verify, alerts) and **Source** (the repositories, the history, the sync). A figure in a tile is a button: it narrows the table below to the repositories it counts, and **Show all** brings the others back. Under the tiles, the lifecycle rail shows the review checkpoints between the publication and the deadline, then the freeze and the release.

The table has one row per student (or group): the repository, the last commit with its count (**0 commits** is amber, and red once the deadline has passed with nothing received), the CI status, the score, and flags such as *locked*, *to verify*, *deleted on GitHub* or *access to revoke*. A repository with its own deadline says so in its State cell. A row opens the repository's own page (below). The page refreshes by itself and never waits for GitHub: the live state is cached and shown as stale when GitHub is slow.

<figure markdown="span">
  ![The project page: four tiles, the lifecycle rail and one row per student](../assets/screenshots/mock-project-light.png#only-light)
  ![The project page: four tiles, the lifecycle rail and one row per student](../assets/screenshots/mock-project-dark.png#only-dark)
  <figcaption>A published project: tiles, lifecycle rail and repositories. (Mock data.)</figcaption>
</figure>

### A repository's page

Every row opens its repository's page, a student who has not accepted yet included (the page then lists who is expected, nothing more). At the top, the repository, its deadline and its state, the arrows to the previous and next row of the table (the filter in force kept; your own test repository is skipped), and one main button once the repository is frozen for good: **Grade**, which opens the grading screen on it, for a project graded by criteria, or the teacher's score for one graded by its CI. During the project there is none. The figures follow: the commits, the last commit, the CI and, for a graded project, the score.

The **Members** table gives each member their access (a tag while they are not in the repository on GitHub; **Resend**, above the table, invites again everyone whose invitation waits or expired), the commits they authored and their share of the repository's, the commits nobody on the team authored on a last row. **Activity** draws those commits week by week, one row per member. **Runs** lists the CI's runs with their slot. On the right, the repository's own deadline and **Lock now**, its scores slot by slot, where its final score sits in the class, and its sync and group set. *(ADR-137.)*

<figure markdown="span">
  ![A group's repository page during the project](../assets/screenshots/mock-project-repo-light.png#only-light)
  ![A group's repository page during the project](../assets/screenshots/mock-project-repo-dark.png#only-dark)
  <figcaption>A group's repository during the project: members, weekly commits, runs, deadline. (Mock data.)</figcaption>
</figure>

The single primary action follows the state: **Publish** or **Schedule** for a draft, none for a scheduled project, **Sync** when the source is ahead, **Grade** for a project graded by criteria while a repository is still to validate, **Release scores** once everything is final.

A project graded by criteria has a **grading screen** (**Grade**, or **Grading screen** above the repositories): one repository at a time, each criterion with its proposed points, their source (CI, AI, teacher) and the rationale. Correct the points in place, give the teacher-only criteria theirs (0 included), then **Validate** and go on to the next; *Validate the rest as proposed* is in the menu. The release waits until every repository is validated.

**Regrade**, in the same menu, grades one repository or all of them again. The CI's and the AI's new results replace their rows, validated ones included, and wait for your validation; the teaching team's points and the rows a checkpoint locked stay. A run or an AI review that fails, or a criterion the run does not answer, replaces nothing, a proposal included: the line under the evidence names the criteria that kept their earlier row, and why. A Regrade started before a release replaces nothing once the project is released. The same line says how many files the distribution's version replaced in the graded commit; click it for their paths. After the release, Regrade asks for a confirmation: students keep their released grade until you release again (with no new notification), their criteria show the new points as indicative meanwhile, and the release waits until every repository is validated again.

<figure markdown="span">
  ![The grading screen: one repository, its criteria, their points, sources and states](../assets/screenshots/mock-project-grading-light.png#only-light)
  ![The grading screen: one repository, its criteria, their points, sources and states](../assets/screenshots/mock-project-grading-dark.png#only-dark)
  <figcaption>Grading a project by criteria. (Mock data.)</figcaption>
</figure>

## Test a project as a student

To test a project before your students do, open the classroom and press **Join as student**: you hold a staff seat, kept out of every count. Switch to the student view, link a GitHub account that is **not** a member or owner of the organization (a test with an organization owner's GitHub account does not reproduce the rulesets and the protected files: an owner's admin rights bypass them; a Quiz account holds one GitHub link, so linking a test account replaces your own), then **Accept** and push. Your test repository is badged on the project page and counts nowhere: not in the counts, the release, the gradebook or the CSV. Group projects cannot be tested this way, staff seats are not placed in groups. *(ADR-077.)*

## The deadline

At the deadline, on the server's clock, Quiz applies the strategy within a minute, for every repository. The time that counts for a push is the time Quiz **received** it, never the commit's date.

- **A repository's own deadline.** On a repository's page, give it an individual deadline (a date ahead of now), or **Follow the project's** again. That effective deadline is what every rule reads for the repository. It replaces extra time for projects.
- **Lock now** and **Unlock** act on a single repository by hand.
- **Close project** (header, the course's owner) ends a published project now: the deadline becomes now for every student, own deadlines included, then applies as usual, grace included.
- **Moving the deadline later** after it passed **reopens** the project: locks lifted, freeze and final review undone, runs requalified. Teacher scores and a release already made are kept. Quiz asks you to confirm.

On a plan without rulesets, the lock archives the repository instead; the row shows *locked by archiving*.

## Scores

Each repository's `.github/workflows/grading.yml` reports its score as one annotation `::notice title=GRADE::<points>/<max>`; Quiz reads it from the run. A score is points out of a maximum, never a grade, until the project is released.

| Slot | What it is |
| --- | --- |
| **Current** | The latest counted run received before the deadline. Marked *indicative* for the student. |
| **Frozen** | The current score at the deadline, provisional, then definitive after the grace. |
| **Review** | The LLM **final review**, dispatched once per repository when its freeze is definitive; its score fills this slot when the run succeeds. Review **checkpoints** (a name and a date, absolute or `D−n`) dispatch earlier reviews that never count. |
| **Teacher's score** | Set by hand from the repository's page, with a comment, once the repository is frozen for good. |
| **Final** | The teacher's score, else the review's, else the frozen score. |

Only runs on a handed-out branch count, on a head commit that no bot pushed. A run with several `GRADE` annotations has no score and alerts you, because a student's code could print one. A repository without `grading.yml` gets a pass/fail CI status instead.

A score resting on a run **to verify** (protected files in conflict) blocks the release: set the teacher's score to settle it.

### Adjust a grade

After a talk with a student, or an explanation given afterwards, you can move the grade itself without touching the criteria or the points. On the **Grading** tab of a project graded by criteria, click the grade at the end of a row: choose **Relative** (a change such as +0.3, in tenths, at most ±5) or **Absolute** (the grade itself, 1.0 to 6.0), and write the justification, which is required. The dialog shows the grade before and after, and names every member of a group. The adjustment applies to the grade of the points, live: a relative change follows a regrade, while an absolute grade stays put and, when the grade of the points moves, the row says *base grade moved*; adjust again to keep it, or remove it. An adjusted grade wears a small mark; its justification is in its bubble and on the repository's page. Students read the justification under the teacher's comment once you release, never the change itself (though the points and the scale let one work it out). A teacher's mark in the gradebook still wins over it. Once the project is released, only the person who runs the course (its owner, not an assistant) can adjust a grade or change the teacher's score. *(ADR-135.)*

## Release

**Release scores** makes the final scores the students' and the gradebook's, converted to grades by the project's scale, then adjusted. It needs every live repository frozen for good, and tells you what is missing otherwise. Before the release a student's score is indicative. A grade, or an adjustment's justification, changed after the release shows *changed after release*, and **Release again** updates the grades.

<figure markdown="span">
  ![The release confirmation](../assets/screenshots/mock-project-release-light.png#only-light)
  ![The release confirmation](../assets/screenshots/mock-project-release-dark.png#only-dark)
  <figcaption>Releasing the scores. (Mock data.)</figcaption>
</figure>

### Contestations

On a project graded by criteria, once you release the scores, a student may contest the grading of one criterion of their repository, once, with a reason in plain text, as on an exam (see [Contestations](grading.md#contestations)). On a group repository the contestation is the group's: any member files it, every member reads it and its answer, and nobody is told who filed it.

**The window.** **Contestations**, in the project's **Settings** beside the grading mode (and in a draft's advanced options), sets how many days after the scores are first released a criterion may be contested: 7 by default, 0 for none, at most 60. It is locked once you release the scores: that release fixes the closing instant, and releasing again never moves it. From then on the **Grading** tab shows **Contestations open until** the date, or **Contestations closed**, above the matrix; the course's Teacher role can **Close now** or **Extend** (which reopens a closed window), or **Open a window** where none was set.

<figure markdown="span">
  ![The Grading tab on its Contested filter: 3 open contestations, the window's end, Extend and Close now, a mark on each contested cell](../assets/screenshots/mock-project-contest-matrix-light.png#only-light)
  ![The Grading tab on its Contested filter: 3 open contestations, the window's end, Extend and Close now, a mark on each contested cell](../assets/screenshots/mock-project-contest-matrix-dark.png#only-dark)
  <figcaption>The contested repositories, a mark on each contested criterion. (Mock data.)</figcaption>
</figure>

**Where they show.** The open count leads to the **Contested** filter of the matrix (`?filter=contested`), which keeps the repositories holding a contestation, open or answered. A contested cell carries a small bubble, amber while open; a repository's row carries its open count, and the gradebook flags the project's column. You are told in the bell (**Project contestation filed**), which opens that filter. Nothing is suspended: the grade stays released.

**Answering.** On the grading screen, the contested criterion is marked `contested`, the rail flags the repository, and the contestations are listed under the criteria: the criterion as it read and its points when contested, the reason and its date. Answering is the course's Teacher role's, once: **Refuse**, with a reply, or **Accept**, with or without one. Switch **Change the points** on to give the criterion new points and, if you wish, a new rationale in the same act; the reply is then mandatory. Those points are a teacher's row, still to validate: validate the repository, then **Release again** for the grade to move. The student reads the answer at once, the new points as indicative until then. A contestation on a criterion that left `criteria.yml` since can only be refused, and says so. An assistant reads the contestations and the sentence saying who answers.

<figure markdown="span">
  ![The grading screen: a contestation's reason, and the answer with new points and a reply](../assets/screenshots/mock-project-contest-answer-light.png#only-light)
  ![The grading screen: a contestation's reason, and the answer with new points and a reply](../assets/screenshots/mock-project-contest-answer-dark.png#only-dark)
  <figcaption>Answering a criterion's contestation with new points. (Mock data.)</figcaption>
</figure>

**After the release of the scores, the criteria are the owner's.** Once a project's scores are released, every criterion write is the course's Teacher role's: a criterion's points, **Validate**, *Validate the rest as proposed* and both Regrades, as well as the grade adjustment. An assistant sees the grading screen with these held, and the sentence saying why. *(ADR-139 §13.)*

## Keep the source up to date

When the source repository gets new commits, the page says it is ahead and offers **Sync**. Nothing reaches students until you click. Sync updates the distribution repository, then, for every unlocked repository, pushes the update to a `sync/<branch>` branch and opens **one pull request per handed-out branch** (or updates the one already open). The student merges it and resolves conflicts; Quiz never merges. Repositories already identical get none, and repositories past their deadline are skipped. A summary tells how many were opened, updated, up to date, failed or skipped.

**Sync** first opens a dialog listing what the sync would send, per handed-out branch: the files the distribution would add, modify and delete, through the same hand-out as the sync (a changed `.studentignore` included), the protected files marked. Everything that changed in the source since the last sync goes out, not only the fix you meant. In a project graded by criteria from its CI, a note says that the protected files and `criteria.yml` are graded in this version for everyone at the next correction, merged or not; another says that the other files arrive in a repository when the update is merged there, conflicts possible, and that grading reads the repository's version. With nothing to send, **Sync** stays disabled, unless the last sync failed somewhere: it then retries those repositories.

The dialog takes an optional **message to students** (500 characters at most, plain text), once the project is published or scheduled: a draft has none. Every student of the project reads it on their project page, under "Update from your teacher", their repository synced or skipped, and in the pull request (an open one gets a comment when the message changes); do not name the source repository in it. The field opens with the current message, so a sync to retry failed repositories keeps it; empty the field to clear it. You see it on the **Source** tile beside the last sync.

After a sync of a project graded by criteria from its CI, the Summary says how many frozen repositories were graded before the latest update, with a link to the grading screen: **Regrade every repository** there grades them with the distribution's current version.

## The online workspace

Where the platform has the online workspace, the project page has a **Workspace** section. **Where students work** is **Own tools** by default: students clone their repository and push from their machine. **Online** gives each student a workspace in the browser, set up with their repository; they open it with **Open workspace** on their project page, and only the workspace writes to their repository (they are invited on GitHub to read it). **Online, in Safe Exam Browser** keeps students away from their repository until grading: each student downloads a file from their project page that opens Safe Exam Browser on that page, without signing in again, and the workspace opens from there only. The workspace checks the Safe Exam Browser configuration of each student's file.

Only an owner of the course whose account the administrator enabled for the workspace (an administrator always is) can choose a mode other than **Own tools**, and a group project stays in the students' own tools. Once a student has opened a workspace, the mode no longer changes. The section says when the workspace last received the project, with **Resync** if it failed, and lists the workspaces open now. How many may run at once is the administrator's setting for the course's owner who created the project (or its oldest owner).

At each repository's deadline, in both online modes, the workspace is **collected**: when what a student saved differs from what would be handed in, Quiz commits the workspace as it stands to the repository (a commit of Quiz's App, signed, named as a collection) before the deadline applies, and that commit counts as on time. Files the student's `.gitignore` excludes are not collected; a file or folder the platform cannot read (one a student made private with `chmod`) keeps the version last handed in, and the row counts it. The repository's row says when it was collected, or why it was not; to collect it again, give that repository its own deadline. The student's project page says only that their workspace was collected at the deadline, and their commit count leaves out the platform's commit; the project page's figures count a collected repository as handed in, not as one without commits. *(ADR-130.)*

The workspace of a C or C++ project has `gcc`, `g++` (C++20 with GCC 14's standard library), `make`, `gdb`, `clangd` (set to `-std=c17` for C files and `-std=c++20` for C++ files) and `baygon` (for a `make test` that runs Baygon), and the gdb debugger of the *Native Debug* extension, the only one there: Microsoft's C/C++ extension cannot be installed. A template's `.vscode/launch.json` must therefore use `"type": "gdb"`, not `cppdbg`, and its build task `"type": "shell"`, not `cppbuild`; the configuration to copy is in the student image's README (`apps/codespace/images/c-dev/README.md`, *What a lab template should hold*); it is the same for C and C++, only the `Makefile` changes compiler. The program being debugged gets its own terminal, where students type its input.

### Open a student's repository in the workspace

Any member of the course's staff can open a student's (or a group's) repository in the online workspace, whatever the project's work mode, own tools included: **Open in workspace**, the laptop icon at the end of its row or the button of its page. You build, run and browse the code and its history there, read-only: nothing is ever pushed. It is offered as long as the repository exists on GitHub; on a project in Safe Exam Browser, only once that repository's deadline has passed. One repository at a time: opening another closes the previous one. It counts against the same owner's workspaces as the students' (at most two such sessions at once), and is not there when that owner's account is not enabled for the workspace. Every opening is recorded in the audit log; the student is not notified. *(ADR-129.)*

<figure markdown="span">
  ![A repository's page with Open in workspace, read-only](../assets/screenshots/mock-project-open-in-workspace-light.png#only-light)
  ![A repository's page with Open in workspace, read-only](../assets/screenshots/mock-project-open-in-workspace-dark.png#only-dark)
  <figcaption>Opening a student's repository in the workspace. (Mock data.)</figcaption>
</figure>

## Archive and delete

**Archive** takes a project out of the lists, reversibly. **Delete project** removes its rows in Quiz (repositories, runs, scores, groups) after a confirmation, and **never a repository on GitHub**: the students' repositories, the distribution repository and the source stay where they are.

## Notifications

You are told when a deadline was applied (with the number of repositories locked), when a student's repository could not be made, when a criterion of a project whose scores are released is contested (folded per project, off by e-mail by default), and when the organization or the App is lost. Students are told when a project is scheduled (with its start), when it is published, a day before the deadline, when an invitation awaits them, and when scores are released. On the project page, short notices summarise what changed between two refreshes: acceptances, pushes, scores captured.
