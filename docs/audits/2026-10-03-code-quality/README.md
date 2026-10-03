# Source quality audit and refactoring plan

**Baseline:** `59c8925a7fee4bee9bcb2664bf2cdde781468cd0`, 2026-10-03.
**Scope:** analysis only; no application, test, dependency, configuration or ADR changes.
This is a separate change from the ADR/specification organization PR.

The codebase has a sound overall modular-monolith structure and substantial existing
reuse. Its principal maintenance costs are **concentrated responsibilities in a few
services/components and runtime cycles between API service facades**. There is no
measured basis for a general rewrite or a claim that 10–20% of the source can be
removed safely. Small, verified duplicate extractions are available; splitting
responsibilities often adds explicit interfaces and therefore increases line count.

## Findings at a glance

| Dimension | Assessment and evidence | Work |
|---|---|---|
| Cyclomatic complexity | 52 of 11,171 runtime function nodes score above 20; maximum 48. Concentrated in editor/parser gestures, orchestration and JSX-heavy screens. Nested callbacks are measured independently. | [Every >20 hotspot](hotspots.md); A3, PKG-01, W6, conditional grammar/view work |
| Modularity | Workspace value-import direction is acyclic. Five file-level SCCs are confined to API; four involve services/composition, one is schema FK declarations. | A1a–e; retain lazy schema relationships unless an initialization defect is shown |
| Responsibilities | `live/attempt.ts`, `results/service.ts`, question host wiring and JournalReader mix concerns that already have separable consumers. | A2a/b, W5/W6, PKG-06 |
| DRY | Exact-token scan finds 14 clone pairs, touching 415 distinct physical lines across 19 files. Overlaps, necessary call-site glue and preserved originals mean 415 is **not** removable LOC. | A5a, W2/W10, PKG-02/04; conditional wrappers |
| SSOT | Shared contracts/domain/query keys already provide strong owners. Remaining repeated poll tally schema, case cap, MCP field constraints and poll eligibility are concrete drift risks. | A5b/c, PKG-05/08 |
| KISS | Existing focused helpers are preferable to generic form, route, repository, player or workflow frameworks. A complex grammar or safety refusal is not improved by hiding its branches. | Constraints on every work item; explicit retain decisions |
| YAGNI / dead code | One two-line unused compatibility re-export is confirmed. Zero value-import fan-in also finds entrypoints, type contracts and accepted future delivery; it is not proof of dead code. | A5d; retain planned M3-07 adapter and typed activity contract |
| Correctness found while auditing | Menu scroll target handling, denied session storage and screenshot failure/cleanup deserve focused fixes. Unknown server-message localization needs a policy-aware correction. | W1/W3/W4/W7, separate from behavior-preserving refactors |
| Tests and operations | Existing real-migration tests, boundary filtering tests and worker caps are strengths. Coverage floors are configured, not measured results of this audit. Staging GitHub isolation remains pending M2-06. | Preserve test guarantees; Q1/Q2; existing M2-06 dependency |

## Measured baseline

| Classification | JS/TS files | Physical lines | Token-bearing lines | Function nodes | CC > 10 | CC > 20 |
|---|---:|---:|---:|---:|---:|---:|
| Runtime declarations/implementation | 895 | 187,794 | 134,024 | 11,171 | 297 | 52 |
| Tests, helpers and browser mocks | 618 | 135,074 | 111,361 | 15,921 | 36 | 12 |
| Tooling, seed and configuration | 38 | 6,766 | 5,195 | 577 | 10 | 3 |

All 1,551 tracked JS/TS files parsed without syntax diagnostics. Runtime median CC is 1,
mean 2.43; nearest-rank p90/p95/p99 are 5/8/15. These are descriptive figures, not
maintainability grades: many callbacks are short and JSX conditions raise CC.
Physical lines include comments/blanks; token-bearing lines still include types,
Zod schemas and translated content. Neither is a count of executable statements.

The complete inventory includes 3 apps, 15 workspace packages, the kiosk extension,
scripts, test support and non-JS/TS configuration. See [inventory](inventory.md) for
scope and classification. Automated coverage is exhaustive for the defined JS/TS
metric. Manual review follows risk, dependencies and findings; it does not claim
line-by-line behavioral verification of every source/test file.

## Reduction potential

The ready, directly supported small extractions total approximately **84–140 net
runtime physical lines**: API naming/schema/list/shim work, web panel/shortcut reuse,
the shared numeric heap and poll tally schema. A typed circuit-field prototype and
opportunistic canonical serialization sharing could bring the identified set to
**134–235 lines**, subject to their acceptance gates. Development screenshot helpers
have a separate 20–50-line opportunity; tests and fixtures are not counted as savings.

These estimates are hypotheses derived from replacing specific repeated spans with
one implementation **plus** imports/types/calls. They are not measured refactor diffs,
not an upper bound on future discoveries, and not a promise of net repository shrinkage.
Correctness fixes, responsibility boundaries and characterization tests can outweigh
these deletions. A campaign target expressed as a percentage of the entire repository
would encourage deleting useful safeguards, prose, translations or tests.

The more valuable target is to let a maintainer change one behavior without loading
an unrelated service facade or several hundred lines of UI orchestration. Track
relevant responsibility size, dependency cycles and behavior preservation alongside
net source delta; never count file moves as deletion.

## Evidence

- [Ordered, exhaustive catalogue of identified work](plan.md): ready, conditional,
  existing pending work, dependencies, stopping rules and acceptance gates.
- [API findings and directory disposition](api.md).
- [Web findings and directory disposition](web.md).
- [Packages, runner, extension and operational findings](packages.md).
- [All 52 runtime functions above CC 20](hotspots.md), including explicit retain/triage decisions.
- [Method and executable measurement appendix](methodology.md).
- Machine-readable [file inventory](metrics/files.csv),
  [functions above CC 10](metrics/complexity-over-10.csv),
  [exact clone pairs](metrics/exact-clones.csv),
  [value-import SCC membership](metrics/value-import-cycles.csv),
  [area dependencies](metrics/area-dependencies.csv) and
  [other tracked code/configuration](metrics/other-files.csv).

Source paths and line numbers refer to the baseline above. The work catalogue is
exhaustive for findings established by this audit, not a claim that static analysis
has discovered every possible future defect. Candidate investigations are labeled
and have no booked savings.

## Validation and boundaries

The measurement implementation was checked on fixtures for nested functions,
short-circuit/nullish assignments, loops/catch/switch, optional chains and type-only
imports. All local source and workspace imports resolve; four remaining relative
imports are known CSS/SVG assets. File SCCs exclude `import type` and `export type`.
Comments including JSDoc are excluded from token-based line/clone counts.

No application tests were added or executed for this read-only audit. The identical
runtime baseline was previously validated in the isolated ADR worktree: build,
typecheck and 7,750 passing tests (API also has one expected failure and one skipped
test). That is baseline evidence, **not** validation of any proposed refactor.
This PR validates its measurements, documentary links, data consistency and docs build.
It neither measures production performance nor performs a penetration test.

No product question is settled. Retain the existing student-content filters, clock,
access predicates, runner isolation, token handling, grade history and notification
failure semantics. Pending M2-06, M3-07 and other accepted delivery tasks must not be
removed as speculative code merely to improve a line-count metric.
