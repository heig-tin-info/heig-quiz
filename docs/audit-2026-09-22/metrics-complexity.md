# Cyclomatic complexity and size, per area (non-test source unless stated)

| area | src files | src LOC | test files | test LOC | functions | CC>10 | CC>20 | max CC |
|---|---|---|---|---|---|---|---|---|
| backend | 71 | 19525 | 34 | 9729 | 1092 | 21 | 1 | 21 |
| frontend | 154 | 40071 | 78 | 20862 | 2725 | 72 | 14 | 40 |
| runner | 13 | 1443 | 11 | 1820 | 102 | 2 | 0 | 15 |
| packages | 40 | 5262 | 18 | 1846 | 174 | 5 | 0 | 17 |
| qt | 79 | 17072 | 46 | 8806 | 1002 | 39 | 12 | 65 |
| scripts | 1 | 100 | 0 | 0 | 14 | 2 | 0 | 18 |

## Top 60 functions by cyclomatic complexity (non-test)

| CC | lines | function | location |
|---|---|---|---|
| 65 | 264 | extractNets | packages/qt-circuit/src/netlist.ts:234 |
| 40 | 504 | GradingPanel | apps/web/src/grading/GradingPanel.tsx:65 |
| 40 | 942 | RichText | apps/web/src/markdown/RichText.tsx:187 |
| 38 | 1019 | SchematicEditor | packages/qt-circuit/src/canvas/SchematicEditor.tsx:247 |
| 37 | 85 | astar | packages/qt-circuit/src/canvas/router.ts:122 |
| 36 | 151 | App | apps/web/src/App.tsx:135 |
| 35 | 338 | CodePlayer | packages/qt-code/src/Player.tsx:113 |
| 31 | 115 | handleKeyDown | apps/web/src/markdown/RichText.tsx:324 |
| 30 | 633 | CircuitEditor | packages/qt-circuit/src/Editor.tsx:256 |
| 29 | 224 | CircuitReview | packages/qt-circuit/src/Review.tsx:107 |
| 29 | 89 | (cb→useCallback) | packages/qt-circuit/src/canvas/SchematicEditor.tsx:614 |
| 28 | 355 | PollProjection | apps/web/src/poll/PollProjection.tsx:280 |
| 28 | 585 | QuestionEditor | apps/web/src/question/QuestionEditor.tsx:79 |
| 27 | 204 | buildCommands | apps/web/src/commands.ts:106 |
| 26 | 330 | PoolView | apps/web/src/pool/PoolView.tsx:205 |
| 26 | 43 | parsePath | apps/web/src/router.ts:91 |
| 26 | 223 | CircuitPlayer | packages/qt-circuit/src/Player.tsx:122 |
| 26 | 51 | (cb→useCallback) | packages/qt-circuit/src/canvas/SchematicEditor.tsx:882 |
| 25 | 350 | LiveDashboard | apps/web/src/live/LiveDashboard.tsx:65 |
| 25 | 234 | PollJoin | apps/web/src/poll/PollJoin.tsx:76 |
| 25 | 50 | junctionPoints | packages/qt-circuit/src/canvas/router.ts:336 |
| 23 | 302 | EvaluationConfig | apps/web/src/evaluation/EvaluationConfig.tsx:111 |
| 23 | 305 | Player | apps/web/src/student/Player.tsx:97 |
| 22 | 231 | Plot | packages/qt-circuit/src/canvas/Plot.tsx:143 |
| 21 | 98 | gradingQueue | apps/api/src/modules/grading/service.ts:350 |
| 21 | 342 | TagInput | apps/web/src/question/TagInput.tsx:35 |
| 21 | 50 | (cb→useCallback) | packages/qt-circuit/src/canvas/SchematicEditor.tsx:722 |
| 20 | 33 | distributionOf | apps/api/src/modules/results/service.ts:385 |
| 20 | 204 | AddQuestionsSheet | apps/web/src/evaluation/AddQuestionsSheet.tsx:38 |
| 20 | 178 | (cb→view.rows.map) | apps/web/src/live/StudentGrid.tsx:172 |
| 20 | 662 | CodeEditor | packages/qt-code/src/Editor.tsx:93 |
| 19 | 143 | runEvaluationGrading | apps/api/src/modules/grading/jobs.ts:110 |
| 19 | 35 | (cb→cases.map) | apps/api/src/modules/live/service.ts:1263 |
| 19 | 246 | Row | apps/web/src/RosterTable.tsx:51 |
| 19 | 54 | tokenize | apps/web/src/markdown/highlight.ts:101 |
| 19 | 59 | closeCodeFence | apps/web/src/markdown/tiptap.ts:305 |
| 19 | 223 | ResultsView | apps/web/src/results/ResultsView.tsx:51 |
| 19 | 43 | routeToPath | apps/web/src/router.ts:47 |
| 19 | 91 | emitDevices | packages/qt-circuit/src/spice.ts:236 |
| 18 | 36 | patchEvaluation | apps/api/src/modules/evaluation/service.ts:639 |
| 18 | 104 | runRunnerGrading | apps/api/src/modules/grading/jobs.ts:368 |
| 18 | 137 | (cb→app.post) | apps/api/src/modules/pool/routes.ts:851 |
| 18 | 47 | playerReducer | apps/web/src/attempt/playerReducer.ts:117 |
| 18 | 53 | parseSearch | apps/web/src/pool/searchSyntax.ts:156 |
| 18 | 156 | AttemptPage | apps/web/src/student/Attempt.tsx:32 |
| 18 | 341 | McqEditor | packages/qt-mcq/src/Editor.tsx:166 |
| 18 | 148 | CodeReview | packages/qt-code/src/Review.tsx:52 |
| 18 | 11 | nameOf | scripts/.audit-tmp/cc.ts:29 |
| 17 | 237 | ClassroomView | apps/web/src/ClassroomView.tsx:201 |
| 17 | 32 | onKey | apps/web/src/grading/GradingPanel.tsx:251 |
| 17 | 34 | (cb→monthDays(y, m).map) | apps/web/src/ui.tsx:2409 |
| 17 | 53 | parseBlankBody | packages/domain/src/cloze.ts:160 |
| 16 | 48 | (cb→app.post) | apps/api/src/modules/pool/routes.ts:1058 |
| 16 | 29 | blankFromDraft | apps/web/src/markdown/BlankPopover.tsx:121 |
| 16 | 84 | (cb→rows.map) | apps/web/src/poll/PollBars.tsx:61 |
| 16 | 321 | BulkBar | apps/web/src/pool/BulkBar.tsx:44 |
| 16 | 72 | run | apps/web/src/runner/runno/runner.ts:287 |
| 16 | 33 | canonicalMatcher | packages/qt-short/src/canonical.ts:28 |
| 16 | 23 | interpolate | packages/qt-circuit/src/grade.ts:151 |
| 16 | 7 | visit | scripts/.audit-tmp/cc.ts:45 |

