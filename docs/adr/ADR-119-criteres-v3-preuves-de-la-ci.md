# ADR-119 — Criteria v3: the CI produces the evidence, the platform publishes the schemas

## Status

Proposed (2026-10-26). The ten product decisions are the **product
owner's** (2026-10-26, numbered 1–10 below where they are cited); the
schemas, the run's acceptance checks and the migration's arithmetic were
fixed by the orchestrator from them, after the spec challenge of the same
day, and refined after StudentScore 1.0's implementation (numbers-only
maxima, `rationale` ignored, rounding, the command's directory, the
default-branch check, the 1.0 `GRADE`). Orchestrator's choices, each the
smallest option where the owner's decisions left a detail open:

- (a) the schemas are static files of the web app, `/schemas/criteria-3.json`
  and `/schemas/results-1.json` (production
  `https://quiz.chevallier.io/schemas/…`), whose text lives in
  `packages/contracts/schemas/` (§2);
- (b) `results.json`'s `$schema` is optional and never read; unknown
  top-level keys are ignored; a malformed entry, a file over its cap or
  without a `criteria` object counts as a missing result (`no_result`); a
  `log` over 8 KiB keeps its last 8 KiB (§4);
- (c) the protected files are compared against one sha the distribution
  handed out (its build or a sync, ADR-073), all files of one comparison
  from that same sha; the default branch's head is read as the run's
  `head_sha`; a file added under a protected directory makes the trees
  differ, and the restore (F-PROJ-08) is unchanged: it never deletes a
  student's file (§6);
- (d) a run is read whatever its conclusion, provided its artifact
  `results` exists; the platform waits 24 h after a dispatch, then writes
  `no_result` (§6);
- (e) the nonce is 128 random bits stored with the pass's claim in
  `grade_dispatches`; a Regrade that dispatches sends a new one and the old
  one is no longer accepted (§6);
- (f) dispatches go through the `project.dispatch` queue at a configured
  pace, by default one every 15 s per App installation (§6);
- (g) the artifact's download is capped at 1 MiB, its one entry inflated to
  at most 256 KiB, counted while inflating (§6);
- (h) an automatic row's rationale is its fraction (`7.5/10`); the `log` is
  staff-only, shown on the grading screen, never in the student payload (§5,
  §9);
- (i) the commit graph is read on demand through the App, cached as the
  repository's live state (F-PROJ-13), never stored (§8);
- (j) the creation preview extends `GET …/classrooms/:id/projects/sources/:repo`
  with a `branch` query; creating in `criteria` mode with a file that does
  not parse is refused `422` with the parser's errors (§9);
- (k) choosing `criteria` adds `.github/workflows/` and `criteria.yml` to
  the protected list; the platform never inspects the workflow's content (§6, §9);
- (l) the migration converts only scores out of 6 (any other maximum was
  already read linearly), clamped to `[0, 5]`, and stores the released grade
  of the repositories of projects released before it (§11);
- (m) a Regrade dispatches only when the pass has no accepted results; it
  otherwise reuses them and re-runs the LLM pass (§6);
- (n) a `criteria` project still shows no "final reviews dispatched" notice
  (F-PROJ-21), though it now dispatches its graded runs.

