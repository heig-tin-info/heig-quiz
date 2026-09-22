# Courses and classrooms

A course is the lasting unit you teach; a classroom is one group following it for one period. This chapter creates both, fills the roster, and explains what students see on their side.

## Creating a course

On **Courses**, click **New course**. A course has a **Name**, for example "Programmation C", and a short **Code**, for example `PRG1`; the code is shown beside every classroom of the course in the sidebar. **Create course** adds the card.

A course card holds three things:

- its **classrooms**, listed with their period and their headcount;
- its **Staff**, the colleagues who share it;
- the **Pools of this course**, the pools its evaluations may draw from.

A course outlives a class. The same "Programmation C" carries the classroom of 2026, then the one of 2027, and its staff and pools stay in place from one year to the next.

### Adding a colleague to the staff

Open the card's menu (the three dots) and choose **Add a staff member**. The field asks for the **E-mail of an existing account**: the colleague must have signed in once, otherwise the form answers "No account has signed in with this address yet." Every member of the staff has the same rights on the course and its classrooms; there is no owner. The same menu carries **Remove from the staff** for each member.

Being on the staff of a course is enough to be a teacher: a colleague you add does not need a grant from the administrator.

### Linking a pool

The evaluations of a course draw their questions from the pools linked to it, and only from those. **Link a pool** on the card offers your pools; a linked pool appears with its question count. From the pool's own menu, **Unlink from this course** removes the link and nothing else: the pool and its questions stay where they are, and the evaluations that already use its questions keep them. One pool can feed several courses. See [Question pools](pools.md) for the pools themselves.

## Creating a classroom

On the course card, click **New classroom**. A classroom has a **Name**, such as `PRG1-2026`, and an optional **Period**, such as `2026-A`. It appears in the card and in the **Classrooms** section of the sidebar.

### The classroom screen

The eyebrow above the title names the course and goes back to it. Under the title, two tabs, and the primary action of the page changes with the tab: **Add students** on the roster, **New evaluation** on the evaluations.