## Top 40 files by LOC (non-test)

| LOC | functions | sum CC | max CC | file |
|---|---|---|---|---|
| 3923 | 13 | 30 | 11 | apps/web/src/i18n.tsx |
| 2975 | 177 | 475 | 17 | apps/web/src/ui.tsx |
| 2104 | 120 | 388 | 19 | apps/api/src/modules/live/service.ts |
| 1912 | 117 | 248 | 10 | apps/api/src/modules/pool/service.ts |
| 1353 | 135 | 398 | 38 | packages/qt-circuit/src/canvas/SchematicEditor.tsx |
| 1320 | 162 | 238 | 11 | apps/web/scripts/docs-screenshots.mjs |
| 1251 | 56 | 235 | 18 | apps/api/src/modules/pool/routes.ts |
| 1185 | 69 | 255 | 40 | apps/web/src/markdown/RichText.tsx |
| 1021 | 70 | 137 | 30 | packages/qt-circuit/src/Editor.tsx |
| 988 | 71 | 161 | 18 | apps/api/src/modules/evaluation/service.ts |
| 757 | 47 | 105 | 20 | packages/qt-code/src/Editor.tsx |
| 738 | 0 | 0 | 0 | apps/api/src/seed/content.ts |
| 726 | 43 | 94 | 10 | apps/api/src/modules/poll/service.ts |
| 715 | 65 | 100 | 12 | apps/web/src/TeacherHome.tsx |
| 664 | 38 | 94 | 28 | apps/web/src/question/QuestionEditor.tsx |
| 659 | 45 | 135 | 20 | apps/api/src/modules/results/service.ts |
| 658 | 35 | 92 | 18 | packages/qt-mcq/src/Editor.tsx |
| 635 | 43 | 121 | 28 | apps/web/src/poll/PollProjection.tsx |
| 625 | 36 | 108 | 21 | apps/api/src/modules/grading/service.ts |
| 611 | 47 | 83 | 9 | packages/qt-short/src/Editor.tsx |
| 591 | 64 | 107 | 11 | apps/web/src/pool/FilterBar.tsx |
| 584 | 42 | 86 | 15 | apps/web/src/Shell.tsx |
| 580 | 24 | 80 | 12 | apps/api/src/modules/courses.ts |
| 577 | 26 | 90 | 19 | apps/web/src/markdown/tiptap.ts |
| 569 | 59 | 136 | 40 | apps/web/src/grading/GradingPanel.tsx |
| 567 | 94 | 120 | 7 | apps/web/src/questionTypes.tsx |
| 557 | 41 | 86 | 12 | apps/web/src/pool/PoolsPage.tsx |
| 550 | 29 | 108 | 16 | packages/qt-circuit/src/grade.ts |
| 548 | 29 | 104 | 8 | apps/api/src/modules/live/routes.ts |
| 548 | 64 | 114 | 26 | apps/web/src/pool/PoolView.tsx |
| 516 | 26 | 57 | 4 | apps/api/src/modules/guards.ts |
| 512 | 29 | 120 | 65 | packages/qt-circuit/src/netlist.ts |
| 508 | 6 | 8 | 3 | packages/contracts/src/pool.ts |
| 500 | 36 | 72 | 12 | apps/web/src/evaluation/ItemsStep.tsx |
| 487 | 13 | 57 | 19 | apps/api/src/modules/grading/jobs.ts |
| 471 | 22 | 85 | 19 | packages/qt-circuit/src/spice.ts |
| 458 | 35 | 79 | 10 | packages/qt-circuit/src/canvas/geometry.ts |
| 453 | 19 | 92 | 35 | packages/qt-code/src/Player.tsx |
| 451 | 72 | 82 | 6 | apps/web/scripts/screenshots.mjs |
| 447 | 29 | 93 | 17 | packages/domain/src/cloze.ts |

## Top 30 longest functions (non-test)

| lines | CC | function | location |
|---|---|---|---|
| 1098 | 1 | poolPlugin | apps/api/src/modules/pool/routes.ts:119 |
| 1019 | 38 | SchematicEditor | packages/qt-circuit/src/canvas/SchematicEditor.tsx:247 |
| 942 | 40 | RichText | apps/web/src/markdown/RichText.tsx:187 |
| 662 | 20 | CodeEditor | packages/qt-code/src/Editor.tsx:93 |
| 633 | 30 | CircuitEditor | packages/qt-circuit/src/Editor.tsx:256 |
| 585 | 28 | QuestionEditor | apps/web/src/question/QuestionEditor.tsx:79 |
| 522 | 2 | coursesPlugin | apps/api/src/modules/courses.ts:58 |
| 504 | 40 | GradingPanel | apps/web/src/grading/GradingPanel.tsx:65 |
| 485 | 1 | livePlugin | apps/api/src/modules/live/routes.ts:63 |
| 379 | 1 | pollPlugin | apps/api/src/modules/poll/routes.ts:67 |
| 355 | 28 | PollProjection | apps/web/src/poll/PollProjection.tsx:280 |
| 350 | 25 | LiveDashboard | apps/web/src/live/LiveDashboard.tsx:65 |
| 342 | 21 | TagInput | apps/web/src/question/TagInput.tsx:35 |
| 341 | 18 | McqEditor | packages/qt-mcq/src/Editor.tsx:166 |
| 338 | 35 | CodePlayer | packages/qt-code/src/Player.tsx:113 |
| 330 | 26 | PoolView | apps/web/src/pool/PoolView.tsx:205 |
| 321 | 16 | BulkBar | apps/web/src/pool/BulkBar.tsx:44 |
| 313 | 2 | StudentGrid | apps/web/src/live/StudentGrid.tsx:79 |
| 307 | 1 | evaluationPlugin | apps/api/src/modules/evaluation/routes.ts:66 |
| 305 | 23 | Player | apps/web/src/student/Player.tsx:97 |
| 302 | 23 | EvaluationConfig | apps/web/src/evaluation/EvaluationConfig.tsx:111 |
| 297 | 10 | Menu | apps/web/src/ui.tsx:998 |
| 294 | 6 | useAttempt | apps/web/src/attempt/useAttempt.ts:97 |
| 292 | 1 | gradingPlugin | apps/api/src/modules/grading/routes.ts:61 |
| 280 | 11 | FilterBar | apps/web/src/pool/FilterBar.tsx:311 |
| 264 | 65 | extractNets | packages/qt-circuit/src/netlist.ts:234 |
| 259 | 14 | Shell | apps/web/src/Shell.tsx:325 |
| 246 | 19 | Row | apps/web/src/RosterTable.tsx:51 |
| 239 | 6 | AdvancedDisclosure | apps/web/src/evaluation/AdvancedDisclosure.tsx:19 |
| 237 | 17 | ClassroomView | apps/web/src/ClassroomView.tsx:201 |