Scope: how a project in the `criteria` grading mode gets its automatic
evidence (the repository's CI, answering a dispatch of the platform), the
format of its criteria and of the run's result, the inputs of its LLM pass,
its git criteria, its creation panel; the removal of the runner's `project`
action and of the `score_is_grade` scale, and the data migration they need.
Projects in `auto` and `none` mode keep their behaviour (decision 7),
except that the `score_is_grade` scale leaves every project (§11).

Relations: **supersedes in part**
[ADR-106](ADR-106-notation-des-projets-par-criteres.md): §1's refusal of
commands that need the network; §2's kinds of criterion (`testsCriterion`,
`test:`, `identityCriterion` and the schema v2 file); §3 whole (the
evidence run in `apps/runner`, its overlay and its stored outputs); §4's
inputs (the sources and the JUnit summary become the sources and the logs
of `results.json`); §7's scale reference (`projectGrade` with
`score_is_grade`); the rejected alternative "CI artifacts as evidence"; and
the 2026-10-12 amendments ADR-106 made to [ADR-007](ADR-007-runner-self-hosted.md),
[ADR-016](ADR-016-runner-sur-vm-separee.md) point 2,
[ADR-101](ADR-101-budget-du-runner.md) and the overlay use of
[ADR-062](ADR-062-depot-de-distribution.md) addendum 1. Amends ADR-106
§1's "never automatically" for the creation form only (§9). Amends D05's
addendum (`docs/merge/08-decisions.md`, the scale preset); F-PROJ intro,
F-PROJ-01, -08, -10, -11, -14, -21, -23 to -26 (docs/spec/02); N-SEC-21,
N-DATA-03, N-DATA-05 (docs/spec/03); 05 §5.5, §5.7, §5.11; open questions
43 and 52(a) (docs/spec/06). Proposes the wording of `CLAUDE.md`
invariants 12 and 14 (§13) and adds `sig=` to invariant 15's redaction.
Builds on [ADR-012](ADR-012-gel-note-deux-temps.md) (receipt time),
[ADR-064](ADR-064-echeance-des-projets-baux.md) (effective deadline,
freezes), [ADR-058](ADR-058-passerelle-llm.md) and
[ADR-063](ADR-063-correction-llm.md) (as ADR-106 amended them, unchanged).

## Context

ADR-106 (2026-10-12) took the grading of a lab onto the platform: the
criteria as data, an evidence run in `apps/runner`'s `project` action on a
`lab-c` image with the network closed, a platform LLM pass, rows the
teacher validates. Two weeks of use showed its cost:

- **The platform had to know each lab's toolchain.** The evidence run could
  only run what the `lab-c` image held (gcc, make, python3, pytest), with
  the project's `buildCommand`, `testCommand` and `evidenceOutputs`; a lab
  in another language, or one needing a package, needed a new platform
  image. The automatic criteria could only be shares of passed JUnit cases
  (`testsCriterion`, `test:`).
