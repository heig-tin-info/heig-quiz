# HEIG Quiz

A quiz platform for HEIG-VD teachers: question pools with categories, tags
and published versions; live evaluations run on a server-side clock, with
a projector dashboard and automatic grading — including sandboxed code
execution; live polls answered from a phone through a QR code. One virtual
machine, one PostgreSQL, one repository, operable by one person.

The **Specification** section is the product specification, in French: the
scope, the vocabulary, the numbered requirements, the question types, the
architecture and the questions still open. **Decisions** holds the
architecture decision records — the first ten are inherited from
[heig-classroom](https://github.com/heig-tin-info/heig-classroom), the
sibling project this one started from. **Development** carries the phase-one
plan and the review notes.

The stack in one sentence: a Fastify monolith over PostgreSQL, a React SPA,
Switch edu-ID for identity, server-sent events keeping every open view live,
and hardened Podman containers running student code.

!!! info "Source"

    Every page here is a file under `docs/` in the repository; the site is
    rebuilt by GitHub Actions on every push to `main`.
