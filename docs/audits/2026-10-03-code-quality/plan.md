---
search:
  exclude: true
---

# Refactoring work catalogue

> Snapshot of baseline `59c8925a` (2026-10-03). Paths and line numbers drift as
> `main` moves: re-measure before acting on a row.

[Audit overview](README.md). Baseline `59c8925a`. **Nothing below is implemented by this PR.**
The catalogue covers every established finding and measured high-complexity group;
uncertain opportunities remain investigations, not pre-approved deletions.

P1 = first targeted work for correctness or a costly maintenance boundary.
P2 = useful bounded cleanup after prerequisites. P3 = opportunistic or conditional.
Size S = one narrow change; M = one concern across several consumers; L = split into
multiple reviewable changes. Sizes are scope indicators, not time promises.
Detailed paths, behavior constraints and suites are in the linked domain reports.

## Ready work, one independently reviewable change per row

| ID | Priority / size | Concrete change / evidence | Depends on | Acceptance and outcome |
|---|---|---|---|---|
| W1 | P2 / S | Guard menu scroll target before `Node.contains`; [web W1](web.md#w1-p2-correctness-menu-scroll-event-assumes-a-node). | None | Window and panel-scroll regression cases; preserve opening grace. Correctness, 0–2 added lines. |
| W3 | P2 / S | Make student-view session storage tolerate denied access; [web W3](web.md#w3-p2-correctnessresilience-student-view-storage-differs-from-other-remembered-ui-choices). | None | Preserve tab-local state, enter/leave and ordinary reload behavior; denied get/set/remove do not crash. +10–25 lines. |
| W4 | P2 / S | Make screenshot failures affect exit status and guarantee cleanup; [web W4](web.md#w4-p2-test-tool-correctness-screenshot-errors-do-not-fail-process-cleanup-is-asymmetric). | None | Failing scene/screenshot produces nonzero status; browser/context close in all paths. +5–20 tooling lines. |
| A5a | P2 / S | Share pool name collision selection, keeping copy/keep formatting; [API A5](api.md#a5-minor-two-confirmed-local-single-source-of-truth-cleanups). | None | Case-insensitive, deleted-name, collision and unique-constraint race behavior retained. 12–22 runtime lines removed. |
| A5b | P2 / S | Reuse contract difficulty/tags schemas in MCP tools; API A5. | None | Required/optional semantics, tool descriptions and scope restrictions unchanged. 2–8 lines removed. |
| A5c | P2 / S | Use the existing poll eligibility schema/list consistently in `questionPicks`; API A5. | None | Only mcq/short, parameterized exclusions unchanged; no dynamic capability registry. 1–3 lines removed. |
| A5d | P3 / S | Remove unused `modules/kiosk/limiter.ts` compatibility re-export. | Repeat reference search at implementation | All consumers still use root limiter; typecheck passes. 2 lines removed; no broader dead-code claim. |
| PKG-05 | P2 / S | One named code-case cap in schema and generator; [packages](packages.md). | None | Cap and cap+1 agree; no unrelated numeric limits merged. About line-neutral. |
| PKG-08 | P2 / S | Use PollTally schema in SSE envelope; packages. | None | Identical accepted/rejected payloads; staff-only emission unchanged, no new import cycle. 4–8 lines removed. |
| W2 | P2 / S | Share horizontal panel clamp/ResizeObserver lifecycle; web W2. | W1 | Viewport, font resize, alignment and animation checks; retain different scroll policies. 20–35 lines removed. |
| W10 | P3 / S | Share palette Ctrl/Meta+K protocol; web W10. | None | Modifiers, input focus, disabled gate and cleanup preserved. 8–15 lines removed. |
| PKG-02 | P2 / S | One numeric min-heap for diagram and circuit routers; packages. | None | Same tie/empty behavior and router goldens; existing neutral dependency only. 35–45 lines removed. |
| A1a | P1 / M | Cut LLM gateway↔service facade cycle using a private settings/ledger leaf; [API A1](api.md#a1-major-service-facades-participate-in-real-runtime-dependency-cycles). | Capture import graph baseline | Gateway budgets/reservations/settlement unchanged; two-file SCC gone, facade API stable. |
| A1b | P2 / M | Separate ticker observation from task composition; API A1. | Capture graph baseline; open question 37 (`expireSuperPowers` in `TICK_TASKS`) stays as it is | System/ticker SCC removed or reduced for the targeted edges; health state/timer behavior unchanged. |
| A1c | P2 / M | Notification recipients read the course seat by a join on org's table instead of importing org's facade; API A1. | Capture graph baseline; after the course owner/assistant roles change, which reworks seats | No notification→org cycle for this predicate; same role/recipient resolution; no import of a non-`service.ts` file of another module. |
| A1d | P2 / S | Guards compute trusted clients with `trustedClientsOf` (`@quiz/domain`) instead of importing evaluation's facade; API A1. | Capture graph baseline | Guards stop loading writes through the predicate; confinement and Super Powers suites pass. |
| A1e | P2 / L | Untangle grading/results observation/read calculations; API A1. | Draw execution/transaction sequence first; coordinate A2b | Keep single grading write and before/after released-grade observation; no new event bus or hidden async ordering. |
| A3 | P1 / M | Isolate evaluation patch preparation from persistence; [API A3](api.md#a3-major-patch-policy-and-projection-are-mixed-in-one-db-write-function). | Characterize patch combinations | Preserve absent/null, legacy-invalid rename, retakes, feedback, kiosk and scheduling rules. No Drizzle types in domain; likely +10–50 lines. |
| A2a | P1 / M | Move student-home reads and item projection out of live/attempt; [API A2](api.md#a2-major-live-attempt-and-results-services-still-combine-distinct-responsibilities). | Map A1e boundaries | Keep transactional create/retake/close together and service API stable; filtering, frozen instances and attempt IDs unchanged. |
| A2b | P1 / M | Separate student feedback/read models from results publication lifecycle; API A2. | Coordinate A1e, characterize release/regrade | No visibility/cache/justification leak; same withdrawn/released grade semantics. Moving hundreds of lines is not deletion. |
| A4a | P2 / M | Separate auth identity/cookie helpers from registration hook; [API A4](api.md#a4-moderate-authentication-hook-and-sse-lifecycle-have-separate-orchestration-concerns). | Characterize auth order | Preserve bearer precedence, token audiences, cookies, SEB/kiosk/impersonation semantics; no auth framework. |
| A4b | P2 / M | Give SSE stream resources one lifecycle owner; API A4. | Characterize watch authorization and close order | Preserve join-before-snapshot, revocation, clocks, delegated absence, backpressure and idempotent cleanup. |
| A6a | P2 / M | Separate poll launcher read bundle from pure aggregation/projection; [API A6](api.md#a6-moderate-poll-read-aggregation-and-github-administration-have-overly-broad-files). | A5c | Same historical population/sorting/privacy; grouped queries remain grouped, no N+1 reads. |
| W5 | P2 / M | Separate question host dictionaries, rehearsal adapters and host rendering; web W5. | Capture existing lazy chunk boundaries | App-owned wiring remains in app; client entries retain lazy loading and typed injected surfaces. −10 to +25 lines. |
| W6 | P2 / M | Separate journal staff action/dialog orchestration from reading; web W6. | Existing journal/api hooks retained | Staff/student cache isolation, GitHub read-only mode, conflicts and home redirect unchanged. −10 to +30 lines. |
| PKG-01 | P1 / M | Extract diagram-local gesture transitions/adapters; packages. | Characterize gestures/history | Pointer cancellation, read-only pan, drag/double-click, one undo per gesture unchanged; do not share circuit engine. Often adds 30–100 lines. |
| PKG-06 | P2 / M | Separate pure locked-layout rules from Monaco/React lifecycle; packages. | None | Same edits/IME/paste/undo/fallback/line mapping; server reconstruction remains authoritative. Typically +5–20 lines. |

A1 subchanges jointly have approximately −20 to +80 runtime-line movement overhead;
A2 subchanges jointly −40 to +100. Those ranges are **not** separate deletion budgets
per row. Acceptance is architectural/behavioral, not a reduction quota.

## Conditional investigations and policy-sensitive changes

| ID | Priority / size | Investigation / trigger | Gate before implementation | Stopping rule / accounting |
|---|---|---|---|---|
| W7 | P2 / M | Review unknown API error rendering in French UI against journal fallback. | Inventory diagnostic versus user-authored payloads; preserve product-sanctioned detail. | Fix translation behavior with focused tests; not a pure refactor, no booked savings. |
| PKG-03 | P2 / S prototype | Typed local SourceFields/AnalysisFields helper for numeric inputs. | Demonstrate same discriminated types, limits, labels, disabled and invalid-draft behavior without casts. | Keep explicit code if helper is longer/opaque. Conditional 45–80 lines removed. |
| PKG-04 | P3 / S | Share code/codeimage program canonical mapping when serialization changes. | Same defaults, omission semantics and independent schemas, no generic serializer. | Only 5–15 lines; defer if typed helper outweighs benefit. |
| PKG-07 | P3 / M | Separate declaration/link recognition when PlantUML grammar next changes. | Golden/error/line-number equivalence; no widened grammar. | No parser framework; no deletion budget. |
| W8 | P3 / S prototype | Share screenshot capture lifecycle primitives after failure semantics are fixed. | W4; test ordinary/modal/mobile/signed-out scenes in each harness. | Retain distinct scene/auth/layout logic; 20–50 tooling lines only if helper stays smaller. |
| W11 | P3 / S | Share preview/feedback review body if a third consumer or recurring drift appears. | Preserve visibility/comment/machine-status differences outside the shared host. | Current two sites may stay explicit; optional 0–10 lines, not booked. |
| PKG-09 | P3 / S | Plain prompt/issue wrapper across rich/diagram/categorize editors. | Existing `PromptSection` card styling must not change these forms; prop/API cost measured. | Optional 10–25 lines; no new form framework, not booked. |
| A6b | P3 / M | Split GitHub installation/admin/avatar responsibilities when next changed. | Concrete independent consumer/change; preserve cache TTL/invalidation. | Mere 805-line file size is insufficient; no booked savings. |
| Q1 | P2 / S | Retain reproducible baseline and add a small architecture/complexity check in a later code PR. | Choose minimal tooling; type-only imports, assets, schema SCCs and intentional boundaries handled. | Ratchet new violations, not a blanket CC≤10 rule or mandatory framework; tooling can add lines. |
| Q2 | P2 / S | Record focused behavior/coverage evidence before each structural PR. | Use existing suites and coverage configuration; add only missing externally observable cases. | Floors are not current measured coverage; never weaken tests to meet a size target. |
| Q3 | P3 / M triage | Review remaining measured hotspots when their area changes; [52-function disposition](hotspots.md). | Prove a separable responsibility or repeated policy; check JSX/nullish contribution. | No automatic function splitting, table dispatch, dead-export deletion or speculative savings. |

## Existing pending work, outside this refactoring campaign

- **M2-06:** production/staging GitHub App separation and safe staging restore.
  Current export/refresh scripts are not complete isolation for GitHub installation
  identifiers. This is already marked todo in merge progress. Complete its explicit
  safety requirements before that operational use; do not count it as a LOC saving.
- **M3-07:** `github/sync.ts` is an imported adapter with a planned consumer. No current
  value import is not a reason to delete it without resolving that delivery task.
- Open questions Q22, Q29, Q37 and Q40–42 constrain timing, diagram/circuit convergence and
  parameter rules. This audit does not choose answers. A later proposal changing them
  requires a separate product decision; this PR changes no ADR.

## What to retain

- Pure domain rules and shared contract schemas; explicit per-kind student allowlists.
- Static separate server/client registries, local typed route tables and central cache-key factories.
- Session-kind checks, safety refusals, server clock and receipt-time gates, grading history,
  idempotence/CAS/leases, LLM reservations and at-most-once/best-effort delivery boundaries.
- Lazy schema FK relationships; clear exhaustive switches for grammars, geometry and validators.
- Distinct attempt/preview/poll protocols, code/circuit routers, journal staff/student rendering,
  and browser/server execution trust boundaries.
- Translation dictionaries, migrated SQL history, generated migration snapshots and isolation tests.
- Existing domain-specific fixtures; fresh migrated DB copies instead of shared mutable test state.

These are explicit dispositions, not gaps to fill by creating a generic framework.

## Suggested sequence and validation contract

1. Separate W1/W3/W4 correctness fixes; then small independent SSOT/clone changes
   A5a–d, PKG-05/08/02, W2 and W10. No broad structural edits in those PRs.
2. A1a–d dependency cuts, each measured against the baseline. Characterize A3 and
   PKG-01, then perform their extractions independently.
3. Coordinate A1e/A2a/A2b as small successive changes; never combine all grading,
   attempt and result code moves into a single review. W5/W6/PKG-06 can proceed separately.
4. Auth and SSE orchestration A4a/b receive their complete security/lifecycle suites;
   A6a keeps database-query behavior observable.
5. Only pursue conditional prototypes when their acceptance gates show a real gain.
   Remaining grammar/view complexity is maintained explicitly unless Q3 establishes more work.

For every implementation: pin/re-measure the then-current base, show source delta
separately from tests/tooling/moves, state preserved public interfaces, and identify
changed dependency edges. Run impacted existing suites while iterating. Before merge,
run build/typecheck and one full sequential suite with capped workers; UI changes also
need the repository's browser/visual workflow, runner changes their container checks.
No migration or new runtime dependency is needed by the ready refactoring set.

Stop a proposed extraction if it needs a generic framework, obscures policy, increases
coupling or has more adapters than the duplication it removes. Responsibility work may
legitimately grow code, but must demonstrate smaller coherent consumers and unchanged
behavior. This catalogue authorizes no implementation by itself: the current request
is the audit and plan only.
