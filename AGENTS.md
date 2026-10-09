# Working on this repository with several agents

Several agents (Claude Code sessions, or a person and an agent) work on this
repository at the same time, and every push to `main` deploys to staging,
then to production once approved (`.github/workflows/ci.yml`, ADR-028). These directives exist because a shared working
tree once turned another agent's half-written package into a broken deploy.
They complete `CLAUDE.md`, which holds the product invariants.

## 1. One worktree per agent, one branch per subject

Never work in another agent's checkout. Start in a worktree of your own:

```bash
git worktree add ../heig-quiz-<subject> -b <subject>   # or: claude --worktree
```

The `.git` is shared, so branches see each other; the files, the index and
`git status` are yours alone. `EnterWorktree` does the same from inside a
session. The main checkout (`~/heig-quiz` on `main`) is for merging and
deploying, not for editing.

## 2. `main` receives merges, never edits

- Push your branch and open a pull request; the `checks` status runs there
  (build, typecheck, tests, frozen lockfile, in parallel jobs) before
  anything reaches `main`.
- Merge when green. A PR merges on `checks`; Coverage is informative — do
  not wait for it. The deploy jobs run on `main` only, so neither staging
  nor production ever sees a commit the checks did not pass.
- Rebase often (`git pull --rebase origin main` on your branch): small diffs,
  rare conflicts.

## 3. Stage by path

- `git add <the files you touched>`. Never `git add -A`, `git add .` or
  `git commit -a`: in a shared tree they sweep in someone else's work.
- Run `git status --short` right before committing. An unexpected modified or
  untracked path is another agent's work: leave it alone, mention it.
- A commit is atomic: `pnpm-lock.yaml` travels with the `package.json` that
  changed it, and a new workspace package with its entry in
  `pnpm-workspace.yaml`. Otherwise `pnpm install --frozen-lockfile` fails on
  CI and nothing deploys.
- **ADR numbers** follow the ID rule of `docs/adr/README.md` (origin/main and
  open PRs); `checks` refuses a shared prefix (`scripts/check-adr-numbers.mjs`).
- **Every PR adds a `changes/<slug>.md` entry** — what changed for students
  or teachers, in their words; audience `none` when nobody sees it
  (`changes/README.md`, ADR-087). `checks` refuses a PR without one, or one
  that renames an entry: `node scripts/check-changes.mjs --base origin/main`.

## 4. Before you push to `main`

`pnpm build && pnpm typecheck && pnpm test` locally, the same three steps CI
runs. A red `main` blocks every other agent's deploy, not only yours.

## 5. Moving work in progress into a worktree

```bash
git stash -u                                   # in the shared checkout
git worktree add ../heig-quiz-<subject> -b <subject>
cd ../heig-quiz-<subject> && git stash pop
```

## 6. Roles and guard rails in `.claude/`

- `/feature` (`.claude/skills/feature/SKILL.md`) orders the work on a
  feature: challenge, plan, implement in a worktree, review, PR. The session
  that runs it orchestrates; subagents cannot spawn subagents.
- `spec-challenger` runs before the code: it reads the spec, the ADRs and the
  open questions, and returns the questions a person must settle.
- `lean-reviewer` (design, footprint) and `invariant-reviewer` (the
  invariants of `CLAUDE.md`) review the diff, read-only, before the PR.
- `.claude/hooks/guard.mjs`, a `PreToolUse` hook, enforces sections 1–3
  mechanically: it refuses `git add -A|.|-u`, `git commit -a`, a
  `package.json` committed without the pending `pnpm-lock.yaml` or
  `pnpm-workspace.yaml`, and an edit to a tracked file in a checkout on
  `main`. Whoever merges in the main checkout sets `QUIZ_ALLOW_MAIN=1`.

## 7. One machine, shared RAM

All agents run on one workstation (WSL, 31 GB). Vitest starts a worker per
core, and every `apps/api` worker holds a PGlite of ~800 MB: two or three
full suites at once exhausted the RAM and took WSL down, twice, with every
session on it.

- `.claude/settings.json` sets `VITEST_MAX_WORKERS=4` for every session;
  `apps/api` and `apps/web` read it (their config caps it at
  `min(6, cores − 1)` otherwise).
- While iterating, run only the files you touched
  (`pnpm --filter @quiz/api test -- src/modules/<name>`); the full suite once,
  at the end, with `pnpm -r --workspace-concurrency=1 test`.
- `guard.mjs` refuses to start a test run while less than 8 GB is available
  or more than 20 vitest workers already run on the machine
  (the crashes happened at 58 to 76). Wait for them
  (a `Monitor` until-loop on `/proc/meminfo`) instead of retrying at once.
  `QUIZ_SKIP_MEMORY_GUARD=1` lifts the check.
- Kill every dev server or Vite you started before you finish.