- **Identity was graded by bespoke code.** `identityCriterion` (#820)
  graded who committed from commit metadata the evidence job read, a rule
  the platform had to own for one kind of criterion.
- **The scale preset `score_is_grade`** existed because StudentScore 0.7.5
  emitted a mark out of 6 where every other contract says points out of a
  maximum (F-PROJ-10, `docs/guide/projects.md`).

The labs already run in GitHub Actions on the CI runners of ADR-007, which
install what each lab needs. What the platform must own is not the
toolchain but the format: what a criterion is, what a run's result is, and
the checks that make a result the one the platform asked for.

The only live projects in `criteria` mode are `labo-04-pcb` (published, 26
repositories) and `labo-03-darts` (draft); `labo-00`, `-01`, `-02` and
`linked-list-2` are released (decision 10).

## Decision

### 1. What stays of ADR-106

Unchanged, and still ADR-106's: the opt-in `criteria` mode and when it may
be switched (§1, without its network refusal); the snapshot read from the
**distribution** at the switch, the publication, each sync and *Reload from
source* (§2, the file now v3); the target commit — the last commit received
before the repository's effective deadline that no bot pushed, at the
checkpoint's date for a milestone (§3); the tarball fetch at that sha, its
`token=` redaction, its size cap and the stripping of its top-level
directory (§3), now for the LLM pass only; the no-evidence reasons
`no_commit`, `archive_too_large` (the LLM's sources), `repo_missing`; the
retention rule (§3, its object renamed in §6); the LLM pass, its purpose,
budget, masking, failures and Regrade caps (§4, its inputs replaced in §7);
the rows of `project_criterion_grades` and their states (§4); milestones as
checkpoints and their locks (§5); the final pass at the definitive freeze
and the report rendered on read (§6); the final-score order with the
`criteria` source and its clamp (§7, without the scale preset); the grading
screen and the release gate (§8); the student view (§9).

### 2. The platform publishes two schemas (decision 1)

The platform is agnostic of the teacher's tools: it publishes the format of
the criteria and of a run's result as two JSON Schemas (draft 2020-12),
served by the web app as static files at stable URLs:

- `/schemas/criteria-3.json` — `criteria.yml`, `schema_version: 3` (§3);
- `/schemas/results-1.json` — `results.json` (§4).

Their text lives in `packages/contracts/schemas/`, the one source; the web
build copies them to its public directory. A test of `packages/contracts`
runs the domain parser (§3) and the results validator (§4) and the JSON
Schemas over the same fixtures and fails when they disagree. A new
incompatible version gets a new file and number; a published file never
changes meaning. StudentScore (`heig-tin-info/score`) is one
implementation, not the definition.

### 3. `criteria.yml`, schema version 3 (normative)

```yaml
schema_version: 3
grading:            # optional, for the LLM (unchanged from v2)
  context: string
  student: {level, knows: [..], learning: [..]}
  sources: [plain paths; a directory with a trailing /; no wildcard]
criteria:           # a tree: a section is a mapping with an optional
                    # description and children; a leaf has max_points or bonus_points
  <section>:
    description: string
    <leaf>:
      description: string          # required; `desc` accepted as an alias
      max_points: number           # negative: a penalty
      bonus_points: number         # > 0, instead of max_points
      prompt: string               # optional: proposed by the LLM
      command: [argv, ...]         # optional, 1..20 strings, no shell: automatic
      milestone: tag               # optional, [a-z0-9][a-z0-9_-]{0,49}
      awarded_points: number       # optional, ignored by the platform (a tool's output)
      rationale: string            # optional, ignored by the platform (a tool's output)
```

- **The kind of a leaf**: a leaf with `command` is **automatic**, even with
  a `prompt`; else a leaf with `prompt` is **llm**; else it is
  **teacher-only** (no row until a teacher writes one, ADR-106 §8).
- **Strict**: an unknown key is an error, with its path (v2's `test`
  included). A leaf requires `description` (or `desc`) and exactly one of
  `max_points`, `bonus_points`; `bonus_points` is positive. Maxima are
  **numbers only**: v3 drops v2's percentages (`"50%"`), one semantics.
  A name (section or leaf) holds no dot and no space; a criterion's id is
  its dotted path. The totals keep ADR-106 §7's clamp.
- **Versions**: a file with `schema_version: 2` is refused with one error
  that names v3 and the schema's URL; there is no runtime support of v2. The
  stored snapshots of released projects stay as data, never re-parsed.
- **Parser**: the pure parser of `packages/domain` (ADR-106 §2) moves to v3
  and returns the normalised tree or the errors with their paths.

### 4. `results.json`, the result of a run (normative)

```json
{
  "$schema": "https://quiz.chevallier.io/schemas/results-1.json",
  "criteria": {
    "code.format": { "score": "1/1", "log": "..." },
    "tests.functional": { "score": "7.5/10" }
  }
}
```

- `criteria`: an object keyed by criterion id (§3).
- `score`: a string `n/m` matching
  `^\s*\d+(\.\d+)?\s*/\s*\d+(\.\d+)?\s*$`, with `m > 0`.
- `log`: an optional string, at most 8 KiB per criterion; the file is at
  most 256 KiB.
- The platform reads **only the `command` leaves** of the snapshot; an
  unknown id is ignored; a `command` leaf absent from the file, or whose
  entry is malformed, gets a 0-point `proposed` row with the reason
  `no_result`.

**How a command is run** (normative for any tool): its argv, no shell, a
timeout, the working directory the directory of `criteria.yml`, which must
be at the repository's root. Its result is the last non-empty line of its
stdout when that line matches `n/m` with `m > 0`; otherwise (`n/0`
included) its exit code: 0 is `1/1`, any other `0/1`; a command that cannot
start is `0/1`. `n > m` is left to the arithmetic's clamp (§5). Its `log`
is its combined stdout and stderr, cut to its tail.

### 5. The fraction arithmetic (decision 3)

A check's result is a fraction `n/m`, `n` possibly decimal, clamped to
`[0, m]`; `m ≤ 0` makes the result invalid (`no_result`). A leaf's points:

| Leaf | Points |
| --- | --- |
| positive `max_points` | `max × n/m` |
| penalty (negative `max_points`) | `max × (1 − n/m)` |
| `bonus_points` | `bonus × n/m` |

A penalty fully passed (`m/m`) costs nothing; fully failed, its whole
value. Each leaf's points are rounded to 0.01, half away from zero (never
to a half point, and not JavaScript's `Math.round`, which rounds a negative
half toward zero), before the totals of ADR-106 §7 add them. The row's
rationale is the fraction itself (choice h).

### 6. The graded run (decisions 2, 7)

**The shim.** A lab repository's `.github/workflows/grading.yml` is a
constant, protected file that carries no lab information (the commands are
in `criteria.yml`):

```yaml
name: grading
on:
  push:
  workflow_dispatch:
  repository_dispatch:
    types: [quiz-grade]
run-name: grading ${{ github.event.client_payload.nonce || github.sha }}
jobs:
  grading:
    uses: heig-tin-info/score/.github/workflows/run.yml@<sha of 1.0.0>   # pinned by sha
```

The reusable workflow is pinned **by commit sha**, never by tag or branch,
so a moved tag changes nothing. The platform does not inspect the
workflow's content (choice k): any workflow at that path that answers the
dispatch below is valid.

**The dispatch.** At a repository's definitive freeze (the final pass,
ADR-106 §6) and at a checkpoint (a milestone pass, ADR-106 §5) the ticker
claims the pass in `grade_dispatches`, as ADR-106 does, and a
`project.dispatch` job sends `repository_dispatch` with `event_type:
quiz-grade` and `client_payload: { sha, nonce, pass: "final" | "milestone",
milestone? }` — `sha` the target commit (§1), `milestone` the checkpoint's
tag. GitHub runs a `repository_dispatch` workflow from the **default
branch's head**, not from the target: the workflow checks out
`client_payload.sha`, runs the tool, uploads **one** artifact named
`results` holding `results.json`, and its `run-name` carries the nonce.
Dispatches are **staggered** (choice f): the CI runners of ADR-007 are
shared, and a freeze of 100 repositories must not queue 100 runs at once.

