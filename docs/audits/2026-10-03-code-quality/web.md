[Audit overview](README.md) · [Ordered work catalogue](plan.md)

# Web code-quality audit — 2026-10-03

Scope: `/tmp/heig-quiz-code-quality-audit`, baseline `59c8925a`; read-only. No tests, browser sessions or repository edits performed. This is a complete area inventory and targeted static review, NOT a claim that every line in every component received behavioral verification. The [repository measurements](README.md#evidence) complement this evidence. Follow AGENTS isolation, explicit staging and memory rules for implementation. CLAUDE invariants particularly bind translations, single primary action, student content boundaries, server clock/access/contracts and domain rule ownership. UI primitives retain semantic tokens/accessibility and lazy question surfaces.

## Findings with verified evidence

### W1 — P1 correctness, menu scroll event assumes a Node

`apps/web/src/ui/menu.tsx:230` (onScroll block) casts `e.target as Node` and calls `panel.current?.contains(...)`. `apps/web/src/ui/popover.tsx:132` handles the same event defensively with `e.target instanceof Node`; window is not a Node. A window-targeted scroll event while the menu is open can throw. Fix the local guard, preserving the menu's opening-scroll grace period. Add one focused test dispatching scroll on window with menu open and a panel-scroll test proving the menu stays open. Net source growth 0–2 lines. This is a static-reachable failure, not an observed production incident.

### W2 — P2 genuine duplication, floating-panel horizontal clamp

`ui/menu.tsx:263` and `ui/popover.tsx:157` implement the same eight-pixel horizontal margin, end alignment, offsetWidth-based shift, marginLeft write and ResizeObserver lifecycle. They explicitly avoid transformed bounding rect during animation for the same reason. Extract ONE small `usePanelClamp(panel, open, pos, align)` in the UI layer or alongside existing positioning helpers. Preserve menu close-on-scroll+grace versus popover follow-trigger scroll: those are intentionally different and must not be merged into a universal interaction hook. Estimated **20–35 net production lines removed**, from two ~30-line effects to one shared ~30-line implementation plus calls. Verify narrow viewport, both alignments, late font/size change, entrance animation and keyboard focus tests; browser visual check remains necessary.

### W3 — P2 correctness/resilience, student-view storage differs from other remembered UI choices

`studentView.ts:48,57,67,75` directly gets/sets/removes sessionStorage; `ui/state.ts:9–33` deliberately catches localStorage failures and documents blocked storage. `App.tsx:490` calls useStudentView for all ordinary session pages, so reading denied sessionStorage can crash render rather than only lose a preference. Extend the existing storage mechanism with an explicitly session-scoped variant plus in-memory fallback; DO NOT change sessionStorage to localStorage (ADR-018 tab isolation). Test denied reads/writes, enter/leave behavior, reload persistence when available, two-tab separation. Expect **+10–25 production lines**, not a savings exercise. Browser policies must be reproduced before classifying user incidence.

### W4 — P2 test-tool correctness, screenshot errors do not fail process; cleanup is asymmetric

`scripts/screenshots.mjs:1323–1380` counts failed scenes but finishes with console.error only; a failed visual verification can exit zero. Screenshot itself is outside the scene try and browser/context cleanup is not in finally. `scripts/docs-screenshots.mjs:1286–1354` already closes each scene context in finally. Decide explicit CLI semantics: ordinary visual verification should set process.exitCode=1 on scene failures and close resources in finally; use an explicit exploratory flag only if wanted. Preserve evidence images for failed scenes. Focused CLI harness with failing page/screenshot and cleanup spies, not full browser matrix. Source **+5–20**, no claimed reduction.

### W5 — P2 responsibility boundary, questionTypes is several different modules

`questionTypes.tsx` is 841 lines: string translation/host dictionary wiring (~164–338), network/browser reference rehearsal adapters (~380–547), and Editor/Player/Review hosts (~603–838). The public host entry imports all three responsibilities. Split into `questionTypeStrings`, `questionTryAdapters` and host components, keeping a narrow compatibility export as needed; no new registry framework. Avoid moving app-owned translations or API calls into qt packages. **Net −10 to +25 lines**, chiefly reviewability rather than reduction. String dictionaries are already generated key-by-key by `translated`, so do not count each dictionary map as copied algorithm. Current qt-code and qt-circuit client entries lazily import components; static string imports are NOT evidence that Monaco/canvas is eagerly loaded. Verify existing questionTypes tests and emitted chunk boundaries before any performance claim.

### W6 — P2 responsibility boundary, JournalReader orchestration is much larger than its reader

`journal/JournalReader.tsx:107–419` combines role-aware queries, home-path redirect, edit/add/history/deleted-page modal state, mutation feedback and layout; `PageSlot:421`, `GithubBar:486`, `QuizBar:526`, `PageBody:575` are separable view responsibilities. `journal/api.ts` already owns write hooks/error mapping and afterWrite cache handling. Reuse that boundary rather than introducing a generic CRUD controller. Extract quiz-mode staff actions/dialog composition and keep staff/student cache keys and server-narrowed payloads untouched. **Net −10 to +30 lines**, moving code is not a reduction. Tests: student cannot acquire staff payload via cache; GitHub mode read-only; page/version conflict retains draft; home redirect; delete/restore/current-page cache behavior. Dependency: no other package required.

### W7 — P2 translation contract inconsistency, common API error fallback may display English server text

`api.ts:145` apiErrorMessage returns `body.message` for an unmapped error, whereas `journal/api.ts:54–59` intentionally maps known codes and otherwise translates `error.server`, never raw server text. CLAUDE says user-visible UI strings are translated; this generic escape hatch does not enforce it. Review caller intent and distinguish user-authored content from server diagnostic messages; add missing typed/code mappings at feature boundaries, use translated fallback for unknown infrastructure errors, log details separately. Do not import journal-specific errors into one global switch. No universal security exposure asserted. **Net 0 to +30 lines** initially, with fewer repeated casts possible later. Tests: unknown English server diagnostic in French UI, known codes, validation structured details; retain explicit product-sanctioned error details.

### W8 — P3 screenshot harness overlap; only the low-level lifecycle is reusable

`scripts/screenshots.mjs:1333–1365` and `docs-screenshots.mjs:1295–1347` duplicate page error collection, console capture, prepaint theme storage, coach dismissal and action settling. Extract optional narrow helpers only after W4 defines failure semantics. Authentication, mutating phase preparation, scene definitions, output names and full-page behavior DIFFER: docs expands viewport to preserve sticky sidebar while mock script stitches full-page. Do not unify these into a heavily parameterized runner or share scene arrays blindly. **20–50 net script lines removed**, low confidence until interface proof; not included in production-source reductions. Verify one ordinary, one modal, one phone and one intentional signed-out 401 scene in each harness.

### W9 — P3 size is not a defect: registry/router/layout extraction only when changed

`router.ts:268–604` already uses a typed route table with helpers (`fixed`, `evaluationTail`), and `studentView.ts:95` derives STUDENT_ROUTES from it. Replacing it with another registry or deleting duplicate-looking parse/format round-trip cases is not justified. `App.tsx` deliberately separates public Teams/kiosk boot before session, confined-session rendering and general session shell; combining SignedOut/renderPage to save JSX can violate those orderings. `Shell.tsx` is 810 lines but shared chrome, responsive navigation and mode banners are legitimate cohesion boundaries. Extract navigation rendering only when independently testable, with **no promised net savings**.

## Cross-cutting review conclusions / retain

- `evaluation/editTarget.ts:45–95` already abstracts template/evaluation editing by base path and cache ownership, with TemplateBody excluding run fields. Do not reintroduce `isTemplate` branches or replace it with a generic resource controller.
- `queryKeys.ts` documents prefix invariants and role-separated journal keys. Keep central factories; zero reason to split by feature merely because the file is long. Tests pin literal keys intentionally because cache prefix shapes are behavior.
- `attempt/{useAttempt,autosave,writes,signals,playerReducer,run}.ts` is already split by lifecycle. Preview and real attempt share player/reducer but intentionally differ in persistence/clock. Do not collapse them or replace server-authoritative deadlines with browser convenience.
- `realtime/useEventStream.ts:62–90` maintains one connection and selects one watched subject; typed events validated through shared contracts; watchdog and safety refetch are not redundant timers. Multiple subject arbitration is a future requirement, not established current bug.
- `runner/index.ts` already centralizes fallback and preserves rate-limited responses instead of bypassing server budgets. WASI/worker/tar machinery is a domain adapter, not a generic utility candidate.
- `markdown/render.ts` sanitization, `JournalArticle` rendered HTML boundary, FormulaDialog KaTeX and static logo SVG are different trust boundaries. A grep for dangerouslySetInnerHTML does not establish XSS or justify one catch-all renderer. Existing shared docrender highlight reuse should remain.
- `grading` already separates data/actions/invalidation/columns/rows/history. Grade ranges and algorithms stay in domain/server. Anonymous labels and real identities are intentionally different display modes.
- `pool/PoolView.tsx:156` listing and `PoolsPage.tsx:155` pool mutations concern different resources. Identical-looking card/table metadata is not a proved logic duplicate; share pure derivation only after profiling an actual edit.
- `question/VariablesSection.tsx:47` reconcileRows and :72 outsideCode are UI authoring rules (auto-created untouched rows, skip code spans), not necessarily the server expression evaluator. Moving them to domain to satisfy a superficial purity rule would introduce marked/browser concerns there.
- `i18n/en.ts` 4,235 and `fr.ts` 4,221 lines are translated content, not removable duplication; typed French coverage is valuable. French is already loaded lazily. Dictionary splitting is organizational, not a source-reduction claim.
- `mock/` is intentionally an independent in-browser fake, excluded from production build/coverage. Reusing production services inside it would couple tests to implementation and often import database/server modules. Its narrative source data may be split for editing but not advertised as deleted logic.
- Test fixtures/render/mockFetch/viewport/clock utilities already exist. Do not build a new generic screen test DSL. Node/jsdom split in vite.config.ts and capped workers are deliberate RAM controls. Hard-coded async timeouts deserve measured flake analysis, not blanket reduction.

## Sequencing, estimates and acceptance

1. W1 + W3 + W4 as independent small correctness PRs, each focused regression. No claim of line reduction; expect +15–47 lines total.
2. W2 shared clamp after W1; 20–35 production lines reduction, low risk if interaction policies stay local.
3. W7 error rendering policy review then feature-by-feature changes; translation behavior deliberately changes, so not a pure refactor.
4. W5 and W6 separate responsibility PRs; each should be close to line-neutral. Keep imports/lazy boundaries and public contracts, scoped existing tests plus one browser walkthrough.
5. W8 only if its proposed helper remains smaller than two explicit runners. 20–50 script lines potential; distinct from shipped application.

**Defensible net source reduction from verified duplicates: 28–50 production lines (W2 + W10); 20–50 development-script lines.** Correctness fixes can outweigh those savings. Any estimate of hundreds/thousands saved in web from this review would be speculative. Bigger reductions require repository clone evidence and validation of interchangeable behavior; moving functions, deleting tests/comments/translations, or counting mocks as production are not legitimate savings.

No repository code was changed. No tests were run under the read-only/no-test task constraint. File/line locations refer to the specified baseline and must be refreshed on implementation.

## Inventory (every source area)

Counts use the same runtime/test-support/tooling classification as the [shared inventory](inventory.md). Browser mocks and test helpers are test/support, not production reduction targets.

| Area | Runtime files | Runtime physical lines | Test/support files | Test/support physical lines |
|---|---:|---:|---:|---:|
| (root shell/admin/shared) | 48 | 11201 | 34 | 8222 |
| activities | 7 | 1866 | 4 | 936 |
| attempt | 6 | 1386 | 4 | 869 |
| coach | 4 | 1056 | 3 | 208 |
| course | 7 | 1173 | 1 | 405 |
| drill | 11 | 1461 | 3 | 546 |
| evaluation | 21 | 5301 | 12 | 3427 |
| github | 5 | 579 | 4 | 380 |
| grading | 19 | 3040 | 5 | 1302 |
| i18n | 4 | 8712 | 2 | 112 |
| journal | 14 | 2942 | 6 | 1857 |
| kiosk | 5 | 468 | 3 | 380 |
| live | 17 | 3151 | 10 | 2265 |
| markdown | 25 | 5346 | 8 | 2975 |
| mock | 0 | 0 | 20 | 12717 |
| notifications | 6 | 1182 | 5 | 853 |
| oauth | 1 | 170 | 0 | 0 |
| pair | 1 | 265 | 1 | 132 |
| poll | 15 | 3265 | 5 | 1477 |
| pool | 35 | 7333 | 14 | 2919 |
| preview | 5 | 874 | 1 | 494 |
| project | 6 | 1052 | 3 | 548 |
| question | 21 | 3492 | 10 | 1910 |
| realtime | 7 | 1021 | 7 | 1142 |
| results | 8 | 1394 | 4 | 491 |
| runner | 8 | 1405 | 5 | 1175 |
| student | 28 | 4278 | 15 | 3287 |
| test | 0 | 0 | 10 | 1110 |
| ui | 18 | 5596 | 9 | 842 |

Additional non-TS areas: help Markdown and French counterparts, assets, style.css, formula/richtext CSS; developer scripts docs-screenshots-index, docs-screenshots, screenshots, fetch-runtimes, icons. Fetch/runtime downloads and icon generation were inventoried, not executed or exhaustively security-reviewed.

## Additional evidence from root metrics, manually verified

The AST scan reports no value-import SCC in web after correctly removing type-only edges; do not report Player/commands type dependencies as runtime cycles. Its branch-count metric excludes nested functions/optional chaining and includes nullish/logical assignment: PoolView 44, JournalReader 42, PlayerView 40, LiveDashboard 36, AddQuestionsSheet 35, GradingPanel 32, PollJoin 29, GridRow/NewProject 28. These are prioritization signals, not automatic function failures: JSX rendering alternatives contribute and pure lookup conversion can merely disguise them.

### W10 — P3 genuine duplicate keyboard protocol

`Shell.tsx:430–443` and `student/PlayerShell.tsx:179–189` bind bare Ctrl/Meta+K, reject Alt/Shift, prevent browser search and toggle palette. A small usePaletteShortcut(enabled, toggle) in the existing shortcuts module can own this one protocol, keeping PlayerShell's `hasPalette` gate. Preserve triggering from within inputs, unlike ordinary letter shortcuts. **8–15 net production lines removed**, tests on modifiers, input focus, disabled palette and cleanup. Do not share the shell-specific commands or mount a second shell.

### W11 — P3 real JSX clone, weak extraction value

`preview/PreviewCorrection.tsx:123–139` and `student/Feedback.tsx:272–288` pass identical student-audience fields into QuestionReviewHost and render optional explanation. Already shared host owns the hard work; extracting a feedback-body component saves only **0–10 net lines** after its typed prop shape/imports. Preview's machine-status/comment and student's human comment/feedback visibility differ and must remain outside. Implement only if a third consumer arrives or a shared behavior change makes drift concrete; omit from baseline savings.

The [work catalogue](plan.md) separates confirmed extractions, conditional opportunities and changes that can increase source size.

Coverage disposition for smaller inventoried areas: activities already has model/actions/views/timeline adapters; coach/help own onboarding and localized prose; course/project/github keep role-specific network orchestration; kiosk/pair/oauth/notifications are identity/protocol boundaries and must not be merged as generic sign-in screens; drill retains its own device/dwell protocol; results/projection must preserve staff versus student payloads; live/poll retain different presence and voting state. No specific duplicate algorithm was established in those areas beyond findings above. Their presence in the inventory is not a blanket quality approval; repository dependency metrics and future focused reviews should name any concrete additional issue before proposing code deletion.
