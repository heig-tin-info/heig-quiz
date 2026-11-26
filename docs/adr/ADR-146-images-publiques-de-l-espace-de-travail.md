# ADR-146 — Workspace images: public images pulled by digest, a base the platform publishes, a list per course

## Status

Accepted (2026-11-25, product owner: "on peut aller de l'avant").
Decisions 1 to 9 are the owner's (discussion of issue #1111); the admission
checks of decision 5 and the assumptions under Open are the orchestrator's,
stated to the owner and not objected to.

- 2026-11-25, amended (the orchestrator's, stated to the owner on
  2026-11-25; scope: decision 2's "a release is
  versioned and published only from a production-approved run"): a
  `:<VERSION>` tag pushed from `main` is a candidate; it becomes a release
  once the approved production deploy has pinned, tested and switched to
  it ([amendment](#amendment-2026-11-25-candidate-tags)).
- 2026-11-26, amended by [ADR-147](ADR-147-depot-de-distribution-dans-l-espace-de-travail.md)
  (product owner: *"la règle du 25 novembre pose un problème il faut la
  changer"*; scope: decision 3 and the review sentence of decision 9): the
  staff's review sessions run the project's image; the collection's reader
  and the portal's helper containers stay on the default
  ([amendment](#amendment-2026-11-26-reviews-run-the-projects-image)).

Scope: which container image a student's online workspace session runs,
where it comes from, who chooses it and what Quiz checks before running it.
Out of scope: the `quiz-runner-*` images of `apps/runner` (root `CLAUDE.md`
invariants 10–13), which stay the platform's own.

Relations: supersedes [ADR-016](ADR-016-runner-sur-vm-separee.md)'s
"student image built by hand, never pulled" (2026-10-07, M6-04) and its
2026-11-18 amendment "the prod portal deploy rebuilds the student image";
amends [ADR-047](ADR-047-espace-de-travail-en-ligne.md#amendment-2026-10-11-one-origin-for-every-session-audit-l24)
rule 4 for a course's images; leaves
[open question 70](../spec/06-questions-ouvertes.md) open; replaces the
declarative-recipe proposal of issue #1111.

## Context

The online workspace runs one student image, `codespace/c-dev`, built on
the engine VM from `apps/codespace/images/c-dev/`. It mixes three things:
the platform's contract (code-server without port proxy nor gallery, the
status-bar extension that shows the deadline, the Safe Exam Browser
workarounds, the entrypoint, user 1000, no notebook support), a C
toolchain, and Baygon, a functional-test runner some teachers use, pinned
at 0.7 while some labs need 0.10. A lab in Go, Scala, R or SQL (#1172)
has no path: the image is edited in the repository and rebuilt on the VM.

The per-assignment image is already wired and unused:
`CodespaceAssignmentSync.image` (`packages/contracts/src/codespace.ts`)
reaches the portal, which falls back to `CODESPACE_DEFAULT_IMAGE`; Quiz
always sends `null`.

A first proposal (#1111) had teachers write a declarative recipe that the
platform would build. Building means running the teacher's code (a
package's install scripts) on the engine VM, with the network open, and
supporting apt, pip, npm and cargo one by one. A teacher who needs a
custom toolchain can write a Containerfile; the platform does not need to
know what the students run, only that the image keeps the contract.

## Decision

1. **The platform builds no student image, on any of its machines.** A
   session runs a public OCI image pulled from a registry (GitHub Container
   Registry or Docker Hub), always by digest, for `linux/amd64`. Every
   container is started with `--pull=never`: the portal pulls only through
   the admission of decision 5 or a deploy, never implicitly at a start.
2. **The platform publishes `quiz-base`**, public, built and pushed by the
   repository's CI: today's `c-dev` — Debian, code-server and its
   extensions (status bar, clangd, debug), the Safe Exam Browser
   workarounds, the entrypoint and the rest of the contract, and gcc, g++,
   gdb, make, git, python3, pytest and the man pages, and Baygon 0.7 for
   the labs that run it today. **A release is versioned and published only
   from a production-approved run**, never from a staging deploy; the
   moving tag teachers derive from (`latest`) points to the last release.
   The host-driven `test.sh` stays the gate: the production portal deploy
   pulls the new release, runs it against that digest, and switches only
   on a pass (ADR-016's "only a pass takes the tag", carried over).
3. **The platform's own runs are `quiz-base`, never a course image.** The
   default image (`CODESPACE_DEFAULT_IMAGE`), the confined reader of the
   deadline collection (`CODESPACE_IMAGE`, ADR-130) and the staff's review
   sessions (ADR-129 §10; *amended 2026-11-26: they run the project's
   image, [below](#amendment-2026-11-26-reviews-run-the-projects-image)*)
   run the current `quiz-base` release by digest;
   both variables move together, by a deploy that pulled the release
   first. The released set (the digests of every `quiz-base` release) is a
   portal configuration list, changed by a deploy.
4. **A course holds a list of images**: a name and a reference
   (`ghcr.io/…` or `docker.io/…`), at most five. A course owner who holds
   the workspace grant (ADR-047, rule 4) adds, refreshes or removes one
   (`requireCourseRole` owner, the pools' 403, then the grant's); every
   staff member of the course reads the list. A project in the online
   workspace picks the default or one image of its course's list. An image
   a project uses cannot be removed.
5. **An image is admitted before it is offered.** The portal resolves the
   reference's tag to the `linux/amd64` manifest's digest, pulls it
   anonymously on the engine VM, as a job the course's Images screen
   follows ("Downloading…", "Checking…", then ready or refused with its
   reason). Quiz offers only a ready image. The portal refuses the image
   unless:
   - the free disk stays above the floor before the pull, and its size on
     disk after the pull stays under the ceiling (both portal
     configuration);
   - its first **uncompressed** layers (the config's `diff_ids`) are those
     of a released `quiz-base`; the base version is read from that prefix,
     never from a label the image can override;
   - its `User`, `Entrypoint` and `Cmd` are the base's;
   - the released base's contract check, run **from the portal's own copy**
     against a container of the image under the session's hardening,
     passes.
   The portal runs only digests it admitted; a reference it has not
   admitted is accepted in a sync (the deadline and the update it carries
   still apply) and refused at session start, with a page of its own.
   **Admission catches accidents, not the image's author**: an author can
   rewrite any file of the base. What protects security or integrity is
   enforced at run time by the portal (the session's flags, `--user`, the
   network, `--pull=never`), or is the course owner's responsibility, as
   the lab's own repository already is.
6. **A digest never moves by itself, and Refresh always applies.** A push
   to the image's tag changes nothing until an owner presses Refresh, which
   re-resolves, re-pulls and re-admits it. Refresh is never refused, even
   while a project using it is open, `online_seb` included (owner,
   2026-11-25): every container started afterwards — a new session, a
   resume, a relaunch — runs the new digest; a running container keeps its
   own.
7. **An image on an older `quiz-base` still runs, and is marked obsolete.**
   When a newer release exists, the course's Images screen marks every
   image whose prefix is an older one, and the course's owners are
   notified to rebuild it. A minimum base the portal accepts exists as a
   setting, empty: it is filled only for a release that fixes a flaw.
8. **No automatic deletion.** The administrator's console shows the disk
   each pulled image takes, its courses and its last use, for both
   instances (staging and production share the engine VM's image store);
   the administrator frees space by hand, with the teachers.
9. **A course's image may bring notebook support back**
   ([ADR-047](ADR-047-espace-de-travail-en-ligne.md#amendment-2026-10-11-one-origin-for-every-session-audit-l24)
   rule 4 holds for `quiz-base`, not for an image derived from it). A
   course image controls everything code-server serves on the portal's
   shared origin (audit L24), notebooks and the workbench alike, so its
   script reaches the other sessions open in the same browser. Decision 3
   keeps the staff's review sessions out of it; the product owner accepts
   the rest in writing (2026-11-25): a course's image against the sessions
   of that course's students and of a group's members. One origin per
   session (open question 70) stays the fix, tracked with the
   Jupyter-in-the-workspace issue (#1217).

**Baygon 0.7 stays in `quiz-base` for now** (owner, 2026-11-25), so the
labs that run it keep working. Once this decision is delivered, a derived
image with Baygon 0.10 (a repository of its own, `FROM quiz-base`, a CI
that pushes it) is the first custom image and proves the cycle. Whether
Baygon later leaves the base is decided then.

**A public image is public content.** The teachers' guide says it plainly:
no hidden test, no solution, no exam data in an image; they stay in the
distribution repository.

## Consequences

- The engine VM runs no teacher's code at build time and no deploy builds
  an image; the rootful socket only pulls and runs. The session's flags,
  read-only root and limits do not change for any image.
- Unpacking a third party's layers as root on the engine VM replaces the
  supply-chain argument of ADR-016's 2026-11-18 amendment: accepted, the
  pull bounded by the free-disk floor and the ceiling, the image never
  started outside the session's hardening.
- A lab in any language is a Containerfile in the teacher's own
  repository; the same image can be the `container:` of the lab's grading
  workflow, so the student works in the grader's environment.
- Everything a lab needs is installed at build time, so the session needs
  no network, under Safe Exam Browser or not.
- Work owed: `quiz-base` and its contract tests split out of `c-dev`
  (`test.sh` split into the contract and the toolchain), its CI
  publication; the course's image list (a table of the `codespace`
  module), the Images screen and the project's choice; the portal's pull
  and admission job and its admitted set; the obsolete mark; the console's
  disk view; the teachers' guide page on deriving an image.
- Cost accepted: a custom image needs a teacher able to write a
  Containerfile and a CI; an image can rot on an old base until its owner
  rebuilds it.

## Alternatives considered

- **A declarative recipe built by the platform** (the first proposal of
  #1111). Rejected: a package's install scripts are arbitrary code, so a
  recipe is no safer at build time than a Containerfile, and it needs an
  editor, a generator and one integration per package manager.
- **A free Containerfile built on the engine VM.** Rejected: teachers'
  code on the rootful socket with the network open.
- **Private images.** Rejected: pulling them needs a registry credential
  per teacher or course on the engine VM.
- **Following a tag** (no digest). Rejected: a push would change what a
  class runs in the middle of a lab test, after the admission.

## Open

- The ceilings. Assumed for now: 4 GB on disk per image, `quiz-base`
  included; a free-disk floor of 20 GB before a pull.

## Amendment 2026-11-25: candidate tags

*The orchestrator's, stated to the owner on 2026-11-25, during the delivery
of decision 2; scope: what "a release"
is. Operations: `apps/codespace/deploy/RUNBOOK.md` §7.*

Decision 2 publishes a release "only from a production-approved run", but
the image must exist in the registry before production can pull and test
it. So:

- The repository's CI pushes `ghcr.io/heig-tin-info/quiz-base:<VERSION>`
  from `main`, from the bytes it built and tested, never overwriting an
  existing tag. That tag is a **candidate**.
- A candidate becomes a **release** when the approved production portal
  deploy has pinned it (`apps/codespace/deploy/quiz-base.ref`), pulled it,
  tested it on the engine VM and switched both instances to it. Only then
  does `latest` move to it, and only then does the portal's released set
  (decision 3: the pin, and `CODESPACE_BASE_RELEASES` once the admission
  exists) include it.
- Decision 5's prefix check admits a course image only on a **released**
  base: an image derived from a candidate that never became a release is
  refused (`not_on_base`).

## Amendment 2026-11-26: reviews run the project's image

*Product owner, 2026-11-26: "la règle du 25 novembre pose un problème il
faut la changer". [ADR-147](ADR-147-depot-de-distribution-dans-l-espace-de-travail.md)
§6 and §8 own the rule; scope: decision 3 and decision 9's sentence on
review sessions.*

- **Decision 3** now reads: the default image and the confined reader of
  the deadline collection run `quiz-base`, and so do the portal's helper
  containers (the review wipe, the admission); the staff's review sessions
  (ADR-129), and an owner's session on the distribution repository
  (ADR-147), run **the project's image**, the default when it has none or
  works in the students' own tools.
- **Decision 9**: "Decision 3 keeps the staff's review sessions out of it"
  no longer holds. A course image now reaches a staff member's browser,
  beside their sessions of other courses, and renders students' notebook
  outputs there; both risks are accepted by the product owner (ADR-147 §8).
  One origin per session (open question 70, #1217) stays the fix.
