# Project

## What this screen is

One project: a private GitHub repository per student, or per group, copied
from a source repository of yours. The repository's own CI computes the
score; Quiz keeps the deadline, the protected files, the scores and the
release. The one primary action follows the state: **Publish** for a draft,
**Sync** when the source is ahead, **Release scores** once everything is
final.

## The table

One row per student or group: the repository, the invitation state, the
last commit, the CI status, the scores and the flags (locked, after the
deadline, to verify, deleted on GitHub, access to revoke). A row opens a
sheet with the runs, **Resend** for the invitation, the repository's own
deadline, **Lock now** and the teacher's score.

## Scores

**Current** is the latest run received before the deadline. At the deadline
it becomes the **frozen** score, definitive after the grace. The LLM
**final review** is asked once per repository when its freeze is definitive.
The **final** score is the teacher's, else the review's, else the frozen
one. Students see a score as *indicative* until you **Release scores**. A
score marked *to verify* rests on a run whose protected files were
restored: it blocks the release until you set the teacher's score.

## Deadline

The deadline is applied on the server's clock; the time that counts for a
push is when Quiz received it. Give one repository its own deadline from its
sheet instead of extra time. Moving the deadline later after it passed
reopens the project, after a confirmation.

## Protected files

A push that touches one is covered by a restore commit of Quiz; the
student's work is never rewritten. Past five restores in an hour the
repository is flagged *protected files in conflict* and you re-enable the
protection by hand.

## Sync and the end of the project

When the source has new commits, **Sync** opens one pull request per
handed-out branch in each open repository; the student merges it, Quiz
never does. **Archive** hides the project. **Delete project** removes its
rows in Quiz and never a repository on GitHub.