**Acceptance.** The platform accepts a run, found by its `workflow_run`
event or by the reconciliation (ADR-011), only if all of these hold:

- its workflow's path is `.github/workflows/grading.yml`;
- its event is `repository_dispatch`;
- its triggering actor is the App's bot (a student holding write access can
  send a dispatch with a token of their own, or re-run a run: neither is
  the App's);
- its `run_attempt` is 1 (a re-run is never accepted);
- its `run-name` carries the pass's nonce;
- the protected files — all of `.github/workflows/`, `criteria.yml` and the
  project's protected list — are the distribution's at the **target sha**
  (choice c), which covers the code and the `criteria.yml` the tool read;
- `.github/workflows/` is also the distribution's at the **default branch's
  head** the run executed (its `head_sha`): GitHub runs a dispatched
  workflow from there, and App commits — a restore, the deadline's empty
  commit — or a later push may have moved it past the target.

**The checked-out sha** is verified through what ran, not through the
run's log: the workflow that ran is the protected shim (checked at
the default branch's head), which checks out `client_payload.sha` by a
reusable workflow pinned by sha, and the nonce binds that payload to the
platform's pass. `results.json` carries no sha of its own: a direct check
would need a field the schema does not have.

**Reasons**, shown to the staff on the grading screen, never to the student
(ADR-106 §9): `ci_tampered` (a protected file differs, at either sha);
`no_result` (no accepted run within 24 h of the dispatch — choice d —, no
artifact, an artifact refused below, a leaf missing or malformed);
`ci_unavailable` (the repository is archived, Actions cannot run: nothing is
dispatched, the teacher grades). With `no_commit` and `repo_missing` they
are 0-point `proposed` rows on the automatic criteria of the pass.

**The artifact.** Downloaded through the App, whose `actions: read`
permission it already holds; no new App permission. GitHub answers with a
redirect to a signed blob URL carrying `sig=` and `se=`: that URL is never
logged, stored nor put in an error payload, and the redaction learns `sig=`
(invariant 15, as it learned `token=`). The zip is size-capped (choice g),
holds exactly one entry, `results.json`, at its root — no directory, no
`..`, no absolute path, no link —, and is inflated under a byte budget that
stops a zip bomb. It is copied as soon as the run is accepted: artifacts
expire. The platform stores the validated `results.json` per (repository,
pass, run).

**Forgeability** (accepted by the owner): the student's code runs in the
same job as the tool and could rewrite `results.json`. The protected files
make the commands and the workflow the distribution's, not the student's
code's behaviour; the score stays **indicative** until the teacher
validates it (N-SEC-21), and the grading screen shows each criterion's log.

