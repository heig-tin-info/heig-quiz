# Merging heig-classroom into Quiz

This folder is the working plan of the merge decided by
[ADR-035](../adr/ADR-035-fusion-de-classroom.md): what is ported, in which
order, by which agent, how the data moves, and where the work stands. It is
written so that **any session can pick the work up** — read this page, then
[`PROGRESS.md`](PROGRESS.md), then the task card you take.

## Reading order

| File | What it settles |
| --- | --- |
| [`PROGRESS.md`](PROGRESS.md) | **Where the work stands.** Every task, its status, its branch and PR, the handoff notes. The single source of truth for progress. |
| [`01-strategy.md`](01-strategy.md) | The target, the principles, the phases and their exit criteria, what is prod-safe. |
| [`02-data-and-migration.md`](02-data-and-migration.md) | Table-by-table mapping, identity matching, the migration script. |
| [`03-github-projects.md`](03-github-projects.md) | The GitHub side: inventory, coupling, target modules, tables, routes, jobs. |
| [`04-journal.md`](04-journal.md) | The journal: how it works, what porting it requires, its known defects. |
| [`05-web.md`](05-web.md) | Screens: where each classroom screen lands, the student classroom page, GitHub onboarding, UI kit, i18n. |
| [`06-codespace-seb-infra.md`](06-codespace-seb-infra.md) | Online workspace, unified SEB, infrastructure, cutover, permalinks, rollback. |
| [`07-incompatibilities.md`](07-incompatibilities.md) | Every known incompatibility and risk, with its resolution and the task that carries it. |
| [`08-decisions.md`](08-decisions.md) | The decisions that belong to the product owner, with a suggested answer each. |
| [`measures-2026-09-28.md`](measures-2026-09-28.md) | Production counts (M0-02): identity overlap, classroom content, classes present in both apps. |
| [`09-tasks.md`](09-tasks.md) | The task cards: one PR each, with dependencies, files, tests, acceptance, and the brief to hand to an agent. |

## Sources

The analysis was made on 2026-09-28 against Quiz `main` (`a7dfa26`) and
classroom `origin/main` (`ab98cc0`, the journal commit). Paths are written:

- `Q:` — this repository (`apps/api/src/...` unless the path says
  otherwise);
- `C:` — heig-classroom (`apps/server/src/...` unless the path says
  otherwise). A read-only reference checkout is made with
  `git -C ~/heig-classroom fetch && git -C ~/heig-classroom worktree add --detach <scratch>/classroom origin/main`.
  Never edit `~/heig-classroom` from a merge task: classroom stays in
  production until the cutover, and its fixes are cherry-picked forward
  (see "Classroom keeps living" in [`01-strategy.md`](01-strategy.md)).

## Rules for the agents working on the merge

1. **`AGENTS.md` applies**: a worktree per task, `main` by merge only,
   stage by path, the lockfile with its `package.json`.
2. **One task card, one branch, one PR.** The branch is named
   `merge/<task-id>-<slug>` (for example `merge/M2-03-webhook-intake`), the
   PR title starts with the task id.
3. **Claim before working**: set the task to `in progress` in
   `PROGRESS.md` with your branch name, in the first commit of your branch,
   and open the PR as a draft right away. An open draft PR whose title
   starts with a task id is the claim; `gh pr list --search "M2-03"` shows it.
4. **Checkpoint in the PR description.** Keep a "State" section in the
   PR body (done / next / blocked) and update it at every push. If a session
   dies, the next one reads the PR, not the transcript.
5. **Close the task in the same PR** that delivers it: status `done`, the
   PR number, one line of handoff in `PROGRESS.md` (what the next task must
   know).
6. **A decision you meet that is not in `08-decisions.md`** is not yours
   to take: add it there as an open item, mark your task `blocked`, say so
   in the PR.
7. **Reviews**: every code task goes through `lean-reviewer` and
   `invariant-reviewer` before merge (`/feature`); a task that touches the
   spec or an ADR goes through `spec-challenger` first.
8. **Update the plan when reality differs.** A card that proves wrong is
   corrected in the PR that found out, not worked around.
