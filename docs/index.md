# HEIG Quiz

A quiz platform for HEIG-VD teachers. Question pools with categories, tags
and published versions; evaluations run live on a server-side clock, with a
projector dashboard and automatic grading, including code executed in a
sandbox; live polls answered from a phone through a QR code. One virtual
machine, one PostgreSQL, one repository, operable by one person.

<div class="grid cards" markdown>

-   :material-book-open-variant: **Guide**

    ---

    How to use the platform: courses and classrooms, question pools, the
    four question types, evaluations from configuration to released
    results, live polls, and what a student sees.

    [:octicons-arrow-right-24: Start with the overview](guide/index.md)

-   :material-code-braces: **Development**

    ---

    Running the platform locally, the repository layout, deployment, the
    documentation itself, and the product specification with the
    architecture decision records.

    [:octicons-arrow-right-24: Local setup](development/index.md)

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

!!! info "Source"

    Every page here is a file under `docs/` in the
    [repository](https://github.com/heig-tin-info/heig-quiz); the site is
    rebuilt by GitHub Actions on every push to `main`.
