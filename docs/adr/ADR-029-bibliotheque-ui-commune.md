# ADR-029 — A UI library shared by Quiz and Classroom

## Status

Accepted (2026-09-26, asked for by the product owner in issue #143). This ADR
settles the direction and the boundaries; the extraction itself has not
started, and nothing in this repository changes until the package exists.

## Context

Quiz started as a pruned copy of heig-classroom
(`docs/spec/07-reutilisation-heig-classroom.md`), and the web app kept its
design system: `ui.tsx`, `style.css`, `theme.ts`, `notify.tsx`,
`confirm.tsx`, `DESIGN.md`. Since the copy, the two have evolved separately.
Measured on 2026-09-26:

- Both apps run the same stack: React 19.2, Tailwind 4.3, Vite 8.1.
- 55 names are exported by both `apps/web/src/ui/` (Quiz, 102 exports) and
  `apps/web/src/ui.tsx` (Classroom, 65 exports): `Button`, `Card`, `Badge`,
  `Alert`, `Field`, `Modal`, `Sheet`, `Tabs`, `PageHeader`, `EmptyState`,
  `Spinner`, `Menu`, `Switch`, `Segmented`, `useLayer`, `useEscape`,
  `useScrollLock`, `useSortableTable`… Same names, separately maintained.
- The tokens have started to drift. Quiz raised `--fg-faint` from `#8f8a80`
  to `#726d64` to hold captions to 4.5:1; Classroom still has the old value,
  so the same caption passes WCAG AA in one app and fails it in the other.
  Quiz added `--info` / `--info-soft`; Classroom has neither.
- Each repository carries its own `DESIGN.md` and its own agent skill
  (`quiz-ui`, `hgc-ui`) restating the same rules.

Every accessibility fix, every bug in a layer or a focus trap, is now made
twice or made once and forgotten in the other app. Agents working on one
repository cannot see the other, so they re-create primitives that already
exist next door.

`packages/ui` (`@quiz/ui`) already exists in this repository, but it answers
a different problem: it holds what the question-type packages (`qt-*`)
share, which a package cannot import from `apps/web`. It is Quiz-specific
(code areas, verdicts, issue lists) and stays so.

## Decision

### 1. One package, in a repository of its own

A new public repository, `heig-tin-info/heig-platform`, a pnpm workspace
whose first and, for now, only package is `@heig-platform/ui`. Neither app
repository hosts it: whichever one did, the other would depend on its
release cycle and its CI, and a Quiz deploy would never be the moment to
publish a Classroom dependency.

It is published to the public npm registry, under the `@heig-platform`
organization, by the repository's CI through npm trusted publishing (GitHub
OIDC, with provenance). No long-lived npm token exists anywhere. Both app
repositories are public, and a public package installs without credentials:
`pnpm install --frozen-lockfile` in CI and in the Docker build stay exactly as
they are.

### 2. What goes in, what stays out

In the package:

- **Tokens.** `tokens.css`: the raw values on `:root` and `html.dark`, and
  the Tailwind `@theme` block that maps them to the semantic utilities
  (`bg-surface`, `text-fg-muted`, `rounded-field`…). Where the two apps
  disagree today, the more accessible value wins (Quiz's `--fg-faint`).
  An app may override a documented, short list of tokens — the accent pair
  first — and nothing else.
- **Generic primitives and hooks.** The 55 shared exports above, after
  reconciling each pair, then whatever else proves generic (`Combobox`,
  `Popover`, `Table`, `Avatar`…). The `confirm` and `notify` providers and
  the theme store (`theme.ts`) with them.
- **The rules.** The generic half of `DESIGN.md` — tokens, states
  (loading / empty / error), forms, confirmations, layers, tables,
  accessibility, responsive — becomes the package's `DESIGN.md`. Each app's
  `DESIGN.md` keeps only what is its own and points to it.
- Possibly the `AppShell` (sidebar, mobile top bar, account menu) once both
  shells have converged; not in the first release.

Out of the package, in their app: every business component (`QuestionPlayer`,
`EvaluationGrid`, `AssignmentRunner`, `RosterImport`…), every screen, the API
client, the router, and `@quiz/ui`, which becomes a consumer of the shared
primitives rather than a second copy of them.

### 3. The rules of the package

- **No string of its own.** Every word a primitive shows arrives as a prop,
  already translated by the app (Quiz invariant 1, N-I18N-01). The package
  has no i18n dictionary and no locale.
- **React and react-dom are peer dependencies**; the package depends on
  nothing app-specific and never imports an app.
- **Semantic tokens only**, no `dark:` variant in a component: the tokens
  swap by themselves under `html.dark`.
- **Built to ESM with its type declarations, class names left intact**, so
  the consuming app's Tailwind can scan it: each app's `style.css` imports
  `@heig-platform/ui/tokens.css` and lists the package in its `@source`.
- **Every primitive is tested there** (Vitest, jsdom, Testing Library, as
  both apps do), and a gallery page serves as its visual check.

### 4. Versioning

Semantic versioning, with changesets. A change that alters a prop, removes
an export, or changes a token's meaning is a major version. The apps depend
on a caret range, the lockfile pins the exact version, and Dependabot opens
the bump in each app, which then passes that app's own checks before
reaching its staging (ADR-028). Each app adopts a release when it chooses.

To develop a primitive against a real screen, the app points the dependency
at a local checkout (`pnpm link`), never committed.

### 5. The rule for new code

Before writing a generic primitive in either app, look for it in
`@heig-platform/ui`; if it is missing and generic, add it there. A primitive
written locally while the package catches up is marked as a candidate and
moved at the next release.

### 6. Migration, in order

1. Create the repository; extract the tokens and the reconciled shared
   primitives; publish `0.x`.
2. Quiz adopts it: `apps/web/src/ui/` re-exports from the package, the
   imports then move to it screen by screen, and `@quiz/ui` rebases its
   primitives (`button`, `card`, `badge`) on the shared ones.
3. Classroom does the same.
4. `1.0` when both apps run on it with no local copy of a shared primitive
   left.

## Consequences

- One fix, one place: an accessibility or layer bug fixed in the package
  reaches both apps with a version bump.
- A change to a primitive now costs two pull requests — the package release,
  then the bump in the app — instead of one. That is the price of two apps
  evolving independently, and it is accepted.
- An app's build depends on the npm registry for one more package. The
  lockfile and the frozen install make that dependency exact; it adds no
  exposure the other public dependencies do not already have.
- The agent skills (`quiz-ui`, `hgc-ui`) will point to the package's
  `DESIGN.md` for the generic rules and keep only what is app-specific.

## Rejected alternatives

- **GitHub Packages.** Its npm registry requires authentication even to
  install a public package: a token in CI, a build secret in the Docker
  build, and read access granted package by package to each consuming
  repository. The public npm registry needs none of that.
- **A git dependency** (`github:heig-tin-info/heig-platform#v1.2.0`). No
  version ranges, a build on every install, and no Dependabot bump worth the
  name.
- **A git submodule, or copying the source on each release.** Either brings
  the source back into each app, where it drifts again — the problem this
  ADR exists to end.
- **Merging Quiz and Classroom into one monorepo.** It would give a shared
  package for free, at the price of coupling two products deployed, operated
  and reviewed separately, each with its own concurrent agents
  (`AGENTS.md`).
- **Hosting the package in one of the two app repositories.** The other app
  would then depend on its CI, its release rhythm and its review.
