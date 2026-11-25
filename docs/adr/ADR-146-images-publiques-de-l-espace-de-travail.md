# ADR-146 — Workspace images: public images pulled by digest, a base the platform publishes, a list per course

## Status

Proposed (2026-11-25). Decisions 1 to 9 are the product owner's
(2026-11-25, discussion of issue #1111); the admission checks of decision 5
and the assumptions under Open are the orchestrator's, within them.

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
   Registry or Docker Hub), always by digest.
2. **The platform publishes `quiz-base`**, public, built and pushed by the
   repository's CI: today's `c-dev` without Baygon — Debian, code-server
   and its extensions (status bar, clangd, debug), the Safe Exam Browser
   workarounds, the entrypoint and the rest of the contract, and gcc, g++,
   gdb, make, git, python3, pytest and the man pages. Its contract tests
   ship in the image.
3. **The default image is the portal's configuration**
   (`CODESPACE_DEFAULT_IMAGE`), a `quiz-base` reference by digest, changed
   by a deploy.
4. **A course holds a list of images**: a name and a reference
   (`ghcr.io/…` or `docker.io/…`). A course owner adds, refreshes or
   removes one (`requireCourseRole` owner, the pools' 403); every staff
   member of the course reads the list. A project in the online workspace
   picks the default or one image of its course's list.
5. **An image is admitted before it is offered.** On adding or refreshing,
   Quiz resolves the reference's tag to a digest and the portal pulls it
   on the engine VM, as a job the course's Images screen follows
   ("Downloading…", "Checking…", then ready or refused with its reason).
   The portal checks, and refuses the image otherwise:
   - it is public (an anonymous pull);
   - its compressed size stays under a ceiling of the portal's
     configuration;
   - its first layers are those of a released `quiz-base`
     (read from the manifest);
   - `quiz-base`'s contract tests, run from the image in a session
     container with the session's hardening, pass.
   The portal runs only digests it admitted; a reference it has not
   admitted is refused at session start, whatever Quiz sends.
6. **A digest never moves by itself.** A push to the image's tag changes
   nothing until an owner presses Refresh, which re-resolves, re-pulls and
   re-admits it. New sessions get the new digest; a running session keeps
   its own.
7. **An image on an older `quiz-base` still runs, and is marked obsolete.**
   `quiz-base` carries its version as an OCI label; when a newer one is
   released, the course's Images screen marks every image built on an
   older one, and the course's owners are notified to rebuild it.
8. **No automatic deletion.** The administrator's console shows the disk
   each pulled image takes, its courses and its last use; the
   administrator frees space by hand, with the teachers.
9. **A course's image may bring notebook support back**
   ([ADR-047](ADR-047-espace-de-travail-en-ligne.md#amendment-2026-10-11-one-origin-for-every-session-audit-l24)
   rule 4 holds for `quiz-base`, not for an image derived from it). The
   product owner accepts the residual risk of the shared origin (audit
   L24): a notebook's output runs script on the portal's origin, which
   reaches the other sessions open in the same browser — a group member's,
   or those of a staff member in a review session (ADR-129). One origin
   per session (open question 70) stays the fix, tracked with the
   Jupyter-in-the-workspace issue (#1217).

**Baygon leaves `quiz-base`.** It becomes the first image derived outside
the platform (a repository of its own: `FROM quiz-base`, Baygon at the
version its labs need, a CI that pushes it), which proves the cycle. The
courses whose labs run Baygon add it and switch their projects before the
default moves from `c-dev` to `quiz-base`.

**A public image is public content.** The teachers' guide says it plainly:
no hidden test, no solution, no exam data in an image; they stay in the
distribution repository.

## Consequences

- The engine VM runs no teacher's code at build time and no deploy builds
  an image; the rootful socket only pulls and runs. The hardening of a
  session does not change: the same flags, read-only root, limits and
  entrypoint for every image.
- A lab in any language is a Containerfile in the teacher's own
  repository; the same image can be the `container:` of the lab's grading
  workflow, so the student works in the grader's environment.
- Everything a lab needs is installed at build time, so the session needs
  no network, under Safe Exam Browser or not.
- Work owed: `quiz-base` and its contract tests split out of `c-dev`
  (`test.sh` keeps a toolchain part and a Baygon part moves out), its CI
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

- Must an image derive from `quiz-base`? The owner's word was "should";
  the orchestrator made it a check of decision 5, because the contract
  (the deadline in the status bar, the Safe Exam Browser workarounds, no
  port proxy) lives in the image and the check is cheap. Assumed for now:
  required.
- Is an image too old for the portal ever refused (a code-server security
  fix, a change of the status-bar extension's protocol with the portal)?
  Assumed for now: never refused, only marked obsolete; `quiz-base` keeps
  its contract backward compatible.
- The size ceiling. Assumed for now: 3 GB compressed, `quiz-base`
  included.
