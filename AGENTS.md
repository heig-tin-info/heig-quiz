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

- Push your branch and open a pull request; the `checks` job runs there
  (build, typecheck, tests, frozen lockfile) before anything reaches `main`.
- Merge when green. The deploy jobs run on `main` only, so neither staging
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

## 4. Before you push to `main`

`pnpm build && pnpm typecheck && pnpm test` locally, the same three steps CI
runs. A red `main` blocks every other agent's deploy, not only yours.

## 5. Moving work in progress into a worktree

```bash
git stash -u                                   # in the shared checkout
git worktree add ../heig-quiz-<subject> -b <subject>
cd ../heig-quiz-<subject> && git stash pop
```
