---
search:
  exclude: true
---

# High-complexity disposition

> Snapshot of baseline `59c8925a` (2026-10-03). Paths and line numbers drift as
> `main` moves: re-measure before acting on a row.

[Overview](README.md) · [Work catalogue](plan.md) · [Metric definition](methodology.md).
All **52 runtime function nodes with CC > 20** are listed below, including nested
callbacks. `CC` is the defined AST decision count, not an observed execution-path
count. `Span` includes nested functions/comments; CC excludes nested bodies.

**Extract** refers to a verified responsibility proposal, **retain** to required
algorithm/policy branching, and **triage** to a conditional investigation (Q3).
A triage row is not evidence of a bug and books no reduction. Its stated boundary
must be demonstrated before an implementation PR. Lower-scoring functions and all
files are still included in the measurement artifacts.

| Source at baseline | Function | CC | Span | Disposition / bounded next step |
|---|---|---:|---:|---|
| `apps/api/src/auth/plugin.ts:133` | `app.addHook callback` | 21 | 80 | Extract A4a: identity/cookie orchestration; preserve hook order and every refusal. |
| `apps/api/src/config.ts:367` | `loadConfig` | 25 | 112 | Retain production refusals; triage normalization versus validation only on change (API hotspots). |
| `apps/api/src/modules/evaluation/writes.ts:220` | `patchEvaluation` | 34 | 86 | Extract A3: pure patch preparation; characterize partial/null/legacy-invalid combinations. |
| `apps/api/src/modules/live/dashboard.ts:180` | `items.map callback` | 22 | 36 | Retain nullish DTO fallbacks; optional named projector only if reused or clearer. |
| `apps/api/src/modules/project/webhooks.ts:122` | `workflowRun` | 21 | 34 | Triage pure CompletedRun parsing if reconciliation needs it; retain actor/time fail-closed checks. |
| `apps/api/src/modules/realtime/routes.ts:401` | `handler` | 21 | 136 | Extract A4b: one stream lifecycle owner; retain authorization and join/snapshot order. |
| `apps/web/src/AdminLlm.tsx:67` | `SettingsForm` | 21 | 151 | Retain explicit settings/refusal states; triage local form sections only on related change. |
| `apps/web/src/App.tsx:489` | `SessionApp` | 21 | 114 | Retain public/ordinary/confined-session entry ordering; W9 rejects generic shell consolidation. |
| `apps/web/src/ClassroomView.tsx:156` | `ClassroomView` | 26 | 272 | Triage staff/student composition; keep server-selected payload and role-specific query keys. |
| `apps/web/src/RosterTable.tsx:45` | `Row` | 25 | 298 | Triage row edit state versus display only on change; preserve claim/adoption/staff permissions. |
| `apps/web/src/activities/ActivitiesPage.tsx:89` | `ActivitiesPage` | 21 | 191 | Retain kind adapters; triage filter/layout composition only on related change. |
| `apps/web/src/attempt/playerReducer.ts:182` | `playerReducer` | 26 | 76 | Retain explicit transition reducer; never merge preview persistence or browser/server timing. |
| `apps/web/src/coach/CoachLayer.tsx:325` | `frame` | 24 | 69 | Triage positioning/visibility frame independently on change; no reduction claimed for timing branches. |
| `apps/web/src/commands.ts:112` | `buildCommands` | 21 | 226 | Retain typed command composition; no second registry. Share only keyboard protocol W10. |
| `apps/web/src/evaluation/AddQuestionsSheet.tsx:72` | `AddQuestionsSheet` | 35 | 317 | Triage search/selection state versus result rows; preserve ordered selection and template/live edit target. |
| `apps/web/src/evaluation/EvaluationConfig.tsx:86` | `EvaluationConfig` | 24 | 341 | Retain policy-driven field visibility; reuse editTarget/domain rules, not a generic form engine. |
| `apps/web/src/grading/AnswerPanel.tsx:237` | `EntryPanel` | 25 | 153 | Triage dialog/selection composition; existing grading data/actions/invalidation already have owners. |
| `apps/web/src/grading/GradingPanel.tsx:73` | `GradingPanel` | 32 | 312 | Triage dialog/selection composition; existing grading data/actions/invalidation already have owners. |
| `apps/web/src/grading/useGradingKeys.ts:48` | `onKey` | 23 | 44 | Retain input-aware keyboard dispatch; triage command handlers only when repeated behavior is proved. |
| `apps/web/src/journal/JournalReader.tsx:107` | `JournalReader` | 42 | 312 | Extract W6: staff action/dialog orchestration; retain role-isolated read/cache path. |
| `apps/web/src/live/GridRow.tsx:127` | `GridRow` | 28 | 276 | Retain cell/presence/action differences; duplicated callback prop types alone do not justify abstraction. |
| `apps/web/src/live/LiveDashboard.tsx:63` | `LiveDashboard` | 36 | 441 | Triage stream-derived state versus teacher controls/dialogs; no cached student/staff payload sharing. |
| `apps/web/src/pair/PairPage.tsx:47` | `Pairing` | 21 | 162 | Retain pairing protocol states and expiry; not interchangeable with ordinary login. |
| `apps/web/src/poll/PollBars.tsx:78` | `rows.map callback` | 25 | 101 | Triage answer/session state versus projection rendering; preserve independent vote and reveal policy. |
| `apps/web/src/poll/PollJoin.tsx:72` | `PollJoin` | 29 | 254 | Triage answer/session state versus projection rendering; preserve independent vote and reveal policy. |
| `apps/web/src/poll/PollLauncher.tsx:177` | `PollLauncher` | 21 | 237 | Triage answer/session state versus projection rendering; preserve independent vote and reveal policy. |
| `apps/web/src/poll/PollProjection.tsx:262` | `onKey` | 21 | 34 | Retain input-aware keyboard dispatch; triage command handlers only when repeated behavior is proved. |
| `apps/web/src/poll/ProjectionHeader.tsx:108` | `ProjectionHeader` | 24 | 191 | Triage answer/session state versus projection rendering; preserve independent vote and reveal policy. |
| `apps/web/src/pool/PoolView.tsx:190` | `PoolView` | 44 | 393 | Triage filter/query state versus action/dialog composition; do not merge pool and question resource operations. |
| `apps/web/src/project/NewProjectPage.tsx:72` | `NewProjectPage` | 28 | 294 | Triage source/branch selection steps; pending provisioning features are not dead UI logic. |
| `apps/web/src/results/ResultsView.tsx:63` | `ResultsView` | 25 | 234 | Triage filters/display versus release actions; grade policies stay domain/server-owned. |
| `apps/web/src/student/Player.tsx:239` | `PlayerView` | 40 | 252 | Triage render sections versus navigation derivation; existing usePlayerControls/reducer remain authoritative. |
| `apps/web/src/student/PlayerShell.tsx:79` | `PlayerShell` | 24 | 226 | W10 extracts shortcut only; retain banners, confinement and one player shell. |
| `packages/diagram/src/codecs/dot.ts:81` | `parseDot` | 29 | 62 | Retain grammar cases. PKG-07/Q3 only on grammar change; split recognizers without widening syntax. |
| `packages/diagram/src/codecs/mermaid.ts:147` | `text.split("\n").forEach callback` | 21 | 16 | Retain grammar cases. PKG-07/Q3 only on grammar change; split recognizers without widening syntax. |
| `packages/diagram/src/codecs/mermaid.ts:218` | `lines.forEach callback` | 29 | 34 | Retain grammar cases. PKG-07/Q3 only on grammar change; split recognizers without widening syntax. |
| `packages/diagram/src/codecs/plantuml.ts:143` | `lines.forEach callback` | 48 | 74 | Retain grammar cases. PKG-07/Q3 only on grammar change; split recognizers without widening syntax. |
| `packages/diagram/src/editor/DiagramEditor.tsx:93` | `DiagramEditor` | 43 | 459 | Extract PKG-01: diagram-local gesture transition boundary; one undo/save per gesture. |
| `packages/diagram/src/editor/DiagramEditor.tsx:221` | `onPointerDown` | 38 | 74 | Extract PKG-01: diagram-local gesture transition boundary; one undo/save per gesture. |
| `packages/diagram/src/editor/DiagramEditor.tsx:313` | `onPointerMove` | 21 | 46 | Extract PKG-01: diagram-local gesture transition boundary; one undo/save per gesture. |
| `packages/diagram/src/editor/DiagramEditor.tsx:360` | `onPointerUp` | 24 | 34 | Extract PKG-01: diagram-local gesture transition boundary; one undo/save per gesture. |
| `packages/diagram/src/editor/shapes.tsx:73` | `NodeShape` | 27 | 107 | Retain geometry/kind dispatch; share only Heap (PKG-02), not A* or shape rules. |
| `packages/diagram/src/editor/shapes.tsx:316` | `LinkShape` | 23 | 39 | Retain geometry/kind dispatch; share only Heap (PKG-02), not A* or shape rules. |
| `packages/diagram/src/geometry.ts:129` | `sizeOf` | 24 | 33 | Retain geometry/kind dispatch; share only Heap (PKG-02), not A* or shape rules. |
| `packages/diagram/src/layout.ts:107` | `anchors` | 27 | 64 | Retain geometry/kind dispatch; share only Heap (PKG-02), not A* or shape rules. |
| `packages/diagram/src/layout.ts:227` | `astar` | 37 | 59 | Retain geometry/kind dispatch; share only Heap (PKG-02), not A* or shape rules. |
| `packages/domain/src/parameters/evaluator.ts:236` | `walk` | 23 | 53 | Retain explicit deny-by-default AST validator; preserve resource/type/name limits. |
| `packages/qt-circuit/src/Player.tsx:155` | `CircuitPlayer` | 21 | 248 | Retain type-specific player/review states and privacy boundaries; existing shared program/engine is the seam. |
| `packages/qt-circuit/src/Review.tsx:138` | `CircuitReview` | 27 | 221 | Retain type-specific player/review states and privacy boundaries; existing shared program/engine is the seam. |
| `packages/qt-code/src/Player.tsx:159` | `CodePlayer` | 26 | 310 | Retain type-specific player/review states and privacy boundaries; existing shared program/engine is the seam. |
| `packages/qt-diagram/src/Review.tsx:46` | `DiagramReview` | 22 | 92 | Retain type-specific player/review states and privacy boundaries; existing shared program/engine is the seam. |
| `packages/qt-short/src/explain.ts:48` | `explainMatcher` | 22 | 62 | Retain exhaustive matcher explanation variants; no generic interpreter. |

## Dependency components

Five strongly connected components remain after removing type-only dependencies.
The full members are in [value-import-cycles.csv](metrics/value-import-cycles.csv).
A component is not the same as a pair of circular files; many paths can participate.

| Component | Files | Meaning | Disposition |
|---|---:|---|---|
| Org/pool/evaluation/guards/notifications | 15 | Read predicates load mutation-capable facades and their consumers | A1c/d; preserve public service entry convention |
| Live/grading/results | 13 | Regrade reads, write observation and service re-exports are interdependent | A1e coordinated with A2; preserve transaction/postcommit order |
| System/ticker | 6 | Health reads composition-root ticker state through task graph | A1b observation leaf |
| Database schemas | 5 | Foreign-key declarations refer across schemas through lazy callbacks | Retain; no eager initialization failure demonstrated |
| LLM gateway/service | 2 | Gateway imports ledger/settings from a facade that exports gateway | A1a private leaf |

No value-import file SCC was found in web or packages. Type-only cycles are not
reported as runtime defects. Area-level aggregation can manufacture cycles between
otherwise acyclic files; use actual file SCCs as the finding, not the area graph alone.
High fan-in of `contracts`, `domain`, query-key factories or registries is expected
for shared owners and is not itself a reason to duplicate or split them.
