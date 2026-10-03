[Audit overview](README.md) · [Ordered work catalogue](plan.md)

# API quality audit — 59c8925a

Read-only audit in `/tmp/heig-quiz-code-quality-audit`. No repository edits, dependency installation, tests or server runs. This is a refactoring plan, not a finding that current behavior is incorrect. AGENTS/CLAUDE and architecture conventions informed the review. The desired architecture remains a modular Fastify monolith, typed contracts, pure rules in domain, owning-module writes and real DB integration tests.

## Coverage and limitations

Every `apps/api/src` directory is inventoried below; import graph, AST complexity and exact-clone measurements cover the entire source tree. Manual review concentrated on public module boundaries, the large service files, highest-scoring functions, cycles, clones, security entrypoints and background infrastructure. This is **not a claim that every line of all 51k test lines received manual review**, nor a proof of absence of security defects. Remaining candidates below are explicitly distinguished from verified structural findings. Source/function metrics come from the TypeScript AST inventory (the [measurement artifacts](README.md#evidence)); that inventory reports 244 runtime files/54,594 physical lines, 174 test/support files/51,480 lines, and 3 tooling files/1,634 lines under API src. Physical lines include comments/blanks and must not be confused with executable lines. Test/tool exclusions affect counts.

There are 3,164 runtime function nodes (callbacks included), 68 scoring above 10 and 6 above 20 under the audit's CC convention. The metric counts `??` and short-circuit operators, excludes nested bodies and optional chaining. Thus a DTO filled with fallbacks can score highly without a complicated state machine. No arbitrary threshold should force a rewrite.

## Prioritized verified findings and bounded packages

### A1 — major: service facades participate in real runtime dependency cycles

Evidence: five file SCCs, excluding type-only imports, in [value-import-cycles.csv](metrics/value-import-cycles.csv). The 15-file SCC joins org/pool/evaluation/guards/notifications; the 13-file SCC joins live/grading/results; a 6-file SCC joins system/ticker; there are smaller schema-reference and LLM SCCs. These are maintainability risks, not demonstrated initialization crashes.

Concrete edges:
- `modules/notifications/service.ts:54` imports `holdsCourseSeat` from org's facade; `modules/org/service.ts:32` re-exports roster; `modules/org/roster.ts:21` imports notifications. A recipient-policy read loads a mutation-capable facade that imports its own consumer.
- `modules/guards.ts:45` imports `trustedClients` from evaluation's facade. That facade exports writes/templates/items, which pull guards and pool dependencies into authorization initialization.
- `modules/grading/service.ts:70` imports results' `watchReleasedGrades`; `modules/results/updated.ts:25` imports grading's `pointsAcrossRegrade`, and `:27` imports its own results facade's `shownGrades`. This coupling is especially expensive because a grading write must retain before/after released-grade observation and commit ordering.
- `modules/llm/service.ts:28` exports `LlmGateway`, while `modules/llm/gateway.ts:24` imports reservation/settings/settlement from service. This is the simplest cycle to remove.
- `modules/system/health.ts:66` imports ticker's `lastTickOf`; ticker also composes system tasks through the service/catalog/jobs graph.

Bounded work: first move LLM settings/ledger implementation into a private leaf, retain `service.ts` as facade, and have gateway import that leaf. Then separate tick-observation state from task composition. Separately place the org seat predicate and evaluation trusted-client predicate in narrow read/policy leaves, re-export from their existing facades, and ensure internal imports never point back up to a facade. For grading/results, first diagram actual execution edges and extract shared read calculations, not an event bus; retain the one grading write and explicit postcommit observation. The cross-module service-only convention means any new public read entry should be documented as such; don't simply replace all external imports with arbitrary private paths.

Acceptance: targeted SCCs shrink/disappear, no change in externally exposed exports, unchanged grading notification timing and guard semantics. No wholesale dependency injection framework. This is mostly movement: expect roughly -20 to +80 runtime lines, not a large deletion. Test LLM gateway/budget suites, ticker/system jobs, org/guards/Super Powers, grading/ready/results updated/regrade integration suites depending on subpackage. Stage independently in that order.

### A2 — major: live attempt and results services still combine distinct responsibilities

`modules/live/attempt.ts` is 1,501 lines: failures/constants (~87–255), participants/SEB/guests (313–543), instance draw/idempotent create/retake (568–758), item/view projection (813–1046), entry/write gates (1078–1189), submit/close/reopen (1204–1268), and student home/board (1312–1501). `live/service.ts` already presents a facade, so callers need not change. A 1,501-line file named attempt must currently be loaded conceptually to edit a home-card projection.

`modules/results/service.ts` is 1,072 lines: compute/release/withdraw/correction publication (168–474), teacher aggregation (513), student policy/feedback/redaction (620–924), and released-grade batched read models (956–1072). Its distinct policy gates and redaction deserve an explicit home, not more policy callbacks inside a generic serializer.

Bounded work: after A1 mapping, extract live student-home reads and live item/view projection; keep attempts' transactional create/retake/close logic together. Extract results student-feedback policies/projection separately from publication lifecycle. Keep only a thin existing facade; never create one-file-per-function. This can move ~1,200–1,600 lines into 3–4 cohesive leaves, but moving lines does **not** remove them. Expected runtime net -40 to +100 (imports/exports may increase). Main benefit: bounded reading context and clearer ownership, not LOC savings. Verify live/retake/parameters/studentHome/studentGrades/routes, results feedback/publishCorrection/negativeMarking/updated suites. Highest risk: key/LLM-justification leakage, cached vs live grades, retained attempt identity, staff preview exemptions.

### A3 — major: patch policy and projection are mixed in one DB write function

`modules/evaluation/writes.ts:220` `patchEvaluation` scores 34. Its roughly 85 lines mix writable-field checks, partial settings and feedback merge, retake/negative-marking/kiosk restrictions, dates/null semantics, resetting timing shift, state-specific scheduling checks and persistence. These are actual policy combinations; the raw number is not caused just by a huge function.

Bounded work: extract a pure `evaluationPatchValues`/equivalent normalization and refusal result from the persistence shell, reusing `configLock`, `isConfigFieldWritable`, `retakesAllowedFor`, `negativeMarkingAllowedFor`, `isFeedbackAllowed` already in domain. Keep error classes mapped in API, avoid leaking Drizzle types to domain. Preserve the crucial rule that legacy-invalid rows may still be renamed when the patch touches neither half of the inconsistent pair. Preserve null vs absent, scheduled validation, `closesAtShiftS=0` only when timing changes, and kiosk-off correction. Prefer a small function with clearly ordered validation over a generic policy engine. `next.updatedAt` currently uses `new Date()` despite `ctx.now`; aligning timestamp with the supplied clock is a possible small determinism cleanup, not a deadline bug.

This extraction probably adds 10–50 lines including adapters; tests may add another 40–100 for meaningful combination cases. Do not promise a runtime reduction. Run evaluation/evaluation.db, kioskSetting, templates/templatePull and live timing-control suites. Existing data rules must be characterized before moving to domain.

### A4 — moderate: authentication hook and SSE lifecycle have separate orchestration concerns

`auth/plugin.ts:104` contains session decorations, bearer resolution, confined-session validation, impersonation write policy, cookies, OIDC/login/logout/me routes. The preHandler at `:133` scores21. Split request identity resolution and cookie issuance/renewal helpers from route registration, with explicit dependency parameters; retain hook order and Fastify encapsulation. Authentication is already decomposed into session/trust/tokens/OIDC files; do not introduce another auth framework. Estimated runtime -10 to +45. Required tests: all auth session/token/login/SEB/trust/impersonation/Super Powers/coach/OAuth DB suites plus guards; old bearer must never fall back to a cookie, OAuth audience restrictions and confined 423/401 semantics remain exact.

`modules/realtime/routes.ts:401` handler scores21 and mixes watch authorization, topic derivation, hijack/headers, stream resource ownership, timers, presence and initial snapshot. Extract stream lifecycle ownership (timers, close idempotence, open/index cleanup) from watch resolution and keep the route as orchestration. Do not unify this streaming endpoint with ordinary JSON route wrappers. Preserve join-before-snapshot, revocation/state rechecks, delegated users never becoming present, backpressure/cleanup, and clock transport. Estimated runtime -10 to +40. Required realtime bus/coalesce/presence/routes DB tests and confinement tests. These packages are independent of A2 once exported service signatures remain stable.

### A5 — minor: two confirmed local single-source-of-truth cleanups

1. `modules/pool/questionWrite.ts:272` keptName and `:797` freeName duplicate the same case-insensitive per-pool query, deleted filter, bounded loop and UUID fallback. The intentional difference is candidate formatting (numbered name versus copy suffix). One local collision lookup/selection helper with a candidate formatter is sufficient. Retain outer unique-constraint retry where present; selecting a free name does not make insertion race-free. Expected 12–22 lines removed. Verify pool question copy and unsaved poll keep suites, including collisions/case/soft delete.
2. `modules/mcp/tools.ts:90–92` repeats ID/difficulty/tags validators while `packages/contracts/src/pool.ts:348–350` owns matching difficulty/tags constraints. Use contract field schemas (unwrap optional where tool semantics require required fields). Preserve tool descriptions/defaults and deliberate capability restrictions; don't auto-expose every HTTP route as a tool. Expected 2–8 lines removed, primary gain is preventing drift. Test `modules/mcp/mcp.db.test.ts` plus contract validation.

`modules/poll/service.ts:821` hard-codes `["mcq", "short"]` and `:948` declares the same `POLLABLE_TYPES`. Reuse one typed list, preferably the contract enum options where that is the exact policy. This is another ~1–3-line cleanup, not a reason for a plugin capability redesign.

A5 is low-risk, independent and can precede other work. The clone `live/routes.ts:152–162` vs `190–197` shares a short guarded-entry preamble but different admission/return/event behavior. At most extract the participant loader into the existing local route helpers; don't create a new route-generation DSL to remove ten lines.

### A6 — moderate: poll read aggregation and GitHub administration have overly broad files

`modules/poll/service.ts:787` questionPicks (CC19) runs historical/personal/version/answer/grade/roster queries, computes usage/outcomes, projects student-safe prompts and sorts. Split data acquisition into one read bundle and pure usage/order projection; keep grouped queries. In particular do not replace the batch reads with a helper that queries per question/run. The 1,037-line poll service also owns codes/guests, lifecycle, answer/tally and launcher reads. A focused `questionPicks`/launcher read file is justified; a repository interface per query is not. Runtime -20 to +35; tests poll/home, poll/pollPools, poll/poll and parameterized exclusions.

`modules/github/service.ts:215–496` installation inventory/healing and `:556–648` classroom connect/setup are separate from avatar fetching/cache `:663–714` and project receipt purge `:769`. Extract avatar handling and installation synchronization only if the next changes touch these concerns. Keep GitHub external-call cache invalidation and TTL semantics explicit. This is a context-reduction candidate, not a blocker based on file length. Runtime -10 to +40. Tests github/github, walks, webhooks plus auth/githubLink and project integration.

## Important measured hotspots that do not justify blanket rewrites

- `modules/live/dashboard.ts:156,180` map projections score20/22 partly because many nullable data fields have `??` fallbacks. Prefer named projector functions only if it reduces reader context. Do not equate 22 fallback fields with 22 independent business branches.
- `modules/project/webhooks.ts:122` workflowRun scores21, but most branches normalize missing GitHub fields and enforce run eligibility. Extract pure webhook-to-CompletedRun parsing if reused by reconciliation; prove semantic equality before sharing. Receipt time and triggering actor fail-closed defaults are security/grade facts, not redundant checks.
- `config.ts:367` loadConfig scores25 because it refuses unsafe production combinations. Split production validation/normalization only when editing the file; keep every refusal. `readableFile:348` tests isFile while `readable:481` only checks access: similar code but **not equivalent predicates**. Don't blindly collapse them or weaken GitHub key checks.
- `grading/jobs.ts:435,601` CC16 reflects automatic/manual/runner/LLM outcomes and pending/validated idempotency. The batch write is already centralized (`grading/service.ts:145,175`). A generic async job framework would hide materially different retries and side effects. Splitting pass orchestration, runner and LLM handlers is optional context work; savings are unproved.
- `journal/ingest.ts:162` fetchCopy CC16 deserves profiling and readable acquisition stages if it grows; no evidence supports replacing the existing version/CAS ingestion protection.

## Area-by-area disposition

- Root infrastructure/app/server/plugins/config/audit/assets/body limits/budget/clock/service health: composition is appropriate; config/auth hooks and ticker ownership are the narrow candidates above. Do not count audit vocabulary or limits as duplication.
- auth and oauth: substantial existing decomposition, explicit session-kind confinement and audience policy. Prioritize hook orchestration, not merging credential types.
- db: schema files reflect FK relationships. The five-file schema SCC is qualitatively different from service cycles: lazy FK callbacks can intentionally express bidirectional relationships. No evidence of harmful eager initialization. Do not merge schemas or remove constraints to hit zero cycles.
- low-level github: coherent app/signature/git/provision/lock/sync/revert/squash/commit/retry/studentize/metrics adapters. Different push retries vs API rate-limit rescheduling vs job lease retries must remain different.
- activity/admin: small adapters/composition; no verified refactor need.
- drill: lifecycle/review/teacher/jobs already separate; review is sizable but its served-instance, daily gate and dwell logic must remain authoritative. No reduction budget assigned.
- evaluation: targeted patch extraction, facade cycle cleanup; preserve templates vs instances and shared writes.
- github module: webhook receipt/jobs/handlers separation is justified; administration read/sync breadth candidate A6.
- grading: writes, jobs, events, ready and routes retain explicit ownership; A1 resolves dependency coupling. Keep single write primitive.
- journal: ingest/repo/rendering/quiz/writes/mode/studentView provide meaningful mode/security boundaries. Do not merge append-only Quiz mode and GitHub mirror writes.
- kiosk: attestation/pairing/watch/limiter/jobs separate different trust responsibilities; no generic session abstraction proposed.
- live: A2 primary context problem; autosave SQL race protection and gate logic are necessary complexity.
- llm: gateway/provider/crypto/Anthropic separation is appropriate; only facade cycle specifically proved.
- mcp: route forwarding is intentional reuse and a security boundary, schema fields A5 only.
- notifications: preference/bell/outbox/templates/providers split appropriately. Notifications→org cycle A1. Large multilingual templates are data, not algorithm complexity; don't replace with clever code.
- org: roster, service, routes; seat predicate dependency cut, preserve adoption/claim rules.
- poll: A5/A6; poll eligibility deliberately narrower than the registered question types.
- pool: many cohesive files already; localized naming clone, not wholesale consolidation into fewer files. Preserve plugin config/version/instance boundaries.
- preview: stateless orchestration already reuses student projection and visible-run primitives. It must never create real attempts/grades or invoke queued LLM grading as a convenience reuse.
- project: lifecycle/repos/lease/deadline/review/protection/webhooks/grading are justified responsibilities. Measured workflowRun is a candidate only; no evidence for large deletions.
- realtime: A4; bus/coalesce/presence remain transport mechanisms, not a replacement domain event platform.
- results: A1/A2, with policy/redaction tests essential.
- runner: small interface/adapters, retry mapping and capped responses justified.
- stats: query aggregations and privacy thresholds; no verified duplicate policy requiring work.
- system: task catalog/claim/jobs/health/alerts are distinct, observation dependency can be separated.
- seed: demo/content data excluded from production reduction target.
- test support: migrated database template, real app helper, fake question plugins, token/OIDC/GitHub fixtures already share high-cost setup. Do not replace fresh isolated PGlite copies with one shared mutable DB. Test setup clones may be intentional for readability; no quantified test deletion without a separate fixture audit.

## Order, validation and realistic footprint

1. A5 local SSOT/naming changes (independent, lowest risk).
2. A1 LLM and system dependency leaves, then org/evaluation read-policy edges.
3. A3 pure patch preparation with behavior characterization.
4. A2 live/results responsibility changes, including careful grading/results SCC work; keep each independently reviewable.
5. A4 auth and SSE (separate PRs, broader security test surfaces).
6. A6 launcher reads; GitHub file split only with a concrete maintenance need.

No dependency/framework additions or schema migrations are needed. Enforce no cross-module route imports and owning-module writes through a small architecture check if the parent proposes one; allow documented facade/schema exceptions rather than a blanket import ban. Target named complex policy functions, not CC=10 universally.

**Defensible API source reduction:** high-confidence direct deduplication is only about 15–35 runtime physical lines (A5); cautious adjacent cleanup could make 40–100. The architectural packages primarily move code and may add 50–250 lines of explicit interfaces/imports, with additional characterization tests. A broader 100–300-line net runtime reduction is an investigation target, not a verified or promised outcome; it requires confirmed duplication beyond the current exact clones. A claim of removing 10–20% of the API is not supported by this review. Do not count moving functions, deleting explanatory safety comments, seed/test deletion or introducing generic dispatch machinery as reduction. The meaningful target is shrinking the reader's relevant unit and eliminating dependency cycles while preserving behaviors.

Run only impacted API suites during each package, capped workers per AGENTS; full build/typecheck and sequential full test suite once at integration. This audit ran none. New tests should exercise combinations/security or race regressions, not assert private helper structure.

## Explicit non-refactors / accepted future work

Keep: owning-module writes; idempotent insert and conditional autosave upsert; grading history/supersession and validated-cell protection; per-attempt instance draws/fallback provenance; two-layer student redaction; bearer precedence/audience; session-kind confinement and Super Powers; best-effort postcommit notification boundaries; reservation/settlement of LLM budget; project independent leases and review dispatch ledger; signed webhook receipt storage and replay reconciliation; privacy thresholds; real migrated DB tests. These mechanisms cost lines because failure semantics differ.

Do not remove accepted but unimplemented codespace/group/gradebook/journal mode-transition requirements as YAGNI. Do not infer that the two LLM entrypoints can be merged solely because they both call a provider: verify the ADR-supported grading versus general-purpose gateway migration scope first. No product choice is settled by this report.

## Measured directory inventory

| Directory under apps/api/src | Runtime files / lines | Test/support files / lines | Tooling files / lines |
|---|---:|---:|---:|
| . | 19 / 2773 | 13 / 2000 | 1 / 156 |
| auth | 17 / 3108 | 17 / 2861 | 0 / 0 |
| auth/oauth | 3 / 826 | 1 / 406 | 0 / 0 |
| db | 19 / 3170 | 3 / 654 | 0 / 0 |
| github | 13 / 1701 | 9 / 1013 | 0 / 0 |
| modules | 3 / 1437 | 5 / 712 | 0 / 0 |
| modules/activity | 5 / 258 | 2 / 506 | 0 / 0 |
| modules/admin | 2 / 300 | 4 / 734 | 0 / 0 |
| modules/drill | 6 / 1408 | 3 / 1412 | 0 / 0 |
| modules/evaluation | 11 / 3550 | 8 / 3026 | 0 / 0 |
| modules/github | 6 / 1532 | 3 / 1178 | 0 / 0 |
| modules/grading | 6 / 2483 | 4 / 2178 | 0 / 0 |
| modules/journal | 12 / 2518 | 6 / 2209 | 0 / 0 |
| modules/kiosk | 7 / 1349 | 5 / 1957 | 0 / 0 |
| modules/live | 14 / 5010 | 13 / 6498 | 0 / 0 |
| modules/llm | 9 / 850 | 4 / 440 | 0 / 0 |
| modules/mcp | 4 / 1171 | 1 / 540 | 0 / 0 |
| modules/notifications | 12 / 2377 | 10 / 2590 | 0 / 0 |
| modules/org | 3 / 1427 | 4 / 1167 | 0 / 0 |
| modules/poll | 4 / 1654 | 4 / 1976 | 0 / 0 |
| modules/pool | 31 / 6260 | 17 / 5380 | 0 / 0 |
| modules/preview | 2 / 706 | 1 / 752 | 0 / 0 |
| modules/project | 18 / 4106 | 7 / 4338 | 0 / 0 |
| modules/realtime | 4 / 1212 | 2 / 702 | 0 / 0 |
| modules/results | 4 / 1498 | 9 / 2994 | 0 / 0 |
| modules/runner | 3 / 256 | 1 / 279 | 0 / 0 |
| modules/stats | 2 / 455 | 2 / 1023 | 0 / 0 |
| modules/system | 5 / 1199 | 4 / 775 | 0 / 0 |
| seed | 0 / 0 | 0 / 0 | 2 / 1478 |
| test | 0 / 0 | 12 / 1180 | 0 / 0 |

Unused-code triage from the root audit: `modules/kiosk/limiter.ts` is a two-line compatibility re-export with no consumers (current consumers import the root limiter); deletion candidate saving two lines after `rg` and typecheck. `github/sync.ts` has no current import but is explicitly reserved for M3-07, and `activity/kind.ts` has active type-only consumers. Neither is established dead code. Zero runtime fan-in is insufficient evidence for deletion.
