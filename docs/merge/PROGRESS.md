# Merge progress

The single source of truth for where the merge stands. Update it **in the
PR of the task** (claim in the first commit, close in the last), never in a
separate commit on `main`. Protocol: [`README.md`](README.md).

## Now

- **Phase**: M0 — decisions and paper.
- **Next actions**: the product owner settles D01, D02, D04, D16 and gives
  the go for M0-02 (production measurements), which settles D08 and D09.
- **Classroom sync point**: `ab98cc0` (classroom `origin/main`,
  2026-09-28). A classroom commit after it touching a ported file must be
  forwarded (see strategy §1.2, principle 6). Check with
  `git -C ~/heig-classroom fetch && git -C ~/heig-classroom log --oneline ab98cc0..origin/main`.
- **Quiz base of the analysis**: `a7dfa26`.

Status values: `todo` · `in progress` · `review` (PR open, ready) ·
`done` · `blocked` (say on what) · `dropped`.

## Plan

| ID | Task | Status | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- |
| PLAN | Merge plan: ADR-035 (proposed), `docs/merge/` | review | `plan/merge-classroom` | — | Five read-only analyses (data, GitHub, journal+web, codespace+infra, spec fit) condensed into these files |

## M0 — Decisions and paper

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M0-01 | Settle blocking decisions | todo | — | | | |
| M0-02 | Measure production (read-only) | todo | PO go | | | |
| M0-03 | ADRs (035 accepted, imports, amendments) | todo | M0-01 | | | |
| M0-04 | Spec amendments | todo | M0-01 | | | |
| M0-05 | `CLAUDE.md`, `AGENTS.md`, reviewer prompts | todo | M0-03 | | | |

## M1 — Foundations

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M1-01 | Pure domain into `packages/domain` | todo | M0-03 | | | |
| M1-02 | GitHub adapters, config, image | todo | M0-03 | | | |
| M1-03 | `ActivityKind`, `ActivitySummary` union | todo | M0-03 | | | |
| M1-04 | Missing primitives, long-form styles | todo | M0-05 | | | |
| M1-05 | Web routes and mock skeleton | todo | M1-03 | | | |
| M1-06 | Import script skeleton, identity, login adoption | todo | D04, D08 | | | |

## M2 — GitHub substrate (dark)

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M2-01 | `github` schema and contracts | todo | M1-02, D02 | | | |
| M2-02 | Installations, org link, healing | todo | M2-01 | | | |
| M2-03 | GitHub account linking | todo | M2-01 | | | |
| M2-04 | Webhook intake, registry, deliveries | todo | M2-02 | | | |
| M2-05 | Periodic tasks | todo | M1-02, D10 | | | |
| M2-06 | Staging App and staging safety | todo | M2-01 | | | |
| M2-07 | Web: GitHub card and connect sheet | todo | M2-02, M2-03, M1-04, M1-05 | | | |

## M3 — Projects

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M3-01 | `project` schema and contracts | todo | M2-01, M1-01, D05 | | | |
| M3-02 | Project lifecycle | todo | M3-01, M2-02, D19 | | | |
| M3-03 | Acceptance and provisioning | todo | M3-02, M2-03 | | | |
| M3-04 | Ingestion and grading pipeline | todo | M2-04, M3-03 | | | |
| M3-05 | Deadline, freeze, dispatch, checkpoints | todo | M3-04, D13 | | | |
| M3-06 | Reconciliation of grades and repos | todo | M3-04, M2-05 | | | |
| M3-07 | Sync of the source repository | todo | M2-04, M3-02, D12 | | | |
| M3-08 | Teacher views, grades, release | todo | M3-04, M3-05 | | | |
| M3-09 | Student side, SSE, notifications | todo | M3-04, D18 | | | |
| M3-10 | Web: projects in Activities, New ▾ | todo | M3-01, M1-05 | | | |
| M3-11 | Web: new project form | todo | M3-02, M2-07 | | | |
| M3-12 | Web: project page | todo | M3-08 | | | |
| M3-13 | Web: student `ProjectRow` | todo | M3-09, M2-07 | | | |
| M3-14 | Pilot and load test on staging | todo | M3-01…13, M2-06 | | | |
| M3-15 | Groups (API) | todo | M3-03 | | | |
| M3-16 | Groups (web) | todo | M3-15, M3-12 | | | |

## M4 — Journal

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M4-01 | `packages/docrender`, schema, contracts | todo | M1-01, D03, D14, D15 | | | |
| M4-02 | Read side and ingestion | todo | M4-01, M2-02, M2-04 | | | |
| M4-03 | Writes | todo | M4-02, M2-03 | | | |
| M4-04 | Web: reader | todo | M4-02, M1-04, M1-05 | | | |
| M4-05 | Web: teacher tab | todo | M4-03, M2-07 | | | |
| M4-06 | Web: source editor | todo | M4-05 | | | |

## M5 — Student classroom page and gradebook

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M5-01 | API: the student's classroom | todo | M1-03 | | | |
| M5-02 | Web: student classroom page | todo | M5-01, D07 | | | |
| M5-03 | Gradebook module | todo | M3-08, D06 | | | |
| M5-04 | Web: Grades tabs | todo | M5-03 | | | |

## M6 — Online workspace and SEB

In the critical path only if D09 finds online assignments in production.

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M6-01 | HS256, codespace contracts | todo | D09 | | | |
| M6-02 | `packages/seb` | todo | D21 | | | |
| M6-03 | Import `apps/codespace` | todo | M6-01 | | | |
| M6-04 | Codespace CI/CD | todo | M6-03 | | | |
| M6-05 | Engine VM capacity, hygiene, seccomp | todo | D09 | | | |
| M6-06 | Quiz `codespace` module | todo | M6-03, M3-02 | | | |
| M6-07 | SEB for projects, proof B | todo | M6-02, M6-06 | | | |

## M7 — Finishing

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M7-01 | Palette, help, tours | todo | screens | | | |
| M7-02 | User guide | todo | screens | | | |

## M8 — Migration and cutover

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M8-01 | Import script complete | todo | schema tasks, D11 | | | |
| M8-02 | Legacy URL resolver | todo | M8-01, M3-12, M4-04 | | | |
| M8-03 | Caddy fragments | todo | — | | | |
| M8-04 | Codespace identity remap | todo | M6 in scope | | | |
| M8-05 | Cutover runbook | todo | M8-01…04 | | | |
| M8-06 | Rehearsal on staging | todo | M8-05, D22 | | | |
| M8-07 | Cutover | todo | M8-06 go, D20 | | | |

## M9 — Decommission

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M9-01 | Point of no return, decommission, close #143 | todo | M8-07 + observation | | | |

## Rehearsal log

| Date | Dump date | Duration | Parity report | Go / no-go | Notes |
| --- | --- | --- | --- | --- | --- |

## Session log

Newest first. One line per session that changed the state: date, who,
what moved, what the next session must know.

- 2026-09-28 — planning session: ADR-035 proposed, `docs/merge/` written on
  branch `plan/merge-classroom` from five read-only analyses of both
  repositories (classroom at `ab98cc0`, Quiz at `a7dfa26`). Next: product
  owner review of the plan and of D01, D02, D04, D16; go for M0-02.