<figure markdown="span">
  ![A classroom, on its evaluations tab](../assets/screenshots/classroom-evaluations-light.png#only-light)
  ![A classroom, on its evaluations tab](../assets/screenshots/classroom-evaluations-dark.png#only-dark)
  <figcaption>The Evaluations tab: one row per evaluation, with its state, its mode, its questions, its points and its attempts.</figcaption>
</figure>

**Evaluations** lists the evaluations you run with this group, each with its state: draft, scheduled, waiting room (shown as *lobby*), running, paused, closed, grading, released. The row's menu leads to what the state allows: the setup, the live dashboard, the grading panel or the results. The chapters [Evaluations](evaluations.md), [Running an evaluation](live.md) and [Grading and results](grading.md) take it from there.

<figure markdown="span">
  ![The same classroom, on its roster tab](../assets/screenshots/classroom-roster-light.png#only-light)
  ![The same classroom, on its roster tab](../assets/screenshots/classroom-roster-dark.png#only-dark)
  <figcaption>The Roster tab: one row per seat, with its status, its extra time and the last sign-in.</figcaption>
</figure>

**Roster** is the class list: **Last name**, **First name**, **E-mail**, **Status**, **Extra time** and **Last sign-in**. The count on the tab is the headcount. Click a column header to sort.

## Importing the roster

On the **Roster** tab, click **Add students**. The drawer offers three ways in, and you can mix them:

- **From a file**: drop an Excel or CSV export (`.xlsx`, `.xls`, `.ods`, `.csv`) or click to browse.
- **One student**: a last name, a first name, an e-mail and an optional extra time, then **Add**.
- **Pasted CSV**: paste lines with a header, then **Import CSV**.

<figure markdown="span">
  ![The Add students drawer](../assets/screenshots/roster-import-light.png#only-light)
  ![The Add students drawer](../assets/screenshots/roster-import-dark.png#only-dark)
  <figcaption>Add students: a file, one student at a time, or a pasted CSV.</figcaption>
</figure>

The columns are detected permissively. Last name, first name, e-mail and extra time are recognised whatever the case and the accents, under French or English headers; the header does not have to be on the first line, and extra columns are ignored. The only required column is the e-mail: it is what a student is matched on. Export the list straight from the school's tools and drop it as it is.

The extra-time column is optional. It is recognised under names like `bonus`, `temps supplémentaire` or `extra time`, and accepts `25`, `25 %` or `0.25`.

The import is atomic: a single bad line rejects the whole file, the drawer lists each rejected line with its reason, and nothing is written. Fix the file and drop it again.

Re-importing is safe. Existing seats keep their claim, names are refreshed, nothing is deleted implicitly, and a sheet without an extra-time column never clears an accommodation you set by hand. Import the new export of the class list whenever it changes; only the newcomers are added.

## How students claim their seat

There is no invitation code. A seat is **pending** until a student signs in with an address that matches it; at that moment it becomes **claimed** and the classroom appears on their home. Matching runs against every address the identity provider reveals for the account, not only the one they typed, so a student registered under a private address at edu-ID still claims a seat listed with the school address. The classroom's card on their side names the course, the period, the staff and their extra time, if any: see [For students](students.md).

When the matching is ambiguous, because the same student sits on two seats or an address belongs to two accounts, the seat is flagged **conflict** and nothing is attached on a guess. A toast tells you as it happens; edit or remove one of the rows to resolve it.

## Editing a row

The menu at the end of a row offers **Edit**, **Revoke claim** and **Remove from roster**.

**Edit** opens the name, the address and the extra time in place. Changing the address revokes the claim: the seat goes back to pending, and the holder of the new address claims it at their next sign-in. The form warns you before you save.

**Extra time** is a percentage of the nominal duration of every timed evaluation of this classroom, applied automatically when the attempt starts. A student at `+25%` on a 45-minute exam gets 56 minutes. On an exercise with a common deadline, the extension is the same percentage of the announced window, and that student's attempt closes that much later than the class. It comes from the import file when the sheet carries the column, and can be edited row by row.

**Revoke claim** puts a seat back to pending without touching the name or the address. **Remove from roster** takes the student off the list; their past attempts and results are kept.

## Join as student

The classroom's menu, the three dots beside the title, carries **Join as student**. It gives you a seat in your own classroom, flagged *staff*, which stays out of the headcount and the results. With it, **Switch to student view** in the account menu shows you this classroom the way a student gets it, and you can take an evaluation from start to finish as one. It is the right way to check an evaluation before opening it to the class.

## Archive, rename, delete

The same menu holds the rest of the classroom's life.

- **Rename** changes the name and the period, nothing else.
- **Archive** puts a finished classroom aside without deleting anything: it leaves the sidebar and the course card, and its roster, evaluations and results stay readable on its own page, marked *archived*. **Restore**, in the same menu, brings it back. Today no list shows the archived classrooms, so keep the page's address (or a bookmark) if you expect to come back to one.
- **Delete classroom** is the other thing entirely. The roster, the evaluations, the attempts, the answers and their gradings go, after a confirmation that names the classroom. The questions of the pools are never touched.

!!! warning
    Archive when the semester is over; delete only a classroom created by mistake. Deletion cannot be undone, and the students lose the results they had been shown.

### Deleting a course

**Delete course**, in the course card's menu, takes the course and everything under it: its classrooms, their rosters and their results, after a confirmation that names the course. Its pools are not deleted, since they belong to you and not to the course; they are simply no longer linked.

## Common questions

**A student does not see the classroom.** Their seat is still pending: the address they signed in with, or the addresses known to edu-ID for their account, do not match the one in the roster. Compare the two, correct the row, and ask them to sign in again.

**The same student appears twice.** Two seats for one person are flagged **conflict** and neither is claimed. Remove the duplicate; the remaining seat is claimed at the next sign-in.

**I changed an address and the student lost the classroom.** Changing the address revokes the claim on purpose, so that a seat never stays attached to the wrong account. The student claims it again at their next sign-in with the new address.

**A colleague cannot open my classroom.** Access follows the staff of the course, not the classroom. Add them with **Add a staff member** on the course card.
