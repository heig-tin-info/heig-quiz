# New project

## What this screen is

It creates a project as a **draft**: students see nothing until you publish
it from its page. Quiz builds a private distribution repository in the
classroom's organization, from the source repository you choose.

## The basics

A **Name**, a **Source repository** of the classroom's organization and a
**Deadline**. The source, the branches and the history are fixed once the
project is created; to change them, delete the draft and start again.

## Advanced options

- **Branches**: the first one chosen is the students' default branch.
- **History**: **One commit** per branch, or the **Whole history**.
- **Publication**: by hand, or at the start date.
- **At the deadline**: **Lock** refuses every push; **Mark** leaves the
  repository open and adds a marker commit.
- **Grace**: minutes after the deadline before the work is frozen.
- **Score**: **Automatic**, or **None** for no score and no review.
- **Grade scale**: linear, or the score is the grade (out of 6).
- **Protected files**: restored by Quiz if a student touches them.
  Unprotecting `grading.yml` lets a student alter the grading.
- **Groups**: one repository per group of a group set.
