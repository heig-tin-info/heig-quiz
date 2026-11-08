# ADR-007 — Where CI runs: GitHub-hosted runners for every workflow, Quiz's VMs for no CI job

## Status

Rewritten 2026-11-08 for Quiz as it runs; no decision of the product owner
changes. Inherited from heig-classroom, where it was accepted on 2026-07-03
(a dedicated VM of ephemeral self-hosted GitHub Actions runners, sized by the
deadline freeze); that decision and its sizing are kept in the
[historical record](history/ADR-007-runner-self-hosted.md), with Quiz's
status notes of 2026-09-30 (ADR-035: the record applied again, to projects).
heig-classroom no longer exists (its importer was removed by #1042).

- Amended 2026-10-12 by [ADR-106](ADR-106-notation-des-projets-par-criteres.md):
  a project in the `criteria` mode is graded by the platform; the CI's
  objective tier keeps running as the student's indicative feedback, and the
  `llm-review` tier is decommissioned (M3-14f, done 2026-10-14). Superseded
  for a v3 snapshot, and whole once the v2 path is removed (card L-06g), by:
- Amended 2026-10-26 by [ADR-119](ADR-119-criteres-v3-preuves-de-la-ci.md)
  §1, §6: a project in the `criteria` mode gets its automatic evidence from
  the project's CI again, through a staggered `quiz-grade` dispatch of the
  platform; its review stays the platform's LLM pass.

What this record states was read from the workflows on 2026-11-08; what
could not be read is listed under [Open points](#open-points).

## Context

Two kinds of code run for Quiz: Quiz's own build, tests and deploys, and the
students' projects. The first lives in one repository,
`heig-tin-info/heig-quiz`, which is public. The second lives in one private
repository per student or group, in the organization of each course (for
instance `Info1-MI-2026`), where a constant, protected
`.github/workflows/grading.yml` calls StudentScore's reusable workflow
(`heig-tin-info/score`, public), pinned by sha (ADR-119 §1).

The code of a question is not CI: it is executed by Quiz's own runner
service, `apps/runner`, on the engine VM ([ADR-016](ADR-016-runner-sur-vm-separee.md)).
"Runner" alone means `apps/runner`; the GitHub Actions machines are "CI
runners". The two never meet, and the two records stay separate
([index](README.md#maintaining-a-record)).

heig-classroom ran its grading on self-hosted runners because GitHub-hosted
minutes for private repositories were budgeted per organization and a
submission week would exceed them; its sizing started from the freeze: runs
on commits received before the deadline must finish within the grace.

## Decision

1. **Quiz's own CI runs on GitHub-hosted runners.** Every workflow of
   `heig-tin-info/heig-quiz` declares `runs-on: ubuntu-latest`: `ci.yml`
   (the `checks` jobs, the image, the deploys to staging, the staging portal,
   production and the codespace portal), `coverage.yml`, `docs.yml`,
   `image-artifact.yml` and `runner-integration.yml`. The repository being
   public, GitHub does not bill these minutes on standard hosted runners.
2. **The runner's isolation is proven on a hosted runner too.**
   `runner-integration.yml` builds the language images cold and runs the
   Podman integration suite of `apps/runner` on a rootful socket, in two
   legs that both block: `default` (crun, the system socket) and `runsc`
   (gVisor, the runner's own socket set up by
   `apps/runner/deploy/install-gvisor.sh`) — ADR-016, amendment of
   2026-10-11.
3. **Quiz's VMs run no CI job.** The application VM
   (`portal.heig.chevallier.io`) and the engine VM (`code.chevallier.io`,
   `apps/runner` and the workspace portal) host no GitHub Actions runner. A
   deploy job runs on a hosted runner and reaches each VM only through an
   SSH forced command (`docs/development/deployment.md`; ADR-016 for the
   engine VM). No workflow, of Quiz or of a project, executes on them.
4. **A project's CI runs on GitHub-hosted runners of its course's
   organization.** StudentScore's reusable workflows at the versions the
   shim pins declare `runs-on: ubuntu-latest` (`run.yml` of 1.0.0, the v3
   `quiz-grade` run of ADR-119; `grading.yml` of 0.7.5, the `objective` and
   `llm-review` jobs of the v2 and `auto` modes). A calling workflow cannot
   change a reusable workflow's runner, so a lab that uses them consumes the
   course organization's hosted minutes, under that organization's plan.
5. **The platform spreads its own load.** Quiz's `quiz-grade` dispatches are
   staggered, one every 15 s per App installation (ADR-119 §1, choice f):
   the organization's concurrent jobs are shared by every repository of the
   course, and a freeze of 100 repositories must not queue 100 runs at once.
   Pushes during a submission week run as the students push.
6. **A late run never changes a frozen grade, only delays it.** What a
   project's grade is built on is fixed by the server's receipts
   (`push_receipts`, ADR-064) and by the platform's dispatch of the frozen
   sha (ADR-119 §6), not by when a CI run starts or ends; a run that comes
   back after 24 h is `no_result` and the teacher grades (ADR-119). The
   project's `grace_minutes` (default 30, per project) bounds what counts as
   on time, not the CI's capacity.
7. **No secret is needed by a graded run.** The shim carries no lab
   information and no token; the run checks out the commit Quiz sent and
   uploads one `results` artifact (ADR-119 §1). The App never holds the
   "Self-hosted runners" organization permission: Quiz registers no CI
   runner.

## Consequences

- Quiz's CI costs no minutes; a project's CI costs the course
  organization's minutes, which this repository cannot see.
- Nothing of Quiz's to patch, size or keep a registration token for on the
  CI side; the engine VM's capacity serves question code and workspaces
  only (ADR-016, ADR-101).
- A course organization out of minutes or over its concurrency stops its
  labs' CI: the student loses the indicative feedback, and a `criteria`
  project's evidence falls to `no_result` after 24 h, which the teacher
  grades by hand. The grade is never wrong for it, only later.
- A hosted runner is a fresh VM per job: the student's code runs without
  any secret and nothing persists between jobs.

## Rejected alternatives

1. **Self-hosted ephemeral runners on a dedicated VM** (heig-classroom's
   decision, 2026-07-03; [historical record](history/ADR-007-runner-self-hosted.md#decision)):
   not reflected by any workflow this record could read. Whether to bring it
   back is a product decision, against the minutes and the concurrency the
   course organizations actually have (open points 1 to 3).
2. **Running project CI on the engine VM**: it would put student code under
   a GitHub runner, with a registration credential, beside the question
   runner and the workspace portal whose hardening ADR-016 owns.

## Open points

Not verified on 2026-11-08 (this record names no number it could not read):

1. **The heig-classroom CI runner VM.** Whether the self-hosted runner VM of
   the historical record, with its organization runner group and label
   `grading`, still exists, and who operates it. Listing an organization's
   runners needs an organization administrator.
2. **The registration PAT.** If that VM is gone, its fine-grained PAT
   ("Self-hosted runners: read & write", 12-month expiry) should be revoked;
   if it still runs, its expiry date.
3. **Minutes and concurrency per course organization.** The plan of each
   course organization (`Info1-MI-2026` and the others), its included
   minutes, any spending limit, and its concurrent-job limit: the figures
   against which a submission week and ADR-119's 15 s stagger should be
   checked (the App holds `organization_plan: read`, used today only for
   the Free-plan check of `docs/development/github-app.md`). The 3,000 minutes and the sizing of the historical record are
   heig-classroom's, not Quiz's.
4. **Labs outside StudentScore.** Whether any lab repository still carries
   heig-classroom's own `grading.yml` with `runs-on: [self-hosted,
   grading]`; without a registered runner such a job would wait in the queue
   rather than run. The lab repositories this record tried to read were not
   readable with the author's access.
5. **ADR-119's wording.** ADR-119 §1 and its Context speak of "the CI
   runners of ADR-007" as shared; they are the course organization's hosted
   runners (decision 4). The stagger's reason holds; the wording is left to
   ADR-119's owner.