**Regrade** (ADR-106 §4, caps unchanged): it reuses the pass's accepted
results when they exist and re-runs the LLM pass; it dispatches anew, with a
new nonce, only when the pass has none (choice m).

**Push runs** stay indicative: the `GRADE` badge and the `auto` mode's
ingestion (F-PROJ-10) are unchanged (decision 7); the platform never reads
a push run's artifact.

**Retention** (N-DATA-03): the stored `results.json` replaces ADR-106's
evidence files under the same rule — deleted with the project, or six
months after its release —; the criterion rows stay.

### 7. The LLM pass's inputs (decision 4)

The LLM does static analysis only. Its inputs are:

- the sources `grading.sources` names, from the tarball the platform
  fetches itself at the target sha (§1);
- the `log` fields of the accepted `results.json` for the pass's `command`
  leaves, **masked**: `maskNames` over the roster and the repository's
  members (ADR-106 §4), plus the repository's name, which also masks the
  runner's work path `/home/runner/work/<repo>/<repo>`.

Never the full CI logs, never the commit metadata. The repository's content
and the logs are **data, not instructions**: the system prompt says so, they
are passed delimited as quoted material, and the reply is the strict JSON
schema of ADR-106 §4, clamped per criterion, for the llm criteria only — a
log cannot reach an automatic or a teacher-only row, and every proposal
waits for the teacher.

### 8. Git criteria and the commit graph (decision 5)

A criterion that judges the history — who committed, how the messages read
— is a teacher-only leaf (no `command`, no `prompt`). The grading screen
shows the selected repository's **commit graph** (choice i): the handed-out
branches' commits with their date, message, receipt time when the platform
has one (`push_receipts`), the App's and the handed-out commits marked, and
the author labelled **declared author** — git's author field, which anyone
can write. Staff only; never sent to the model, never in the student
payload. `identityCriterion` (#820) and its code (`commitIdentityPoints`,
`commitIdentityRationale`, the evidence job's commit read) are removed.

### 9. The creation panel (decisions 8, 9)

The first panel of a new project, once a source and its branches are
chosen, reads `criteria.yml` from the **source** through the hand-out
transform (`student/` overlay, `.studentignore`, F-PROJ-02) and shows:

- a **preview table** of the criteria, or the parser's errors with their
  paths;
- the `criteria` mode **preselected** when the file exists; the teacher
  confirms it by creating (this amends ADR-106 §1's "never automatically"
  for this form only: an existing project is still never switched);
- the **protected files** picked from the handed-out tree, by checkboxes; a
  directory protects its content. In `criteria` mode `.github/workflows/`
  and `criteria.yml` are **forced**: ticked and disabled, at creation and in
  the settings afterwards; switching an existing project to `criteria` adds
  them (choice k).

The binding snapshot is still the distribution's (ADR-106 §2), taken once
the distribution is built. On the project's settings, the segmented control
"Où travaillent les étudiants" (work mode, F-PROJ-19) is aligned right like
the other options (decision 9).

### 10. Removals (decision 6)

From the platform: `testsCriterion`, the `test:` leaves, `identityCriterion`,
`buildCommand`, `testCommand`, `evidenceOutputs` (settings, columns,
contracts, UI); the JUnit reading and the overlay of the evidence job;
`apps/runner`'s `project` action, its ceilings (`RUNNER_PROJECT_TIMEOUT_MS`,
`RUNNER_PROJECT_WORKDIR_MB`) and the `lab-c` image; the `score_is_grade`
scale (`PROJECT_SCALE_KINDS` keeps `linear` only; the setting leaves the
form). The rows of `project_criterion_grades` of released projects, those
of the removed kinds included, are kept as data.

### 11. The data migration (decision 6, 10)

Migrated now, no coexistence discriminator:

- **`score_is_grade`**: in every project that uses it, each stored score
  out of 6 (`g/6`, a mark) becomes its linear equivalent `(g − 1)/5`, clamped
  to `[0, 5]`, so that `1 + 5 · p/max = g` (choice l): the current, frozen,
  review, teacher and released scores and the runs' scores. A score whose
  maximum is not 6 was already read linearly (`fellBack`) and is unchanged.
  The project's scale becomes `linear`.
