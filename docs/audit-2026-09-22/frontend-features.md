# Frontend feature screens audit (agent report, relayed)

## Numbers
101 source files / 19 898 LOC, 38 test files / 6 746 LOC, 98 exported components, 45 functions CC>10, 9 CC>20. Worst: GradingPanel 40, PollProjection 28, QuestionEditor 28, PoolView 26, LiveDashboard 25, EvaluationConfig 23, Player 23. No direct test for StudentGrid, InspectModal, LobbyPanel, LiveHeader, cells.ts, BulkBar, CategoryTree, QuestionTable, ItemsStep, AddQuestionsSheet, EntryList, EntryDetail, BatchBar, RegradeSheet, PollBars, PollJoinReveal, useAttempt, attemptStream, PlayerShell.

| folder | src | LOC | tests | test LOC | CC>10 | worst |
|---|---|---|---|---|---|---|
| pool | 20 | 4900 | 9 | 1586 | 9 | 26 PoolView |
| question | 9 | 1980 | 4 | 985 | 4 | 28 QuestionEditor |
| evaluation | 11 | 2362 | 4 | 853 | 4 | 23 EvaluationConfig |
| live | 9 | 1568 | 1 | 256 | 5 | 25 LiveDashboard |
| poll | 8 | 2127 | 5 | 799 | 5 | 28 PollProjection |
| grading | 13 | 1860 | 3 | 291 | 5 | 40 GradingPanel |
| results | 6 | 714 | 2 | 138 | 1 | 19 ResultsView |
| student | 12 | 1842 | 5 | 930 | 4 | 23 Player |
| attempt | 4 | 1006 | 2 | 478 | 2 | 18 playerReducer |
| notifications | 1 | 306 | 1 | 117 | 1 | 15 |
| runner | 8 | 1233 | 2 | 313 | 5 | 16 |