## All non-test files (LOC, functions, sum CC, max CC)

- apps/api/drizzle.config.ts: 14 LOC, 0 fn, ΣCC 0, max 0
- apps/api/src/app.ts: 267 LOC, 13 fn, ΣCC 39, max 9
- apps/api/src/audit.ts: 107 LOC, 1 fn, ΣCC 3, max 3
- apps/api/src/auth/claims.ts: 178 LOC, 16 fn, ΣCC 26, max 4
- apps/api/src/auth/dev.ts: 170 LOC, 10 fn, ΣCC 16, max 4
- apps/api/src/auth/oidc.ts: 161 LOC, 6 fn, ΣCC 20, max 9
- apps/api/src/auth/plugin.ts: 336 LOC, 15 fn, ΣCC 44, max 8
- apps/api/src/auth/returnTo.ts: 26 LOC, 2 fn, ΣCC 8, max 5
- apps/api/src/auth/session.ts: 70 LOC, 6 fn, ΣCC 11, max 6
- apps/api/src/clock.ts: 49 LOC, 7 fn, ΣCC 11, max 3
- apps/api/src/config.ts: 228 LOC, 6 fn, ΣCC 25, max 15
- apps/api/src/db/auth.ts: 197 LOC, 11 fn, ΣCC 11, max 1
- apps/api/src/db/client.ts: 73 LOC, 6 fn, ΣCC 7, max 2
- apps/api/src/db/evaluation.ts: 127 LOC, 6 fn, ΣCC 6, max 1
- apps/api/src/db/grading.ts: 132 LOC, 12 fn, ΣCC 12, max 1
- apps/api/src/db/live.ts: 165 LOC, 11 fn, ΣCC 11, max 1
- apps/api/src/db/notifications.ts: 41 LOC, 2 fn, ΣCC 2, max 1
- apps/api/src/db/org.ts: 116 LOC, 8 fn, ΣCC 8, max 1
- apps/api/src/db/pool.ts: 306 LOC, 28 fn, ΣCC 28, max 1
- apps/api/src/db/schema.ts: 17 LOC, 0 fn, ΣCC 0, max 0
- apps/api/src/events.ts: 87 LOC, 4 fn, ΣCC 7, max 3
- apps/api/src/identity.ts: 75 LOC, 8 fn, ΣCC 10, max 2
- apps/api/src/jobs.ts: 193 LOC, 15 fn, ΣCC 30, max 6
- apps/api/src/modules/admin.ts: 112 LOC, 5 fn, ΣCC 11, max 4
- apps/api/src/modules/avatar.ts: 96 LOC, 7 fn, ΣCC 14, max 6
- apps/api/src/modules/courses.ts: 580 LOC, 24 fn, ΣCC 80, max 12
- apps/api/src/modules/evaluation/events.ts: 32 LOC, 2 fn, ΣCC 2, max 1
- apps/api/src/modules/evaluation/routes.ts: 373 LOC, 21 fn, ΣCC 72, max 7
- apps/api/src/modules/evaluation/service.ts: 988 LOC, 71 fn, ΣCC 161, max 18
- apps/api/src/modules/grading/events.ts: 60 LOC, 7 fn, ΣCC 7, max 1
- apps/api/src/modules/grading/jobs.ts: 487 LOC, 13 fn, ΣCC 57, max 19
- apps/api/src/modules/grading/routes.ts: 353 LOC, 19 fn, ΣCC 59, max 8
- apps/api/src/modules/grading/service.ts: 625 LOC, 36 fn, ΣCC 108, max 21
- apps/api/src/modules/guards.ts: 516 LOC, 26 fn, ΣCC 57, max 4
- apps/api/src/modules/live/events.ts: 133 LOC, 10 fn, ΣCC 11, max 2
- apps/api/src/modules/live/jobs.ts: 59 LOC, 4 fn, ΣCC 4, max 1
- apps/api/src/modules/live/routes.ts: 548 LOC, 29 fn, ΣCC 104, max 8
- apps/api/src/modules/live/service.ts: 2104 LOC, 120 fn, ΣCC 388, max 19
- apps/api/src/modules/live/studentView.ts: 129 LOC, 6 fn, ΣCC 14, max 7
- apps/api/src/modules/notifications/routes.ts: 44 LOC, 5 fn, ΣCC 8, max 3
- apps/api/src/modules/notifications/service.ts: 161 LOC, 6 fn, ΣCC 11, max 4
- apps/api/src/modules/org/routes.ts: 164 LOC, 9 fn, ΣCC 22, max 7
- apps/api/src/modules/org/service.ts: 122 LOC, 5 fn, ΣCC 18, max 6
- apps/api/src/modules/poll/events.ts: 46 LOC, 3 fn, ΣCC 3, max 1
- apps/api/src/modules/poll/routes.ts: 446 LOC, 25 fn, ΣCC 84, max 10
- apps/api/src/modules/poll/service.ts: 726 LOC, 43 fn, ΣCC 94, max 10
- apps/api/src/modules/pool/assets.ts: 141 LOC, 10 fn, ΣCC 39, max 14
- apps/api/src/modules/pool/config.ts: 183 LOC, 13 fn, ΣCC 33, max 8
- apps/api/src/modules/pool/events.ts: 31 LOC, 3 fn, ΣCC 3, max 1
- apps/api/src/modules/pool/routes.ts: 1251 LOC, 56 fn, ΣCC 235, max 18
- apps/api/src/modules/pool/service.ts: 1912 LOC, 117 fn, ΣCC 248, max 10
- apps/api/src/modules/realtime/bus.ts: 277 LOC, 22 fn, ΣCC 22, max 1
- apps/api/src/modules/realtime/coalesce.ts: 85 LOC, 9 fn, ΣCC 15, max 3
- apps/api/src/modules/realtime/presence.ts: 136 LOC, 10 fn, ΣCC 27, max 6
- apps/api/src/modules/realtime/routes.ts: 394 LOC, 21 fn, ΣCC 86, max 15
- apps/api/src/modules/results/csv.ts: 101 LOC, 10 fn, ΣCC 14, max 3
- apps/api/src/modules/results/routes.ts: 188 LOC, 15 fn, ΣCC 32, max 6
- apps/api/src/modules/results/service.ts: 659 LOC, 45 fn, ΣCC 135, max 20
- apps/api/src/modules/roster.ts: 262 LOC, 9 fn, ΣCC 33, max 9
- apps/api/src/modules/runner/http.ts: 146 LOC, 11 fn, ΣCC 31, max 6
- apps/api/src/modules/runner/index.ts: 56 LOC, 2 fn, ΣCC 7, max 4
- apps/api/src/modules/runner/unavailable.ts: 29 LOC, 3 fn, ΣCC 3, max 1
- apps/api/src/modules/student.ts: 56 LOC, 6 fn, ΣCC 7, max 2
- apps/api/src/paths.ts: 10 LOC, 0 fn, ΣCC 0, max 0
- apps/api/src/roles.ts: 140 LOC, 7 fn, ΣCC 23, max 10
- apps/api/src/seed.ts: 146 LOC, 8 fn, ΣCC 13, max 6
- apps/api/src/seed/content.ts: 738 LOC, 0 fn, ΣCC 0, max 0
- apps/api/src/seed/demo.ts: 414 LOC, 18 fn, ΣCC 60, max 15
- apps/api/src/server.ts: 32 LOC, 2 fn, ΣCC 2, max 1
- apps/api/src/ticker.ts: 81 LOC, 6 fn, ΣCC 12, max 7
- apps/api/vitest.config.ts: 18 LOC, 0 fn, ΣCC 0, max 0
- apps/runner/scripts/dev.mjs: 40 LOC, 2 fn, ΣCC 3, max 2
- apps/runner/src/app.ts: 61 LOC, 2 fn, ΣCC 5, max 4
- apps/runner/src/config.ts: 142 LOC, 5 fn, ΣCC 15, max 8
- apps/runner/src/engine.ts: 318 LOC, 24 fn, ΣCC 37, max 3
- apps/runner/src/execute.ts: 262 LOC, 14 fn, ΣCC 39, max 12
- apps/runner/src/images.ts: 50 LOC, 5 fn, ΣCC 6, max 2
- apps/runner/src/languages.ts: 143 LOC, 16 fn, ΣCC 20, max 3
- apps/runner/src/probe.ts: 117 LOC, 10 fn, ΣCC 25, max 15
- apps/runner/src/queue.ts: 124 LOC, 15 fn, ΣCC 22, max 3
- apps/runner/src/routes.ts: 133 LOC, 7 fn, ΣCC 23, max 6
- apps/runner/src/server.ts: 19 LOC, 2 fn, ΣCC 2, max 1
- apps/runner/vitest.config.ts: 14 LOC, 0 fn, ΣCC 0, max 0
- apps/runner/vitest.integration.config.ts: 20 LOC, 0 fn, ΣCC 0, max 0
- apps/web/scripts/docs-screenshots-index.mjs: 51 LOC, 4 fn, ΣCC 11, max 5
- apps/web/scripts/docs-screenshots.mjs: 1320 LOC, 162 fn, ΣCC 238, max 11
- apps/web/scripts/fetch-runtimes.mjs: 105 LOC, 4 fn, ΣCC 7, max 3
- apps/web/scripts/screenshots.mjs: 451 LOC, 72 fn, ΣCC 82, max 6
- apps/web/src/AdminPanel.tsx: 202 LOC, 14 fn, ΣCC 32, max 6
- apps/web/src/App.tsx: 286 LOC, 45 fn, ΣCC 84, max 36
- apps/web/src/AvatarEditor.tsx: 216 LOC, 25 fn, ΣCC 39, max 6
- apps/web/src/Breadcrumb.tsx: 29 LOC, 2 fn, ΣCC 4, max 3
- apps/web/src/ClassroomView.tsx: 438 LOC, 38 fn, ΣCC 63, max 17
- apps/web/src/CommandPalette.tsx: 274 LOC, 16 fn, ΣCC 33, max 9
- apps/web/src/DevGallery.tsx: 312 LOC, 13 fn, ΣCC 20, max 4
- apps/web/src/Header.tsx: 218 LOC, 9 fn, ΣCC 22, max 8
- apps/web/src/RosterImport.tsx: 245 LOC, 19 fn, ΣCC 37, max 11
- apps/web/src/RosterTable.tsx: 362 LOC, 22 fn, ΣCC 48, max 19
- apps/web/src/SettingsPage.tsx: 229 LOC, 18 fn, ΣCC 26, max 5
- apps/web/src/Shell.tsx: 584 LOC, 42 fn, ΣCC 86, max 15
- apps/web/src/TeacherHome.tsx: 715 LOC, 65 fn, ΣCC 100, max 12
- apps/web/src/api.ts: 73 LOC, 8 fn, ΣCC 24, max 11
- apps/web/src/attempt/attemptStream.ts: 102 LOC, 12 fn, ΣCC 19, max 3
- apps/web/src/attempt/autosave.ts: 349 LOC, 26 fn, ΣCC 83, max 7
- apps/web/src/attempt/playerReducer.ts: 164 LOC, 13 fn, ΣCC 45, max 18
- apps/web/src/attempt/useAttempt.ts: 391 LOC, 32 fn, ΣCC 80, max 13
- apps/web/src/commands.ts: 383 LOC, 32 fn, ΣCC 63, max 27
- apps/web/src/confirm.tsx: 80 LOC, 10 fn, ΣCC 15, max 6
- apps/web/src/evaluation/AddQuestionsSheet.tsx: 242 LOC, 21 fn, ΣCC 46, max 20
- apps/web/src/evaluation/AdvancedDisclosure.tsx: 258 LOC, 21 fn, ΣCC 33, max 6
- apps/web/src/evaluation/EvaluationConfig.tsx: 413 LOC, 32 fn, ΣCC 63, max 23
- apps/web/src/evaluation/EvaluationList.tsx: 354 LOC, 27 fn, ΣCC 48, max 9
- apps/web/src/evaluation/ItemsStep.tsx: 500 LOC, 36 fn, ΣCC 72, max 12
- apps/web/src/evaluation/LaunchStep.tsx: 130 LOC, 8 fn, ΣCC 22, max 15
- apps/web/src/evaluation/PreviewSheet.tsx: 102 LOC, 6 fn, ΣCC 11, max 5
- apps/web/src/evaluation/TimingStep.tsx: 201 LOC, 12 fn, ΣCC 27, max 6
- apps/web/src/evaluation/common.ts: 69 LOC, 9 fn, ΣCC 17, max 5
- apps/web/src/evaluation/presets.ts: 67 LOC, 2 fn, ΣCC 7, max 5
- apps/web/src/evaluation/usePatch.ts: 26 LOC, 3 fn, ΣCC 3, max 1
- apps/web/src/fuzzy.ts: 37 LOC, 6 fn, ΣCC 15, max 9
- apps/web/src/grading/BatchBar.tsx: 107 LOC, 6 fn, ΣCC 11, max 4
- apps/web/src/grading/EntryDetail.tsx: 123 LOC, 1 fn, ΣCC 13, max 13
- apps/web/src/grading/EntryList.tsx: 103 LOC, 4 fn, ΣCC 11, max 8
- apps/web/src/grading/GradingHeader.tsx: 130 LOC, 2 fn, ΣCC 14, max 11
- apps/web/src/grading/GradingPanel.tsx: 569 LOC, 59 fn, ΣCC 136, max 40
- apps/web/src/grading/HistoryPopover.tsx: 102 LOC, 8 fn, ΣCC 15, max 4
- apps/web/src/grading/ListSkeleton.tsx: 14 LOC, 1 fn, ΣCC 1, max 1
- apps/web/src/grading/OverrideSheet.tsx: 136 LOC, 8 fn, ΣCC 24, max 13
- apps/web/src/grading/RegradeSheet.tsx: 122 LOC, 7 fn, ΣCC 13, max 5
- apps/web/src/grading/fixtures.ts: 265 LOC, 9 fn, ΣCC 10, max 2
- apps/web/src/grading/index.ts: 38 LOC, 2 fn, ΣCC 2, max 1
- apps/web/src/grading/labels.ts: 77 LOC, 9 fn, ΣCC 23, max 8
- apps/web/src/grading/progress.ts: 74 LOC, 7 fn, ΣCC 14, max 4
- apps/web/src/help.tsx: 196 LOC, 14 fn, ΣCC 28, max 6
- apps/web/src/i18n.tsx: 3923 LOC, 13 fn, ΣCC 30, max 11
- apps/web/src/live.ts: 34 LOC, 3 fn, ΣCC 4, max 2
- apps/web/src/live/InspectModal.tsx: 236 LOC, 15 fn, ΣCC 44, max 12
- apps/web/src/live/Legend.tsx: 43 LOC, 2 fn, ΣCC 2, max 1
- apps/web/src/live/LiveDashboard.tsx: 415 LOC, 36 fn, ΣCC 93, max 25
- apps/web/src/live/LiveHeader.tsx: 141 LOC, 4 fn, ΣCC 16, max 13
- apps/web/src/live/LobbyPanel.tsx: 89 LOC, 6 fn, ΣCC 13, max 5
- apps/web/src/live/StudentGrid.tsx: 392 LOC, 15 fn, ΣCC 46, max 20
- apps/web/src/live/cells.ts: 84 LOC, 7 fn, ΣCC 20, max 10
- apps/web/src/live/useDashboard.ts: 82 LOC, 8 fn, ΣCC 13, max 3
- apps/web/src/live/useLiveCommands.ts: 86 LOC, 5 fn, ΣCC 12, max 8
- apps/web/src/main.tsx: 55 LOC, 2 fn, ΣCC 5, max 3
- apps/web/src/markdown.tsx: 80 LOC, 5 fn, ΣCC 14, max 7
- apps/web/src/markdown/BlankPopover.tsx: 404 LOC, 41 fn, ΣCC 84, max 16
- apps/web/src/markdown/CodeBlockView.tsx: 85 LOC, 5 fn, ΣCC 12, max 4
- apps/web/src/markdown/FormulaDialog.tsx: 266 LOC, 15 fn, ΣCC 34, max 6
- apps/web/src/markdown/ImageView.tsx: 216 LOC, 15 fn, ΣCC 41, max 14
- apps/web/src/markdown/MarkdownField.tsx: 109 LOC, 2 fn, ΣCC 9, max 8
- apps/web/src/markdown/MarkdownView.tsx: 75 LOC, 3 fn, ΣCC 12, max 5
- apps/web/src/markdown/RichText.tsx: 1185 LOC, 69 fn, ΣCC 255, max 40
- apps/web/src/markdown/SourcePane.tsx: 236 LOC, 29 fn, ΣCC 58, max 10
- apps/web/src/markdown/clozeHole.ts: 330 LOC, 23 fn, ΣCC 67, max 10
- apps/web/src/markdown/codeHighlight.ts: 165 LOC, 18 fn, ΣCC 31, max 5
- apps/web/src/markdown/highlight.ts: 173 LOC, 6 fn, ΣCC 31, max 19
- apps/web/src/markdown/insert.ts: 142 LOC, 6 fn, ΣCC 33, max 13
- apps/web/src/markdown/render.ts: 278 LOC, 10 fn, ΣCC 49, max 12
- apps/web/src/markdown/tiptap.ts: 577 LOC, 26 fn, ΣCC 90, max 19
- apps/web/src/notifications/NotificationBell.tsx: 306 LOC, 20 fn, ΣCC 48, max 15
- apps/web/src/notify.tsx: 179 LOC, 21 fn, ΣCC 27, max 3
- apps/web/src/poll/PollBars.tsx: 148 LOC, 3 fn, ΣCC 20, max 16
- apps/web/src/poll/PollJoin.tsx: 404 LOC, 27 fn, ΣCC 65, max 25
- apps/web/src/poll/PollJoinReveal.tsx: 202 LOC, 10 fn, ΣCC 29, max 7
- apps/web/src/poll/PollLauncher.tsx: 355 LOC, 29 fn, ΣCC 53, max 15
- apps/web/src/poll/PollProjection.tsx: 635 LOC, 43 fn, ΣCC 121, max 28
- apps/web/src/poll/PollQr.tsx: 88 LOC, 5 fn, ΣCC 9, max 3
- apps/web/src/poll/fit.ts: 117 LOC, 4 fn, ΣCC 16, max 6
- apps/web/src/poll/pollTally.ts: 178 LOC, 11 fn, ΣCC 22, max 3
- apps/web/src/pool/BulkBar.tsx: 365 LOC, 37 fn, ΣCC 69, max 16
- apps/web/src/pool/CategoryTree.tsx: 444 LOC, 42 fn, ΣCC 75, max 11
- apps/web/src/pool/FilterBar.tsx: 591 LOC, 64 fn, ΣCC 107, max 11
- apps/web/src/pool/IconCatalogue.tsx: 68 LOC, 7 fn, ΣCC 8, max 2
- apps/web/src/pool/IconTile.tsx: 44 LOC, 1 fn, ΣCC 2, max 2
- apps/web/src/pool/PoolIcon.tsx: 137 LOC, 4 fn, ΣCC 6, max 3
- apps/web/src/pool/PoolIconPicker.tsx: 83 LOC, 7 fn, ΣCC 11, max 5
- apps/web/src/pool/PoolNav.tsx: 196 LOC, 13 fn, ΣCC 34, max 10
- apps/web/src/pool/PoolShareSheet.tsx: 315 LOC, 25 fn, ΣCC 41, max 8
- apps/web/src/pool/PoolView.tsx: 548 LOC, 64 fn, ΣCC 114, max 26
- apps/web/src/pool/PoolsPage.tsx: 557 LOC, 41 fn, ΣCC 86, max 12
- apps/web/src/pool/QuestionCards.tsx: 187 LOC, 14 fn, ΣCC 21, max 6
- apps/web/src/pool/QuestionGroups.ts: 102 LOC, 11 fn, ΣCC 26, max 12
- apps/web/src/pool/QuestionTable.tsx: 302 LOC, 22 fn, ΣCC 35, max 6
- apps/web/src/pool/QuestionTypePicker.tsx: 64 LOC, 3 fn, ΣCC 6, max 4
- apps/web/src/pool/TeacherPicker.tsx: 192 LOC, 17 fn, ΣCC 38, max 10
- apps/web/src/pool/filters.ts: 141 LOC, 11 fn, ΣCC 29, max 12
- apps/web/src/pool/move.tsx: 206 LOC, 18 fn, ΣCC 43, max 9
- apps/web/src/pool/poolIcons.ts: 73 LOC, 0 fn, ΣCC 0, max 0
- apps/web/src/pool/searchSyntax.ts: 285 LOC, 14 fn, ΣCC 67, max 18
- apps/web/src/question/MetaPanel.tsx: 115 LOC, 13 fn, ΣCC 19, max 3
- apps/web/src/question/PublishDialog.tsx: 97 LOC, 5 fn, ΣCC 11, max 5
- apps/web/src/question/QuestionEditor.tsx: 664 LOC, 38 fn, ΣCC 94, max 28
- apps/web/src/question/StudentPreviewPage.tsx: 126 LOC, 5 fn, ΣCC 8, max 4
- apps/web/src/question/TagInput.tsx: 377 LOC, 43 fn, ΣCC 99, max 21
- apps/web/src/question/TryPanel.tsx: 184 LOC, 9 fn, ΣCC 19, max 10
- apps/web/src/question/VersionHistory.tsx: 255 LOC, 22 fn, ΣCC 36, max 5
- apps/web/src/question/autosave.ts: 114 LOC, 8 fn, ΣCC 16, max 4
- apps/web/src/question/issues.ts: 48 LOC, 4 fn, ΣCC 6, max 2
- apps/web/src/questionTypes.tsx: 567 LOC, 94 fn, ΣCC 120, max 7
- apps/web/src/realtime/clock.ts: 99 LOC, 6 fn, ΣCC 11, max 3
- apps/web/src/realtime/grid.ts: 292 LOC, 23 fn, ΣCC 71, max 12
- apps/web/src/realtime/useEventStream.ts: 244 LOC, 18 fn, ΣCC 46, max 7
- apps/web/src/realtime/useServerClock.ts: 64 LOC, 4 fn, ΣCC 7, max 3
- apps/web/src/results/ByQuestionView.tsx: 172 LOC, 7 fn, ΣCC 21, max 8
- apps/web/src/results/ExportButton.tsx: 21 LOC, 1 fn, ΣCC 1, max 1
- apps/web/src/results/GradeTable.tsx: 123 LOC, 4 fn, ΣCC 12, max 7
- apps/web/src/results/Histogram.tsx: 84 LOC, 6 fn, ΣCC 11, max 4
- apps/web/src/results/ResultsView.tsx: 274 LOC, 18 fn, ΣCC 43, max 19
- apps/web/src/results/StatsRow.tsx: 40 LOC, 4 fn, ΣCC 5, max 2
- apps/web/src/router.ts: 201 LOC, 14 fn, ΣCC 61, max 26
- apps/web/src/runner/codeRun.ts: 141 LOC, 11 fn, ΣCC 18, max 4
- apps/web/src/runner/index.ts: 111 LOC, 4 fn, ΣCC 20, max 13
- apps/web/src/runner/runno/engine.ts: 412 LOC, 15 fn, ΣCC 51, max 15
- apps/web/src/runner/runno/protocol.ts: 62 LOC, 0 fn, ΣCC 0, max 0
- apps/web/src/runner/runno/runner.ts: 362 LOC, 29 fn, ΣCC 71, max 16
- apps/web/src/runner/runno/tar.ts: 81 LOC, 6 fn, ΣCC 21, max 11
- apps/web/src/runner/runno/worker.ts: 23 LOC, 3 fn, ΣCC 4, max 2
- apps/web/src/runner/types.ts: 41 LOC, 1 fn, ΣCC 1, max 1
- apps/web/src/screenCommands.ts: 37 LOC, 4 fn, ΣCC 4, max 1
- apps/web/src/shortcuts.tsx: 103 LOC, 14 fn, ΣCC 18, max 3
- apps/web/src/student/Attempt.tsx: 188 LOC, 12 fn, ΣCC 33, max 18
- apps/web/src/student/ClosedScreen.tsx: 94 LOC, 1 fn, ΣCC 3, max 3
- apps/web/src/student/Feedback.tsx: 173 LOC, 5 fn, ΣCC 14, max 6
- apps/web/src/student/Lobby.tsx: 157 LOC, 6 fn, ΣCC 19, max 9
- apps/web/src/student/OfflineBanner.tsx: 26 LOC, 1 fn, ΣCC 2, max 2
- apps/web/src/student/PausedOverlay.tsx: 36 LOC, 1 fn, ΣCC 2, max 2
- apps/web/src/student/Player.tsx: 402 LOC, 26 fn, ΣCC 79, max 23
- apps/web/src/student/PlayerShell.tsx: 182 LOC, 7 fn, ΣCC 28, max 15
- apps/web/src/student/QuestionHost.tsx: 112 LOC, 2 fn, ΣCC 7, max 6
- apps/web/src/student/StudentHome.tsx: 325 LOC, 19 fn, ΣCC 53, max 14
- apps/web/src/student/SubmitDialog.tsx: 67 LOC, 4 fn, ΣCC 9, max 6
- apps/web/src/student/questionStrings.ts: 80 LOC, 7 fn, ΣCC 12, max 6
- apps/web/src/studentView.ts: 122 LOC, 9 fn, ΣCC 14, max 4
- apps/web/src/theme.ts: 96 LOC, 15 fn, ΣCC 23, max 3
- apps/web/src/ui.tsx: 2975 LOC, 177 fn, ΣCC 475, max 17
- apps/web/vite.config.ts: 55 LOC, 0 fn, ΣCC 0, max 0
- packages/contracts/src/api.ts: 148 LOC, 2 fn, ΣCC 3, max 2
- packages/contracts/src/common.ts: 60 LOC, 5 fn, ΣCC 9, max 3
- packages/contracts/src/evaluation.ts: 287 LOC, 5 fn, ΣCC 5, max 1
- packages/contracts/src/grading.ts: 188 LOC, 1 fn, ΣCC 3, max 3
- packages/contracts/src/health.ts: 20 LOC, 0 fn, ΣCC 0, max 0
- packages/contracts/src/index.ts: 13 LOC, 0 fn, ΣCC 0, max 0
- packages/contracts/src/live.ts: 412 LOC, 2 fn, ΣCC 5, max 3
- packages/contracts/src/notifications.ts: 60 LOC, 0 fn, ΣCC 0, max 0
- packages/contracts/src/org.ts: 127 LOC, 3 fn, ΣCC 3, max 1
- packages/contracts/src/poll.ts: 170 LOC, 0 fn, ΣCC 0, max 0
- packages/contracts/src/pool.ts: 508 LOC, 6 fn, ΣCC 8, max 3
- packages/contracts/src/realtime.ts: 261 LOC, 2 fn, ΣCC 2, max 1
- packages/contracts/src/results.ts: 211 LOC, 0 fn, ΣCC 0, max 0
- packages/core/src/client.ts: 243 LOC, 1 fn, ΣCC 2, max 2
- packages/core/src/contract.ts: 254 LOC, 4 fn, ΣCC 6, max 2
- packages/core/src/errors.ts: 59 LOC, 5 fn, ΣCC 5, max 1
- packages/core/src/index.ts: 13 LOC, 0 fn, ΣCC 0, max 0
- packages/core/src/llm.ts: 29 LOC, 0 fn, ΣCC 0, max 0
- packages/core/src/registry.ts: 52 LOC, 5 fn, ΣCC 6, max 2
- packages/core/src/rng.ts: 67 LOC, 6 fn, ΣCC 9, max 2
- packages/core/src/runner.ts: 78 LOC, 0 fn, ΣCC 0, max 0
- packages/core/vitest.config.ts: 8 LOC, 0 fn, ΣCC 0, max 0
- packages/domain/src/cloze.ts: 447 LOC, 29 fn, ΣCC 93, max 17
- packages/domain/src/compareOutput.ts: 52 LOC, 7 fn, ΣCC 15, max 4
- packages/domain/src/deadline.ts: 78 LOC, 4 fn, ΣCC 17, max 8
- packages/domain/src/grade.ts: 34 LOC, 2 fn, ΣCC 5, max 4
- packages/domain/src/index.ts: 27 LOC, 0 fn, ΣCC 0, max 0
- packages/domain/src/lockedTemplate.ts: 147 LOC, 12 fn, ΣCC 36, max 11
- packages/domain/src/mcqScore.ts: 138 LOC, 4 fn, ΣCC 21, max 13
- packages/domain/src/pollTally.ts: 136 LOC, 7 fn, ΣCC 29, max 10
- packages/domain/src/poolRole.ts: 56 LOC, 2 fn, ΣCC 7, max 6
- packages/domain/src/pseudonym.ts: 59 LOC, 2 fn, ΣCC 5, max 4
- packages/domain/src/roster.ts: 225 LOC, 20 fn, ΣCC 58, max 12
- packages/domain/src/round.ts: 42 LOC, 4 fn, ΣCC 7, max 3
- packages/domain/src/short.ts: 336 LOC, 23 fn, ΣCC 81, max 13
- packages/domain/src/stats.ts: 79 LOC, 7 fn, ΣCC 16, max 5
- packages/domain/vitest.config.ts: 21 LOC, 0 fn, ΣCC 0, max 0
- packages/qt-circuit/src/Editor.tsx: 1021 LOC, 70 fn, ΣCC 137, max 30
- packages/qt-circuit/src/Player.tsx: 347 LOC, 16 fn, ΣCC 75, max 26
- packages/qt-circuit/src/Review.tsx: 333 LOC, 12 fn, ΣCC 81, max 29
- packages/qt-circuit/src/canonical.ts: 90 LOC, 12 fn, ΣCC 33, max 9
- packages/qt-circuit/src/canvas/Plot.tsx: 374 LOC, 22 fn, ΣCC 82, max 22
- packages/qt-circuit/src/canvas/SchematicEditor.tsx: 1353 LOC, 135 fn, ΣCC 398, max 38
- packages/qt-circuit/src/canvas/SchematicView.tsx: 427 LOC, 21 fn, ΣCC 61, max 12
- packages/qt-circuit/src/canvas/canvasStrings.ts: 129 LOC, 8 fn, ΣCC 12, max 4
- packages/qt-circuit/src/canvas/canvasStyles.ts: 186 LOC, 6 fn, ΣCC 13, max 4
- packages/qt-circuit/src/canvas/geometry.ts: 458 LOC, 35 fn, ΣCC 79, max 10
- packages/qt-circuit/src/canvas/history.ts: 74 LOC, 9 fn, ΣCC 12, max 2
- packages/qt-circuit/src/canvas/index.ts: 97 LOC, 0 fn, ΣCC 0, max 0
- packages/qt-circuit/src/canvas/router.ts: 413 LOC, 21 fn, ΣCC 148, max 37
- packages/qt-circuit/src/canvas/symbols.ts: 241 LOC, 5 fn, ΣCC 6, max 2
- packages/qt-circuit/src/client.tsx: 142 LOC, 8 fn, ΣCC 13, max 4
- packages/qt-circuit/src/grade.ts: 550 LOC, 29 fn, ΣCC 108, max 16
- packages/qt-circuit/src/library.ts: 422 LOC, 8 fn, ΣCC 21, max 6
- packages/qt-circuit/src/netlist.ts: 512 LOC, 29 fn, ΣCC 120, max 65
- packages/qt-circuit/src/schema.ts: 411 LOC, 11 fn, ΣCC 14, max 2
- packages/qt-circuit/src/server.ts: 190 LOC, 17 fn, ΣCC 23, max 6
- packages/qt-circuit/src/spice.ts: 471 LOC, 22 fn, ΣCC 85, max 19
- packages/qt-circuit/src/strings.ts: 431 LOC, 36 fn, ΣCC 40, max 2
- packages/qt-circuit/src/styles.ts: 147 LOC, 5 fn, ΣCC 11, max 4
- packages/qt-circuit/vitest.config.ts: 15 LOC, 0 fn, ΣCC 0, max 0
- packages/qt-cloze/src/Editor.tsx: 161 LOC, 8 fn, ΣCC 13, max 6
- packages/qt-cloze/src/Player.tsx: 103 LOC, 8 fn, ΣCC 16, max 5
- packages/qt-cloze/src/Review.tsx: 140 LOC, 8 fn, ΣCC 30, max 8
- packages/qt-cloze/src/canonical.ts: 26 LOC, 2 fn, ΣCC 4, max 3
- packages/qt-cloze/src/client.tsx: 91 LOC, 10 fn, ΣCC 14, max 2
- packages/qt-cloze/src/fixtures.ts: 65 LOC, 4 fn, ΣCC 4, max 1
- packages/qt-cloze/src/grade.ts: 34 LOC, 1 fn, ΣCC 2, max 2
- packages/qt-cloze/src/schema.ts: 126 LOC, 2 fn, ΣCC 5, max 4
- packages/qt-cloze/src/server.ts: 139 LOC, 14 fn, ΣCC 25, max 5
- packages/qt-cloze/src/strings.ts: 45 LOC, 0 fn, ΣCC 0, max 0
- packages/qt-cloze/src/test-setup.ts: 7 LOC, 0 fn, ΣCC 0, max 0
- packages/qt-cloze/src/text.tsx: 265 LOC, 16 fn, ΣCC 58, max 8
- packages/qt-cloze/src/ui.tsx: 58 LOC, 9 fn, ΣCC 10, max 2
- packages/qt-cloze/vitest.config.ts: 29 LOC, 0 fn, ΣCC 0, max 0
- packages/qt-code/src/Editor.tsx: 757 LOC, 47 fn, ΣCC 105, max 20
- packages/qt-code/src/MonacoHost.tsx: 159 LOC, 8 fn, ΣCC 20, max 9
- packages/qt-code/src/Player.tsx: 453 LOC, 19 fn, ΣCC 92, max 35
- packages/qt-code/src/Review.tsx: 202 LOC, 7 fn, ΣCC 44, max 18
- packages/qt-code/src/canonical.ts: 61 LOC, 6 fn, ΣCC 23, max 8
- packages/qt-code/src/client.tsx: 116 LOC, 9 fn, ΣCC 15, max 5
- packages/qt-code/src/grade.ts: 310 LOC, 17 fn, ΣCC 45, max 11
- packages/qt-code/src/reference.ts: 63 LOC, 3 fn, ΣCC 10, max 8
- packages/qt-code/src/schema.ts: 305 LOC, 6 fn, ΣCC 8, max 2
- packages/qt-code/src/segments.ts: 81 LOC, 12 fn, ΣCC 14, max 2
- packages/qt-code/src/server.ts: 171 LOC, 17 fn, ΣCC 26, max 6
- packages/qt-code/src/strings.ts: 288 LOC, 15 fn, ΣCC 19, max 2
- packages/qt-code/src/styles.ts: 87 LOC, 3 fn, ΣCC 3, max 1
- packages/qt-code/vitest.config.ts: 17 LOC, 0 fn, ΣCC 0, max 0
- packages/qt-mcq/src/Editor.tsx: 658 LOC, 35 fn, ΣCC 92, max 18
- packages/qt-mcq/src/Player.tsx: 107 LOC, 6 fn, ΣCC 23, max 9
- packages/qt-mcq/src/Review.tsx: 91 LOC, 2 fn, ΣCC 21, max 13
- packages/qt-mcq/src/Stats.tsx: 57 LOC, 4 fn, ΣCC 6, max 2
- packages/qt-mcq/src/canonical.ts: 51 LOC, 3 fn, ΣCC 8, max 5
- packages/qt-mcq/src/client.tsx: 87 LOC, 10 fn, ΣCC 14, max 3
- packages/qt-mcq/src/fixtures.ts: 70 LOC, 4 fn, ΣCC 5, max 2
- packages/qt-mcq/src/grade.ts: 89 LOC, 2 fn, ΣCC 7, max 4
- packages/qt-mcq/src/schema.ts: 172 LOC, 10 fn, ΣCC 13, max 2
- packages/qt-mcq/src/server.ts: 163 LOC, 16 fn, ΣCC 27, max 3
- packages/qt-mcq/src/strings.ts: 110 LOC, 0 fn, ΣCC 0, max 0
- packages/qt-mcq/src/test-setup.ts: 7 LOC, 0 fn, ΣCC 0, max 0
- packages/qt-mcq/src/ui.tsx: 338 LOC, 16 fn, ΣCC 26, max 5
- packages/qt-mcq/vitest.config.ts: 29 LOC, 0 fn, ΣCC 0, max 0
- packages/qt-short/src/Editor.tsx: 611 LOC, 47 fn, ΣCC 83, max 9
- packages/qt-short/src/Player.tsx: 125 LOC, 3 fn, ΣCC 22, max 12
- packages/qt-short/src/Review.tsx: 96 LOC, 2 fn, ΣCC 14, max 13
- packages/qt-short/src/canonical.ts: 101 LOC, 5 fn, ΣCC 33, max 16
- packages/qt-short/src/client.tsx: 89 LOC, 7 fn, ΣCC 11, max 4
- packages/qt-short/src/fixtures.ts: 61 LOC, 4 fn, ΣCC 4, max 1
- packages/qt-short/src/grade.ts: 99 LOC, 6 fn, ΣCC 17, max 5
- packages/qt-short/src/schema.ts: 209 LOC, 5 fn, ΣCC 17, max 8
- packages/qt-short/src/server.ts: 173 LOC, 13 fn, ΣCC 25, max 6
- packages/qt-short/src/strings.ts: 79 LOC, 0 fn, ΣCC 0, max 0
- packages/qt-short/src/test-setup.ts: 7 LOC, 0 fn, ΣCC 0, max 0
- packages/qt-short/src/ui.tsx: 171 LOC, 14 fn, ΣCC 20, max 3
- packages/qt-short/vitest.config.ts: 29 LOC, 0 fn, ΣCC 0, max 0
- packages/registry/src/client.ts: 36 LOC, 0 fn, ΣCC 0, max 0
- packages/registry/src/server.ts: 73 LOC, 4 fn, ΣCC 6, max 2
- packages/registry/vitest.config.ts: 8 LOC, 0 fn, ΣCC 0, max 0
- scripts/.audit-tmp/cc.ts: 100 LOC, 14 fn, ΣCC 60, max 18