- **Released grades are frozen**: for every repository of a project
  released before the migration, the grade its release produced is stored
  and read in place of a recomputation (choice l), so that nothing moves
  what a student was given (as D05's addendum did at the import). A score
  changed afterwards still follows F-PROJ-14 ("changed after release").
- **`labo-04-pcb` and `labo-03-darts`**: their sources move to v3 and the
  shim; the snapshot is reloaded; `labo-04-pcb`'s 26 repositories receive
  the new protected files as App restore commits (L-06f).
- **`labo-00`, `-01`, `-02`, `linked-list-2`** (released): their rows,
  snapshots and stored evidence stay as data, under their retention.

A live project that used `score_is_grade` in `auto` mode and whose CI still
emits a mark (StudentScore 0.7.5) would have its next scores misread as
points out of 6: L-06b lists those projects before it migrates, and L-06f
moves their CI to StudentScore 1.0.

### 12. The `GRADE` contract

`::notice title=GRADE::<points>/<max>` is points out of a maximum, as
F-PROJ-10 and `docs/guide/projects.md` already say. StudentScore 1.0 emits
points: the points of the `command` leaves over the sum of their positive
maxima, capped at that maximum, and no `GRADE` at all when no `command`
leaf has a positive maximum; 0.7.5 emitted a mark, which only the removed
preset read.

### 13. Invariants

`CLAUDE.md`'s wording changes with L-06b, the PR that removes the action:

- **Invariant 12**: its sentence on the `project` action (ADR-106 §3) is
  deleted; the runner receives no archive.
- **Invariant 14**, its second sentence becomes: "A project's graded commit
  is the sha the server chose from its push receipts, sent in its dispatch
  and verified on the run it accepts (ADR-119 §6); its sources reach the
  model only from the server's own fetch at that sha, never uploaded by a
  client."
- **Invariant 15** gains `sig=` beside `token=` in its redaction, for the
  artifact's blob URL.

10, 11 and 13 are unchanged.

Delivery: task cards L-06a to L-06f (`docs/merge/09-tasks.md`,
`PROGRESS.md`).

## Consequences

- The platform owns the format, not the toolchain: a lab in any language
  runs what its CI installs; the runner keeps question code only, and its
  attack surface loses the archive form.
- Every automatic check is a command with a fraction, so an automatic
  criterion is no longer limited to JUnit shares.
- The evidence comes from a run in the student's repository, where the
  student's code runs beside the tool: weaker than ADR-106's overlay, which
  the owner accepts (§6); the acceptance checks shut out a dispatch, a
  re-run or a workflow that is not the platform's, and a tampered protected
  file is shown, not graded.
- The graded run depends on GitHub Actions: an archived repository, an
  organization with Actions off, a full CI queue or an expired artifact
  yields a reason and a teacher's row, never a silent zero.
- A file added under `.github/workflows/` before the deadline makes the run
  `ci_tampered`, and the restore cannot remove it (choice c): the teacher
  grades that repository.
- The LLM sees less (logs of the commands, not full outputs) and nothing of
  the history; git criteria cost the teacher a look at the graph.
- The scale preset leaves; projects that used it read linearly, with
  identical grades by construction, and their CI must emit points.
- Two schemas are now a public contract: changing one means a new version.

## Alternatives considered

- **Keep the runner's evidence** (ADR-106 §3): rejected (decision 2) — every
  lab language or package would need a platform image, and the platform
  would run the teacher's toolchain.
- **Send the full CI logs to the LLM**: rejected by the owner (decision 4);
  only the masked `log` fields of `results.json` go.
- **Keep `score_is_grade`, hidden from the form**: rejected by the owner
  (decision 6); `GRADE` has one reading, points out of a maximum.
- **A discriminator to run v2 and v3 side by side**: rejected by the owner
  (decision 10) — the two live projects are migrated now instead.
- **A `quiz.yml` configuration file in the repository**: not now — the owner
  is not convinced; `criteria.yml` carries the commands.
- **A separate job computing the results from raw artifacts** (JUnit,
  coverage) uploaded by the lab's job: rejected — it imposes a structure on
  the teacher's tools; a command's fraction is enough.
- **CI artifacts as evidence** (ADR-106's rejected alternative) is now the
  decision: the owner accepts the forgeability against the toolchain cost.
