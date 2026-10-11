# HEIG Quiz

An open-source learning management system built around assessment, for
courses in science, technology, engineering and mathematics (STEM).
Question pools with categories, concepts and published versions;
evaluations run live on a server-side clock, with a projector dashboard
and automatic grading, including code executed in a sandbox and circuits
graded by simulation; live polls answered from a phone through a QR code;
a classroom journal and spaced-repetition practice between the exams. Born
at HEIG-VD and open to every school whose teachers and students hold a
Switch edu-ID. One application server, one PostgreSQL, one repository,
operable by one person, with the code runner on a virtual machine of its
own.

<div class="grid cards" markdown>

-   :material-book-open-variant: **Guide**

    ---

    How to use the platform: courses and classrooms, question pools, the
    ten question types, evaluations from configuration to released
    results, live polls, and what a student sees.

    [:octicons-arrow-right-24: Start with the overview](guide/index.md)

-   :material-server: **Operations**

    ---

    Hosting the platform: deploying a release, installing a new server,
    the GitHub App, Microsoft Teams and the kiosk stations.

    [:octicons-arrow-right-24: Deployment](development/deployment.md)

</div>

## What it does, in one paragraph

A teacher keeps questions in **pools**, each question with a history of
published versions. An **evaluation** is built from published questions,
drawn from the pools linked to a course, and run in a **classroom** whose
**roster** was imported from a spreadsheet. The server keeps the clock: the
waiting room opens, the evaluation starts, every answer is saved as it is
typed, the teacher watches a live grid, extends or pauses, and closes. A
grading pass proposes a grade for every answer, the teacher validates or
adjusts, and releases the results: each student then reads their own
feedback. A **poll** is the short form of the same thing: one question,
thrown on the wall, answered by whoever is in the room.

## The stack in one sentence

A Fastify monolith over PostgreSQL, a React single-page application, Switch
edu-ID for identity, server-sent events keeping every open view live, code
run in the browser through WebAssembly for the trial and in hardened Podman
containers for the grade.

Contributors and agents start from the [developer documentation](development/index.md):
local setup, the repository layout, the product specification and the
architecture decision records.

!!! info "Source"

    Every page here is a file under `docs/` in the
    [repository](https://github.com/heig-tin-info/heig-quiz); the site is
    rebuilt by GitHub Actions on every push to `main`.
