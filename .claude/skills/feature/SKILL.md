---
name: feature
description: How to carry a feature, an issue or a non-trivial fix from request to pull request with agents — challenge against the spec, plan, implement in a worktree, review by lean-reviewer and invariant-reviewer, fix, PR. Use when the user asks for a feature, an issue to be implemented, or any change that touches more than a couple of files. Skip it for a typo, a one-line fix or a question.
argument-hint: "[issue number or feature description]"
---

# Feature

The session that runs this skill is the orchestrator: it talks to the user,
delegates, and decides. Subagents cannot spawn subagents, so every delegation
below is made from here. `AGENTS.md` and `CLAUDE.md` hold the rules; this
file only orders the steps.

## 0. Size the request

- **Trivial** (typo, one-line fix, copy change, a single obvious file): skip
  to step 3, work alone, and still end with step 5.
- **Normal**: every step.
- **Large** (several modules, a schema change, a new question type): every
  step, and propose splitting it into several PRs at step 2.

Say which size you chose in one line.

## 1. Challenge — `spec-challenger`

Delegate to `spec-challenger` with the issue number or the request verbatim.
Read its output yourself; do not forward it raw.

- **GO**: continue.
- **GO WITH ANSWERS**: put the blocking questions to the user (with
  `AskUserQuestion` when they have discrete answers), each with the value the
  challenger would assume. Do not answer them yourself: a row of
  `06-questions-ouvertes.md` is never settled silently.
- **RETHINK**: stop and tell the user why, with the sources.

An answer that settles an open question or a non-trivial choice becomes part
of the change: the row of `06-questions-ouvertes.md` updated, or an ADR.

## 2. Plan

For a normal or large change, write a short plan: files touched, contracts,
migration, tests, i18n keys, and the requirement IDs it satisfies. Use the
`Plan` agent when the codebase part is unfamiliar; `Explore` for a broad
search. Show the plan to the user only when step 1 raised questions or the
change is large; otherwise proceed.

## 3. Implement — in a worktree

Never in the main checkout (the guard hook refuses it anyway).

- Alone: `git worktree add ../heig-quiz-<subject> -b <subject> origin/main`,
  or `EnterWorktree`.
- Delegated (several independent parts): one `general-purpose` agent per part
  with `isolation: "worktree"`, each told the plan, its part, the files it
  owns, and to read `CLAUDE.md` and `AGENTS.md` first. Parts that touch the
  same files are not independent: do them in sequence.

A UI change goes through the `quiz-ui` skill, including the screenshot check.
Done means: `pnpm build && pnpm typecheck`, then `VITEST_MAX_WORKERS=4 pnpm -r --workspace-concurrency=1 test`, pass in the worktree.

## 4. Review — both reviewers, in parallel

Send `lean-reviewer` (design, footprint) and `invariant-reviewer`
(invariants, security) in one message, each with the worktree path, the base
`origin/main`, and the request. Then:

- fix every blocker and major finding yourself, or send it back to the
  implementer agent (`SendMessage`, so it keeps its context);
- a finding you disagree with: say why to the user, do not drop it silently;
- re-run the reviewer whose findings you fixed, once. If it still does not
  approve, bring the disagreement to the user rather than looping.

## 5. Pull request

Add the change's entry, `changes/<slug>.md` (audience `none` when no user
sees it; `changes/README.md`), and check it with
`node scripts/check-changes.mjs --base origin/main`. Stage by path, commit,
push the branch, `gh pr create`. The description
states: what the change does, the requirement IDs, the questions settled at
step 1 and by whom, the reviewers' verdicts. Merging is the user's call
unless they said otherwise.

Report to the user in a few lines: the PR link, what was decided with them,
and anything left open.