## Findings
| id | title | principle | LOC | risk |
|---|---|---|---|---|
| FF-01 | grading/progress.ts:37 opens a second EventSource per page; its justification (:13-19) is stale — useEventStream.ts:33-48 already subscribes grading.progress; breaks "ONE connection per page" (:10-14). Use useEventStream | DRY/ARCH | −40 | low |
| FF-02 | Two typeLabel with reversed args: evaluation/common.ts:45 hard-codes 4 MVP types so `circuit` prints raw on ItemsStep:244, PreviewSheet:79, AddQuestionsSheet:139/209, InspectModal:199 (N-I18N-01 hole); questionTypes.tsx:110 is registry-based. Delete the first, drop 8 eval.type.* keys | SSOT + bug | −25 | low |
| FF-03 | Three hand-rolled ARIA comboboxes (question/TagInput.tsx, pool/TeacherPicker.tsx, SearchBox in pool/FilterBar.tsx:186-305) with byte-identical popover class strings (TagInput:248 = TeacherPicker:136), blur grace, optionId, arrow handling; drift already visible. useCombobox + ComboboxList in ui.tsx (first inhabitant of packages/ui) | DRY | −120 | med |
| FF-04 | attempt/attemptStream.ts is a second SSE client; :20 hand-writes WatchSubject shadowing the zod-inferred one in contracts/realtime.ts:36-40 (invariant 7); WATCHED_EVENTS ⊂ NAMED_EVENTS; only real difference onOpen/onReconnect (F-EVAL-13). Add onFirstOpen/onReopen to useEventStream, delete file | DRY/SSOT | −100 | med |
| FF-05 | GradingPanel.tsx:65-568 CC 40, 504 lines: 9 useState, 5 queries, 2 mutations; extract useGradingTraversal, useGradingKeys, GradingFilters, sort rule to labels.ts → ≈190 LOC, CC ≈12. Test file only 168 LOC — write hook tests first | CC | −30 | med |
| FF-06 | isTyping ×4 (PollProjection:89-94, LiveDashboard:58-63, InspectModal:90, GradingPanel:256-262); useFullscreen ×2 (PollProjection:120-142, LiveDashboard:193-207) — dashboard copy lacks the fullscreenchange listener → Escape leaves teacher stuck in the fixed inset-0 overlay (LiveDashboard:411). Move both to ui.tsx | DRY + bug | −45 | low |
| FF-07 | ~70 raw query-key literals; evaluation/common.ts:15-18 has factories used only by live/ and evaluation/; GET /pools/:id/questions cached under two roots (PoolView:244 ["pool",id,"questions"] vs AddQuestionsSheet:68 ["pool-questions"]) → stale picker. One queryKeys module | SSOT + bug | −25 | low |
| FF-08 | Five localStorage preference hooks: PoolView:88-118, PoolNav:47-68, PollLauncher:75-89 wrap in try/catch; PoolsPage:76-87 and TeacherHome:60-72 do not → crash in private window. usePersistentChoice in ui.tsx | DRY/KISS + bug | −45 | low |
| FF-09 | PollProjection.tsx 635 LOC, CC 28: useStageFit (:155-270, 115 LOC) belongs beside poll/fit.ts; useProjectionTheme → theme.ts; extract ProjectionHeader/Footer → ≈180 LOC, CC ≈12 | CC/ARCH | −10 | low |
| FF-10 | Four create/rename modals (PoolView:131-192, EvaluationList:47-119, EvaluationConfig:68-108, PoolsPage:230; core TeacherHome:74) same skeleton; `disabled={x.trim()===""}` ×5. FormModal in ui.tsx | DRY | −80 | low |
| FF-11 | AddQuestionsSheet.tsx:62-69 rebuilds questionQuery (pool/filters.ts:98-122, tested); :138 hard-codes 4 types (missing circuit) vs QUESTION_TYPE_IDS; :152/:214 "●".repeat(d) vs tested DifficultyDots (a11y regression). No test — write one first | DRY/SSOT | −30 | low |
| FF-12 | Two command registries: screenCommands.ts (useScreenCommands, 4 users) vs registerContextualCommands (commands.ts:326-336, used only by live/useLiveCommands.ts with 54 LOC of ref machinery). Spec 08 §8.4 names ONE registry. Delete contextual registry | KISS/ARCH | −50 | low |
| FF-13 | "Eyebrow + soft panel" copy-pasted 7× (GradingPanel:476, EntryDetail:72, Feedback:151/160, ByQuestionView:65/87/106) with three paddings and three margins. NotePanel in ui.tsx + DESIGN.md entry same commit | DRY | −55 | low |
| FF-14 | Seven hand-rolled page skeletons, none alike (PoolView:330, QuestionEditor:445, EvaluationConfig:175, LiveDashboard:263, ResultsView:137, Feedback:48; GradingPanel:328 uses ListSkeleton correctly). PageSkeleton | DRY/KISS | −45 | low |
| FF-15 | duplicate + delete question implemented twice (PoolView:295-325, QuestionEditor:196-228). useQuestionActions | DRY | −45 | low |
| FF-16 | QuestionEditor.tsx:79-663 CC 28: draft reconciliation, uploadAsset, dup/delete, tryReference (code adapter :258-303), trySimulateReference (circuit :317-332), 4 shortcuts listed twice. useQuestionDraft, useEditorShortcuts, tryAdapterFor in questionTypes.tsx (+ Player's simulateCircuit) → ≈300 LOC CC ≈12. Invariant 14: circuit adapter keeps posting config as answer | CC | −40 | med |
| FF-17 | PoolView CC 26 recomputes findCategory/categoryPaths/groupQuestions each render without useMemo; categoryPaths is the 3rd copy of the tree walk (BulkBar:34-39 flatten, CategoryTree). pool/categories.ts + useMemo | CC/KISS | −25 | low |
| FF-18 | rounded-[10px] = rounded-field written the hard way 17× (8 in features); off-scale rounded-xl/lg/md at PollJoinReveal:58/133, FilterBar:298/482, BulkBar:206 [28px], PollQr:70 [14px]. Rename; add real deviations to DESIGN.md | SSOT tokens | 0 | none |
| FF-19 | PollLauncher:322-352 and PoolView:167-186 render the same new-question form. NewQuestionForm in question/ | DRY | −35 | low |
| FF-20 | OverrideSheet and RegradeSheet structurally identical; "invalidate grading + results" pair written 5× (also GradingPanel:216-219, BatchBar). useGradingInvalidate + form helper; RegradeSheet has no test | DRY | −35 | low |
| FF-21 | Score formatting as 7 one-liners (labels.ts:73-76 round2, GradeTable:105/108, Feedback:105/108/132, StatsRow:8, Histogram:9-10): two rules (points 2 decimals; grade 1 decimal Swiss). formatPoints/formatGrade in packages/domain (invariant 8) | SSOT | −20 | low |
| FF-22 | student/Lobby.tsx navigation prop + NAV_COPY (:28-33, :46, :82-85) only passed by its own test (Lobby.test.tsx:57); Attempt.tsx:172-176 never passes it → F-LIVE-08 explanations never shown. Product decision: wire LobbyView.settings.navigation (spec 06 first) or remove | YAGNI/product | −15 / +5 | low |
| FF-23 | Dead exports: grading/labels.ts:65 scoreText, pool/searchSyntax.ts:34 EMPTY_PARSE; ~40 over-exported internals; grading/fixtures.ts (265 LOC) is test data in src/. Delete/unexport/move + knip rule | YAGNI | −40 | none |
| FF-24 | student/Player CC 23: isAnswered duplicated with PollJoin:58-65 (comment included); 60-line inline Command[] (:172-232); segmentsOf belongs in playerReducer. usePlayerCommands; move isAnswered to QuestionHost | CC/DRY | −25 | med |
| FF-25 | Three exported stateLabel over three unions (evaluation/common.ts:40, grading/labels.ts:36, results/GradeTable.tsx:26); StudentGrid:114-122 re-implements isLive (evaluation/common.ts:52). Rename, import; longer term state→tone maps into packages/domain | SSOT | −10 | low |
| FF-26 | StudentPreviewPage.tsx:60-61 passes now={Date.now()} for an unused required prop — the only Date.now() in a render path (invariant 5 grep noise). Make now optional | KISS | −1 | none |

## One-primary-action review
Every screen passes. ResultsView header at the ceiling (4 actions); EvaluationConfig "View as student" vs "Preview" labels indistinguishable — copy change, not flow.

## Plan
Phase 0 safety net (+400 test LOC): AddQuestionsSheet, RegradeSheet, useGradingTraversal, StudentGrid tests. Phase 1 SSOT (FF-02, 07, 18, 21, 23, 25, 26): −120. Phase 2 shared primitives into ui.tsx (FF-06, 08, 10, 13, 14): −270, seed of packages/ui, screenshots both themes. Phase 3 feature de-dup (FF-11, 15, 19, 20): −145. Phase 4 SSE consolidation (FF-01 then FF-04, smoke on real PostgreSQL, throttled reconnect walk): −140. Phase 5 hot spots (FF-05, 09, 12, 16, 17, 24) one per commit, PollProjection → PoolView → useLiveCommands → QuestionEditor → GradingPanel → Player, DOM identical via screenshots: −180. Deferred: FF-22 product decision.

## Keep as is
playerReducer + autosave (pure state machines, 476 test LOC); StudentGrid's documented seven-column violation; PollJoinReveal not reusing QuestionReviewHost; PollJoin not reusing PlayerShell; the small pure modules (labels.ts, cells.ts, pollTally.ts, QuestionGroups.ts, searchSyntax.ts, fit.ts, presets.ts); usePatch.ts; gradingLinks seam; three-tab shapes of EvaluationConfig/QuestionEditor; the verbose file headers.

## Summary
| Principle | LOC |
|---|---|
| DRY | −625 |
| SSOT | −110 |
| CC | −130 |
| KISS | −55 |
| YAGNI | −55 |
| Total | ≈ −975 (−4.9 %) + 400 test LOC first |
Defects closed as side effects: raw `circuit` label (FF-02), stuck full-screen dashboard (FF-06), split pool-questions cache (FF-07), two private-window crashes (FF-08), second EventSource on grading panel and on every attempt (FF-01/04), unlabelled difficulty bullets (FF-11).
